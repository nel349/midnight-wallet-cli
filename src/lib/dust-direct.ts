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
import { collapseForeignGenerations } from './dust-collapse.ts';
import {
  INITIAL_NIGHT_DUST_RATIO,
  INITIAL_GENERATION_DECAY_RATE,
  INITIAL_DUST_GRACE_PERIOD_SECONDS,
} from './constants.ts';
import { subscribeGraphqlWs } from './graphql-ws-subscription.ts';

// Set to '1' to disable dust generation-tree collapse (debugging / safety valve).
const DUST_COLLAPSE_DISABLE_ENV = 'MN_DISABLE_DUST_COLLAPSE';

/**
 * Data the collapse needs to keep working correctly across restarts: which
 * generation-tree leaves are ours (must never be collapsed) and how far the
 * tree has grown. Persisted alongside the dust state and fed back on resume.
 */
export interface DustRetention {
  /** Generation-tree indices owned by this wallet. */
  ownedGenerationIndices: number[];
  /** Next-free generation index reached (exclusive upper bound). */
  generationFrontier: number;
}

// Initial dust parameters live in constants.ts (single source of truth).
// `ParamChange` events in the replay stream update these to the chain's current
// values before any UTXO events are applied, so the starting values only affect
// state-construction, not results.

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
  /** Retention data to persist with the state (for correct resume + collapse). */
  retention: DustRetention;
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
  onCheckpoint?: (state: ledger.DustLocalState, lastAppliedEventId: number, retention: DustRetention) => void;
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
  /** Retention data from a cached checkpoint, so resume keeps collapsing correctly. */
  initialRetention?: DustRetention;
  /** Collapse foreign generation ranges before checkpoint/return. Default: true. */
  collapse?: boolean;
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
    initialRetention,
    collapse,
  } = options;

  const collapseEnabled = collapse !== false && process.env[DUST_COLLAPSE_DISABLE_ENV] !== '1';

  // Apply events in chunks as they arrive so the final step is cheap and
  // progress updates stay responsive. Replaying 100k events in a single
  // synchronous WASM call blocks the event loop for tens of seconds.
  const CHUNK_SIZE = 500;

  let state = initialState ?? createInitialDustState();
  const pending: ledger.Event[] = [];

  // Retention tracking (owner-match): a generation leaf is ours iff its owner is
  // our dust public key. Accumulate the owned index set + frontier as events
  // arrive so we collapse only foreign ranges. Seeded from the cached checkpoint.
  const myPubkey = dustSecretKey.publicKey;
  const ownedGenIndices = new Set<bigint>((initialRetention?.ownedGenerationIndices ?? []).map(BigInt));
  let frontier = BigInt(initialRetention?.generationFrontier ?? 0);
  const trackRetention = (event: ledger.Event) => {
    const content = event.content as { tag?: string; generationIndex?: bigint; generation?: { owner?: bigint } };
    if (content?.tag !== 'dustInitialUtxo' || content.generationIndex === undefined) return;
    const idx = content.generationIndex;
    if (idx + 1n > frontier) frontier = idx + 1n;
    if (content.generation?.owner === myPubkey) ownedGenIndices.add(idx);
  };
  const currentRetention = (): DustRetention => ({
    ownedGenerationIndices: [...ownedGenIndices].map(Number),
    generationFrontier: Number(frontier),
  });

  let eventsAppliedCount = 0;
  let lastEventId = startFromId - 1;
  let maxIdSeen = -1;

  // Replay accumulated events in chunks so the final step is cheap and the event
  // loop can breathe between WASM calls; collapse foreign ranges and checkpoint
  // after each chunk so a timeout/abort doesn't lose the work. lastEventId is
  // updated before the flush so the checkpoint cursor matches the events applied.
  const flushPending = () => {
    if (pending.length === 0) return;
    state = state.replayEvents(dustSecretKey, pending);
    eventsAppliedCount += pending.length;
    pending.length = 0;
    if (collapseEnabled) {
      state = collapseForeignGenerations(state, ownedGenIndices, frontier).state;
    }
    if (onCheckpoint && lastEventId >= 0) {
      try { onCheckpoint(state, lastEventId, currentRetention()); } catch { /* best-effort */ }
    }
  };

  return subscribeGraphqlWs<DustDirectResult>(indexerWS, {
    query: SUBSCRIPTION_QUERY,
    variables: { id: startFromId },
    idleMs,
    timeoutMs,
    // Fast-return only when resuming from cached state; a fresh cold sync must
    // wait for its (possibly slow) first event.
    initialSilenceMs: initialState ? initialSilenceMs : 0,
    signal,
    onNext: (data) => {
      const evt = (data as { dustLedgerEvents?: RawDustEvent } | undefined)?.dustLedgerEvents;
      if (!evt) return false;
      let event: ledger.Event;
      try {
        event = ledger.Event.deserialize(Buffer.from(evt.raw, 'hex'));
      } catch (err) {
        throw new Error(`Failed to deserialize dust event ${evt.id}: ${(err as Error).message}`);
      }
      trackRetention(event); // read owner/index before replayEvents consumes it
      pending.push(event);
      lastEventId = evt.id;
      if (evt.maxId > maxIdSeen) maxIdSeen = evt.maxId;
      if (pending.length >= CHUNK_SIZE) {
        try { flushPending(); } catch (err) {
          throw new Error(`Failed applying dust events: ${(err as Error).message}`);
        }
      }
      onProgress?.(eventsAppliedCount + pending.length, maxIdSeen);
      // Caught up when we've received the final event in the current stream.
      return lastEventId >= maxIdSeen;
    },
    buildResult: (partial) => {
      try {
        flushPending();
        const now = new Date();
        state = state.processTtls(now);
        return {
          balance: state.walletBalance(now),
          availableCoins: state.utxos.length,
          eventCount: eventsAppliedCount,
          ownedUtxoCount: state.utxos.length,
          syncTime: state.syncTime,
          state,
          retention: currentRetention(),
          lastAppliedEventId: lastEventId,
          partial,
        };
      } catch (err) {
        throw new Error(`Failed to build dust state: ${(err as Error).message}`);
      }
    },
  });
}
