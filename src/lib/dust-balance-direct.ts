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

import * as ledger from '@midnight-ntwrk/ledger-v8';
import { DustAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';

import {
  INITIAL_NIGHT_DUST_RATIO,
  INITIAL_GENERATION_DECAY_RATE,
  INITIAL_DUST_GRACE_PERIOD_SECONDS,
} from './constants.ts';
import { subscribeGraphqlWs } from './graphql-ws-subscription.ts';

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

  // generation index -> its latest generation record and dtime (ms), if any.
  const generations = new Map<number, RawGeneration>();
  const dtimes = new Map<number, number>();

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

  return subscribeGraphqlWs<DustBalanceFastResult>(indexerWS, {
    query: SUBSCRIPTION_QUERY,
    variables: { a: dustAddress, s: 0, e: endIndex },
    idleMs,
    timeoutMs,
    // Snapshot read: the stream delivers our (few) generations then goes quiet,
    // so finish on idle even before a first item (an empty wallet has none).
    idleBeforeFirstEvent: true,
    signal,
    onNext: (data) => {
      const p = (data as { dustGenerations?: { __typename?: string; generationMtIndex?: unknown; newDtime?: unknown } } | undefined)?.dustGenerations;
      if (!p) return false;
      if (p.__typename === 'DustGenerationsItem') {
        generations.set(Number(p.generationMtIndex), p as unknown as RawGeneration);
      } else if (p.__typename === 'DustGenerationDtimeUpdateItem') {
        dtimes.set(Number(p.generationMtIndex), Number(p.newDtime));
      }
      // DustGenerationsProgress carries only tree/index bookkeeping; idle ends the read.
      return false; // no tip concept — idle/timeout terminate the snapshot read
    },
    buildResult: (partial) => {
      try {
        const { balance, active } = computeBalance();
        return { balance, generationCount: generations.size, activeGenerations: active, partial };
      } catch (err) {
        throw new Error(`Failed to compute dust balance: ${(err as Error).message}`);
      }
    },
  });
}
