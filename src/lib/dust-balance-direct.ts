// Fast dust BALANCE reader — seconds instead of the ~22-min cold event replay.
//
// The dust balance is a pure function of the wallet's own dust generations and
// time: `sum over generations of updatedValue(ctime, initialValue, genInfo, now,
// params)`. The indexer's `dustGenerations(dustAddress, ...)` subscription streams
// exactly those generations (filtered to us, ~1 item vs 1.44M ledger events), so
// we can compute the balance directly without replaying the dust event history or
// building a `DustLocalState` at all.
//
// This is a READ path only. Spending dust (transfers) still needs the full
// `DustLocalState` (commitment tree + spend proofs) via the event-replay + cache.
//
// Params note: dust params are protocol constants replayed from `ParamChange`
// events, which this path skips. They are stable (verified equal to the initial
// values on preprod). Callers may pass current params if they have them; otherwise
// the initial constants are used. A `ParamChange` on-chain would require a full
// sync to pick up — acceptable for a fast balance read.

import WebSocket from 'ws';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { DustAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';

// Initial dust parameters (match dust-direct's starting state). NIGHT:dust ratio,
// generation decay rate, and the grace period in seconds.
const INITIAL_NIGHT_DUST_RATIO = 5_000_000_000n;
const INITIAL_GENERATION_DECAY_RATE = 8_267n;
const INITIAL_DUST_GRACE_PERIOD_SECONDS = 10_800n; // 3h

const SUBSCRIPTION_QUERY = `
  subscription DustGenerations($a: DustAddress!, $s: Int!, $e: Int!) {
    dustGenerations(dustAddress: $a, startIndex: $s, endIndex: $e) {
      __typename
      ... on DustGenerationsItem { generationMtIndex owner value initialValue backingNight ctime }
      ... on DustGenerationDtimeUpdateItem { generationMtIndex newDtime }
      ... on DustGenerationsProgress { highestIndex }
    }
  }
`;

export interface DustBalanceFastResult {
  /** Dust balance in atomic units. */
  balance: bigint;
  /** Number of generations seen for this wallet. */
  generationCount: number;
  /** Generations currently contributing > 0 to the balance. */
  activeGenerations: number;
  /** True if we stopped before the stream signalled catch-up (timeout/abort). */
  partial: boolean;
}

export interface DustBalanceFastOptions {
  /** Current on-chain dust params. Defaults to the initial constants (stable on preprod). */
  params?: ledger.DustParameters;
  /** Valuation time for accrual. Defaults to now. */
  now?: Date;
  /** Generation-tree upper bound. Default 2^25 (well past any current tip); idle detection ends the read. */
  endIndex?: number;
  /** Finish after this much silence once subscribed. Default 4s. */
  idleMs?: number;
  /** Hard ceiling; on expiry resolve `partial: true`. Default 60s. */
  timeoutMs?: number;
  /** Abort mid-flight. */
  signal?: AbortSignal;
}

interface RawGeneration {
  generationMtIndex: number;
  owner: string;
  value: string;
  initialValue: string;
  backingNight: string;
  ctime: number;
}

/**
 * Read the wallet's dust balance directly from the `dustGenerations` subscription,
 * summing `updatedValue` over its generations. Resolves in seconds.
 */
export function readDustBalanceFast(
  dustSecretKey: ledger.DustSecretKey,
  indexerWS: string,
  networkId: NetworkId.NetworkId,
  options: DustBalanceFastOptions = {},
): Promise<DustBalanceFastResult> {
  const {
    params = new ledger.DustParameters(
      INITIAL_NIGHT_DUST_RATIO,
      INITIAL_GENERATION_DECAY_RATE,
      INITIAL_DUST_GRACE_PERIOD_SECONDS,
    ),
    now = new Date(),
    endIndex = 1 << 25,
    idleMs = 4_000,
    timeoutMs = 60_000,
    signal,
  } = options;

  const owner = dustSecretKey.publicKey;
  const dustAddress = DustAddress.encodePublicKey(networkId, dustSecretKey.publicKey);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(indexerWS, ['graphql-transport-ws']);
    // generation index -> its latest generation record and dtime (ms), if any.
    const generations = new Map<number, RawGeneration>();
    const dtimes = new Map<number, number>();
    let subscribed = false;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    let idleTimerId: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      clearTimeout(timeoutId);
      if (idleTimerId) clearTimeout(idleTimerId);
      try { ws.close(); } catch { /* best-effort */ }
      signal?.removeEventListener('abort', onAbort);
    };

    const computeBalance = (): { balance: bigint; active: number } => {
      let balance = 0n;
      let active = 0;
      for (const [index, gen] of generations) {
        const dt = dtimes.get(index);
        const genInfo = {
          value: BigInt(gen.value),
          owner,
          nonce: gen.backingNight,
          dtime: dt !== undefined ? new Date(dt) : undefined,
        } as ledger.DustGenerationInfo;
        const v = ledger.updatedValue(new Date(gen.ctime * 1000), BigInt(gen.initialValue), genInfo, now, params);
        if (v > 0n) active++;
        balance += v;
      }
      return { balance, active };
    };

    const finish = (partial = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const { balance, active } = computeBalance();
        resolve({ balance, generationCount: generations.size, activeGenerations: active, partial });
      } catch (err) {
        reject(new Error(`Failed to compute dust balance: ${(err as Error).message}`));
      }
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => fail(new Error('Operation cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });

    // Once subscribed, the stream delivers our (few) generations then goes quiet;
    // finish after `idleMs` of silence.
    const armIdle = () => {
      if (idleTimerId) clearTimeout(idleTimerId);
      idleTimerId = setTimeout(() => { if (subscribed && !settled) finish(); }, idleMs);
    };

    ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));

    ws.on('message', (data: WebSocket.Data) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'connection_ack') {
        ws.send(JSON.stringify({
          id: '1',
          type: 'subscribe',
          payload: { query: SUBSCRIPTION_QUERY, variables: { a: dustAddress, s: 0, e: endIndex } },
        }));
        subscribed = true;
        armIdle();
        return;
      }
      if (msg.type === 'error') { fail(new Error(`GraphQL subscription error: ${JSON.stringify(msg.payload)?.slice(0, 200)}`)); return; }
      if (msg.type !== 'next') return;
      if (msg.payload?.errors) { fail(new Error(`GraphQL error: ${msg.payload.errors[0]?.message || 'unknown'}`)); return; }

      const p = msg.payload?.data?.dustGenerations;
      if (!p) return;
      if (p.__typename === 'DustGenerationsItem') {
        generations.set(Number(p.generationMtIndex), p as RawGeneration);
      } else if (p.__typename === 'DustGenerationDtimeUpdateItem') {
        dtimes.set(Number(p.generationMtIndex), Number(p.newDtime));
      }
      // DustGenerationsProgress carries only tree/index bookkeeping we don't need
      // for the balance; idle detection ends the read.
      armIdle();
    });

    ws.on('error', (err: Error) => fail(new Error(`WebSocket error: ${err.message}`)));
    ws.on('close', () => { if (!settled) finish(); });

    timeoutId = setTimeout(() => finish(true), timeoutMs);
  });
}
