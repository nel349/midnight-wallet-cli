// Direct-from-indexer dust balance reader.
//
// Bypasses the dust-wallet SDK's sync machinery (which hangs on preprod due to
// an `isConnected` predicate that never flips for idle wallets). Subscribes to
// `dustLedgerEvents(id: 0)` ourselves, deserializes each raw hex event via
// `ledger.Event.deserialize`, replays them into a fresh `DustLocalState`, then
// reads `walletBalance(now)`.
//
// The SDK's dust wallet does the same thing internally — we just don't wait on
// the cosmetic `isConnected` flag.

import WebSocket from 'ws';
import * as ledger from '@midnight-ntwrk/ledger-v8';

// Well-known initial dust parameters. `ParamChange` events in the replay stream
// will update these to the chain's current values before any UTXO events are
// applied, so the starting values only affect state-construction, not results.
// Matches the SDK test constants (NIGHT_DUST_RATIO etc in midnight-ledger).
const INITIAL_NIGHT_DUST_RATIO = 5_000_000_000n;
const INITIAL_GENERATION_DECAY_RATE = 8_267n;
const INITIAL_DUST_GRACE_PERIOD_SECONDS = 3n * 60n * 60n;

const SUBSCRIPTION_QUERY = `
  subscription DustLedgerEvents($id: Int) {
    dustLedgerEvents(id: $id) {
      type: __typename
      id
      raw
      maxId
    }
  }
`;

interface RawDustEvent {
  type: string;
  id: number;
  raw: string;
  maxId: number;
}

export interface DustDirectResult {
  balance: bigint;
  availableCoins: number;
  eventCount: number;
  ownedUtxoCount: number;
  syncTime: Date;
  /** Final DustLocalState — callers can serialize this for caching. */
  state: ledger.DustLocalState;
  /** Id of the last event applied in this run. -1 if none arrived. */
  lastAppliedEventId: number;
  /**
   * True iff the sync stopped before catching up to the indexer's tip
   * (timeout or abort). The returned state + lastAppliedEventId are still
   * valid — the caller should persist them and re-call to resume from the
   * checkpoint. False means we caught up to the chain head (or there were
   * no events to apply).
   */
  partial: boolean;
}

export interface DustDirectOptions {
  /** Called with (eventsApplied, maxIdSeen) whenever a new event arrives. */
  onProgress?: (eventsApplied: number, maxIdSeen: number) => void;
  /**
   * Called after every chunk of events is applied to the local state, with
   * the current state + last applied event id. Lets the caller persist a
   * checkpoint so a Ctrl+C / timeout doesn't lose 100k events of work.
   * Note: invoked synchronously after `replayEvents`; keep the callback
   * cheap (file write is fine, network is not).
   */
  onCheckpoint?: (state: ledger.DustLocalState, lastAppliedEventId: number) => void;
  /**
   * Soft ceiling for the whole subscription. On expiry the call resolves
   * with `partial: true` and whatever state has been applied so far —
   * never throws away progress. Default: 600s. Set very high to disable.
   */
  timeoutMs?: number;
  /** If no event arrives for this long (and we've received some), treat as caught up. Default: 5s. */
  idleMs?: number;
  /**
   * If no event is received AT ALL within this window after connecting, treat
   * the stream as empty (nothing to catch up on) and return. This lets a
   * cached-resume with zero new events finish quickly instead of waiting on
   * `timeoutMs`. Default: 3s.
   */
  initialSilenceMs?: number;
  /** Abort the subscription mid-flight. */
  signal?: AbortSignal;
  /** Resume from this cached state instead of building fresh. */
  initialState?: ledger.DustLocalState;
  /** Subscribe starting at this event id (inclusive). Default: 0. */
  startFromId?: number;
}

function createInitialDustState(): ledger.DustLocalState {
  const params = new ledger.DustParameters(
    INITIAL_NIGHT_DUST_RATIO,
    INITIAL_GENERATION_DECAY_RATE,
    INITIAL_DUST_GRACE_PERIOD_SECONDS,
  );
  return new ledger.DustLocalState(params);
}

/**
 * Subscribe to all dust ledger events from the beginning of chain, deserialize,
 * replay into a fresh local state using the given dust secret key, and return
 * the resulting balance plus diagnostics.
 *
 * "Caught up" is detected when the latest `id` received equals `maxId`.
 */
