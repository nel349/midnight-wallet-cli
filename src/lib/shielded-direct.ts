// Direct-from-indexer shielded (zswap) balance reader.
//
// Bypasses the shielded-wallet SDK facade (minutes-to-hours + 16GB OOM on cold
// hosted syncs). Subscribes to `zswapLedgerEvents(id)` ourselves, deserializes
// each raw hex event via `ledger.Event.deserialize`, and replays them into a
// `ZswapLocalState` with `replayEventsWithChanges(secretKeys, events)` — which
// reconciles BOTH received and spent coins locally using the full secret keys
// (the collapsed `connect`/`shieldedTransactions` session is encryption-only and
// cannot see spends, so it is not used). Reads the NIGHT balance off the coin
// set. Mirrors the dust-direct reader's checkpoint/resume shape.
//
// The batched replay keeps the working set bounded (~155MB even on preview),
// unlike the SDK's cold sync.

import WebSocket from 'ws';
import * as ledger from '@midnight-ntwrk/ledger-v8';

const SUBSCRIPTION_QUERY = `
  subscription ZswapLedgerEvents($id: Int) {
    zswapLedgerEvents(id: $id) {
      id
      raw
      maxId
    }
  }
`;

interface RawZswapEvent {
  id: number;
  raw: string;
  maxId: number;
}

export interface ShieldedDirectResult {
  /** Native (NIGHT) shielded balance in atomic units. */
  balance: bigint;
  /** Number of spendable NIGHT coins tracked. */
  availableCoins: number;
  /** Events applied in this run. */
  eventCount: number;
  /** Final ZswapLocalState — callers serialize this for caching. */
  state: ledger.ZswapLocalState;
  /** Id of the last event applied in this run. -1 if none arrived. */
  lastAppliedEventId: number;
  /**
   * True iff the sync stopped before catching up to the indexer's tip (timeout
   * or abort). The returned state + lastAppliedEventId are still valid — persist
   * them and re-call to resume from the checkpoint. False means we caught up to
   * the chain head (or there were no events to apply).
   */
  partial: boolean;
}

export interface ShieldedDirectOptions {
  /** Called with (eventsApplied, maxIdSeen) whenever a new event arrives. */
  onProgress?: (eventsApplied: number, maxIdSeen: number) => void;
  /**
   * Called after every chunk of events is applied, with the current state + last
   * applied event id. Lets the caller persist a checkpoint so a Ctrl+C / timeout
   * doesn't lose 50k events of work. Keep the callback cheap (a file write is
   * fine, network is not).
   */
  onCheckpoint?: (state: ledger.ZswapLocalState, lastAppliedEventId: number) => void;
  /**
   * Soft ceiling for the whole subscription. On expiry the call resolves with
   * `partial: true` and whatever state has been applied — never throws away
   * progress. Default: 600s.
   */
  timeoutMs?: number;
  /** If no event arrives for this long (and we've received some), treat as caught up. Default: 5s. */
  idleMs?: number;
  /**
   * If no event is received AT ALL within this window after connecting, treat the
   * stream as empty (nothing to catch up on) and return — but only when resuming
   * from a cached state. Default: 3s.
   */
  initialSilenceMs?: number;
  /** Abort the subscription mid-flight. */
  signal?: AbortSignal;
  /** Resume from this cached state instead of building fresh. */
  initialState?: ledger.ZswapLocalState;
  /** Subscribe starting at this event id (inclusive). Default: 0. */
  startFromId?: number;
}

/** Sum spendable native-token (NIGHT) coins in a state. */
function nativeBalance(state: ledger.ZswapLocalState): { balance: bigint; count: number } {
  // Shielded NIGHT coins carry the unshielded raw token type (matches balance.ts / facade).
  const night = ledger.unshieldedToken().raw;
  let balance = 0n;
  let count = 0;
  for (const coin of state.coins) {
    if (coin.type === night) {
      balance += coin.value;
      count++;
    }
  }
  return { balance, count };
}