export function readDustBalanceDirect(
  dustSecretKey: ledger.DustSecretKey,
  indexerWS: string,
  options: DustDirectOptions = {},
): Promise<DustDirectResult> {
  const {
    onProgress,
    onCheckpoint,
    timeoutMs = 600_000,
    idleMs = 5_000,
    initialSilenceMs = 3_000,
    signal,
    initialState,
    startFromId = 0,
  } = options;

  // Apply events in chunks as they arrive so the final step is cheap and
  // progress updates stay responsive. Replaying 100k events in a single
  // synchronous WASM call blocks the event loop for tens of seconds.
  const CHUNK_SIZE = 500;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(indexerWS, ['graphql-transport-ws']);
    let state = initialState ?? createInitialDustState();
    const pending: ledger.Event[] = [];
    let eventsAppliedCount = 0;
    let lastEventId = startFromId - 1;
    let maxIdSeen = -1;
    let sawFirstEvent = false;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    let idleTimerId: ReturnType<typeof setTimeout> | undefined;
    let initialSilenceTimerId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (idleTimerId) clearTimeout(idleTimerId);
      if (initialSilenceTimerId) clearTimeout(initialSilenceTimerId);
      try { ws.close(); } catch { /* best-effort */ }
      signal?.removeEventListener('abort', onAbort);
    };

    const flushPending = () => {
      if (pending.length === 0) return;
      state = state.replayEvents(dustSecretKey, pending);
      eventsAppliedCount += pending.length;
      pending.length = 0;
      // Checkpoint after each chunk so a timeout / abort / crash doesn't
      // lose the work. Caller decides cost (typically a small JSON write).
      if (onCheckpoint && lastEventId >= 0) {
        try { onCheckpoint(state, lastEventId); } catch { /* best-effort */ }
      }
    };

    // Reset the idle timer on every event. If `idleMs` elapses with no new
    // event AFTER we've received at least one, we treat the stream as caught
    // up (the indexer stopped delivering, chain tail reached or backpressure).
    const resetIdleTimer = () => {
      if (idleTimerId) clearTimeout(idleTimerId);
      idleTimerId = setTimeout(() => {
        if (sawFirstEvent && !settled) finishOk();
      }, idleMs);
    };

    const finishOk = (partial = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        flushPending();
        const now = new Date();
        state = state.processTtls(now);
        resolve({
          balance: state.walletBalance(now),
          availableCoins: state.utxos.length,
          eventCount: eventsAppliedCount,
          ownedUtxoCount: state.utxos.length,
          syncTime: state.syncTime,
          state,
          lastAppliedEventId: lastEventId,
          partial,
        });
      } catch (err) {
        reject(new Error(`Failed to build dust state: ${(err as Error).message}`));
      }
    };

    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    // Abort still rejects — the user pressed Ctrl+C and the caller (which
    // may be orchestrating multiple steps) needs to know to stop. The
    // periodic onCheckpoint inside flushPending means at most one chunk
    // (~500 events) of work is lost; the next call resumes from the last
    // saved checkpoint.
    const onAbort = () => finishErr(new Error('Operation cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'connection_init' }));
    });

    ws.on('message', (data: WebSocket.Data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'connection_ack') {
        ws.send(JSON.stringify({
          id: '1',
          type: 'subscribe',
          payload: {
            query: SUBSCRIPTION_QUERY,
            variables: { id: startFromId },
          },
        }));
        // After subscribing, arm the initial-silence timer IF we have a cached
        // state to fall back on. If NO event arrives within `initialSilenceMs`,
        // the stream is empty (nothing new to apply) and we return cached data.
        // For fresh runs (no cached state), we must wait for events — a cold
        // preprod subscription can take several seconds before the first
        // event arrives.
        if (initialState) {
          initialSilenceTimerId = setTimeout(() => {
            if (!sawFirstEvent && !settled) finishOk();
          }, initialSilenceMs);
        }
        return;
      }

      if (msg.type === 'error') {
        finishErr(new Error(`GraphQL subscription error: ${JSON.stringify(msg.payload)}`));
        return;
      }

      if (msg.type !== 'next') return;

      if (msg.payload?.errors) {
        finishErr(new Error(`GraphQL error: ${msg.payload.errors[0]?.message || 'unknown'}`));
        return;
      }

      const evt = msg.payload?.data?.dustLedgerEvents as RawDustEvent | undefined;
      if (!evt) return;
      sawFirstEvent = true;
      if (initialSilenceTimerId) { clearTimeout(initialSilenceTimerId); initialSilenceTimerId = undefined; }

      try {
        const bytes = Buffer.from(evt.raw, 'hex');
        pending.push(ledger.Event.deserialize(bytes));
      } catch (err) {
        finishErr(new Error(`Failed to deserialize dust event ${evt.id}: ${(err as Error).message}`));
        return;
      }

      // Flush to the state in chunks so the final step is cheap and the
      // event loop can breathe between WASM calls.
      if (pending.length >= CHUNK_SIZE) {
        try {
          flushPending();
        } catch (err) {
          finishErr(new Error(`Failed applying dust events: ${(err as Error).message}`));
          return;
        }
      }

      lastEventId = evt.id;
      if (evt.maxId > maxIdSeen) maxIdSeen = evt.maxId;
      onProgress?.(eventsAppliedCount + pending.length, maxIdSeen);
      resetIdleTimer();

      // Caught up when we've received the final event in the current stream.
      // (maxId can grow during replay if new events land on-chain; the idle
      // timer catches the case where the stream stalls short of maxId.)
      if (lastEventId >= maxIdSeen) {
        finishOk();
      }
    });

    ws.on('error', (err: Error) => finishErr(new Error(`WebSocket error: ${err.message}`)));

    ws.on('close', () => {
      if (settled) return;
      // Some indexers close immediately when there are zero dust events.
      // Treat a clean close with no events as "empty stream" → zero balance.
      if (!sawFirstEvent) {
        finishOk();
      } else {
        finishErr(new Error('Indexer closed connection before dust sync completed'));
      }
    });

    timeoutId = setTimeout(() => {
      // Don't throw away progress. Resolve with `partial: true` so the caller
      // persists the checkpoint and can resume from `lastAppliedEventId` next
      // call. Pre-existing behavior was reject — that lost 100k+ events of
      // work on cold preprod syncs.
      finishOk(true);
    }, timeoutMs);
  });
}