/**
 * Subscribe to zswap ledger events from `startFromId`, deserialize, replay into a
 * `ZswapLocalState` with the full secret keys (reconciling receives AND spends),
 * and return the NIGHT balance plus the state + resume cursor.
 *
 * "Caught up" is detected when the latest `id` received equals `maxId`.
 */
export function readShieldedBalanceDirect(
  secretKeys: ledger.ZswapSecretKeys,
  indexerWS: string,
  options: ShieldedDirectOptions = {},
): Promise<ShieldedDirectResult> {
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

  // Apply events in chunks so the final step is cheap, the event loop can breathe
  // between WASM calls, and the working set stays bounded on large chains.
  const CHUNK_SIZE = 500;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(indexerWS, ['graphql-transport-ws']);
    let state = initialState ?? new ledger.ZswapLocalState();
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
      state = state.replayEventsWithChanges(secretKeys, pending).state;
      eventsAppliedCount += pending.length;
      pending.length = 0;
      // Checkpoint after each chunk so a timeout / abort / crash doesn't lose the
      // work. lastEventId is updated before flush, so the checkpoint's cursor
      // matches the events actually applied.
      if (onCheckpoint && lastEventId >= 0) {
        try { onCheckpoint(state, lastEventId); } catch { /* best-effort */ }
      }
    };

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
        const { balance, count } = nativeBalance(state);
        resolve({
          balance,
          availableCoins: count,
          eventCount: eventsAppliedCount,
          state,
          lastAppliedEventId: lastEventId,
          partial,
        });
      } catch (err) {
        reject(new Error(`Failed to build shielded state: ${(err as Error).message}`));
      }
    };

    const finishErr = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    // Abort rejects — the user pressed Ctrl+C. The periodic onCheckpoint means at
    // most one chunk (~500 events) of work is lost; the next call resumes.
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
          payload: { query: SUBSCRIPTION_QUERY, variables: { id: startFromId } },
        }));
        // If resuming from a cached state and NO event arrives within the silence
        // window, the stream is empty (nothing new) → return cached data fast.
        // Fresh runs must wait — a cold subscription can be slow to first event.
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

      const evt = msg.payload?.data?.zswapLedgerEvents as RawZswapEvent | undefined;
      if (!evt) return;
      sawFirstEvent = true;
      if (initialSilenceTimerId) { clearTimeout(initialSilenceTimerId); initialSilenceTimerId = undefined; }

      try {
        const event = ledger.Event.deserialize(new Uint8Array(Buffer.from(evt.raw, 'hex')));
        pending.push(event);
      } catch (err) {
        finishErr(new Error(`Failed to deserialize zswap event ${evt.id}: ${(err as Error).message}`));
        return;
      }

      // Update lastEventId BEFORE flushPending so the checkpoint cursor matches
      // the events actually applied (resuming at cursor+1 must not re-apply).
      lastEventId = evt.id;
      if (evt.maxId > maxIdSeen) maxIdSeen = evt.maxId;

      if (pending.length >= CHUNK_SIZE) {
        try {
          flushPending();
        } catch (err) {
          finishErr(new Error(`Failed applying zswap events: ${(err as Error).message}`));
          return;
        }
      }
      onProgress?.(eventsAppliedCount + pending.length, maxIdSeen);
      resetIdleTimer();

      // Caught up when we've received the final event in the current stream.
      if (lastEventId >= maxIdSeen) {
        finishOk();
      }
    });

    ws.on('error', (err: Error) => finishErr(new Error(`WebSocket error: ${err.message}`)));

    ws.on('close', () => {
      if (settled) return;
      // Some indexers close immediately when there are zero events → empty stream.
      if (!sawFirstEvent) {
        finishOk();
      } else {
        finishErr(new Error('Indexer closed connection before shielded sync completed'));
      }
    });

    timeoutId = setTimeout(() => {
      // Don't throw away progress — resolve partial so the caller persists the
      // checkpoint and resumes from lastAppliedEventId next call.
      finishOk(true);
    }, timeoutMs);
  });
}
