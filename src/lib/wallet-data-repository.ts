// Wallet data repository — single owner of cache + tip-aware invalidation.
//
// What this hides from callers:
//   • In-memory layer (per-process; matters for the long-lived MCP server)
//   • On-disk layer (shared across `mn` shell invocations)
//   • Tip-aware invalidation (cache valid iff chain tip unchanged)
//   • Force-fresh override
//   • Chain-id (genesis hash) validation on chain reset
//   • Auto-invalidation of dependent reads after a write
//
// Four constructor seams (`now`, `fetchTip`, `fetchUnshielded`, `fetchDust`)
// make the cache + tip + invalidation logic unit-testable without spinning up
// the SDK, Docker, or the indexer. Production defaults wire to the existing
// `chain_getBlockHash` / `checkBalance` / `readDustBalanceDirect` paths.
//
// `withFacade` deliberately leaks the SDK's `FacadeBundle` so callers can
// build/sign/submit transactions. Tests of the write path remain integration
// tests against localnet — accepted scope per architecture-deepening.md.

import { Buffer } from 'node:buffer';
import * as ledger from '@midnight-ntwrk/ledger-v8';

import type { NetworkConfig, NetworkName } from './network.ts';
import { isValidNetworkName } from './network.ts';
import { type FacadeState } from '@midnight-ntwrk/wallet-sdk-facade';
import {
  buildFacade,
  startAndSyncFacade,
  stopFacade,
  type FacadeBundle,
  type SyncMode,
} from './facade.ts';
import {
  loadDustCache,
  saveDustCache,
  dustPublicKeyHexFromSeed,
  validateDustCacheChainId,
  clearDustDirectCache,
} from './dust-direct-cache.ts';
import {
  loadWalletCache,
  saveWalletCache,
  clearWalletCache,
  validateWalletCacheChainId,
} from './wallet-cache.ts';
import { checkBalance, type BalanceSummary } from './balance-subscription.ts';
import { readDustBalanceDirect, type DustDirectResult } from './dust-direct.ts';
import { callNodeRpc } from './node-rpc.ts';
import { deriveDustSeed } from './derivation.ts';
import { deriveUnshieldedAddress } from './derive-address.ts';

// ── Public types ──────────────────────────────────────────

export interface DustView {
  state: ledger.DustLocalState;
  balance: bigint;
  availableCoins: number;
  ownedUtxoCount: number;
  syncTime: Date;
  /**
   * True iff any cache layer participated — either an in-memory memo hit, OR a
   * disk-cache resume (delta sync from a previous checkpoint). False only for
   * a true cold scan from event 0.
   */
  fromCache: boolean;
  /** Number of events applied by this call (0 on memo hits; delta count on disk-resume; full count on cold). */
  eventsApplied: number;
  /** Wall-clock millis when this value was last refreshed from the network. */
  fetchedAt: number;
}

export interface UnshieldedView extends BalanceSummary {
  fromCache: boolean;
  fetchedAt: number;
}

/** What the caller borrows during withFacade. SDK type leak is intentional. */
export interface FacadeLease {
  bundle: FacadeBundle;
  state: FacadeState;
}

export interface InvalidationScope {
  network: NetworkConfig;
  /** If set, scope invalidations to this seed's derived caches. */
  seed?: Buffer;
  /** If set, scope unshielded invalidation to this address. */
  address?: string;
  /** Which kinds to invalidate. Default: all. */
  kinds?: ReadonlyArray<'dust' | 'unshielded' | 'facade'>;
}

export interface ReadOptions {
  /** Bypass every cache layer and re-fetch from network. */
  forceFresh?: boolean;
  signal?: AbortSignal;
  /** Status hook for spinner wiring. */
  onStatus?: (s: string) => void;
}

export interface FacadeOptions extends ReadOptions {
  syncMode?: SyncMode;
  requireStrictSync?: boolean;
  /** If true, skip the post-resolve invalidation (read-only borrowers). */
  readOnly?: boolean;
}

export type TipFingerprint = string;

export interface RepoDeps {
  /** Wall-clock source. Default: Date.now. */
  now?: () => number;
  /** Tip fetcher. Default: substrate `chain_getBlockHash`. */
  fetchTip?: (network: NetworkConfig, signal?: AbortSignal) => Promise<TipFingerprint>;
  /** Unshielded balance fetcher. Default: existing `checkBalance` over indexer WS. */
  fetchUnshielded?: (
    address: string,
    network: NetworkConfig,
    onProgress?: (current: number, highest: number) => void,
  ) => Promise<BalanceSummary>;
  /** Dust state fetcher. Default: existing `readDustBalanceDirect` over indexer WS. */
  fetchDust?: (
    seed: Buffer,
    network: NetworkConfig,
    opts: {
      startFromId: number;
      initialState?: ledger.DustLocalState;
      signal?: AbortSignal;
      onProgress?: (applied: number, max: number) => void;
      /** Repo passes a callback to persist incremental progress during long syncs. */
      onCheckpoint?: (state: ledger.DustLocalState, lastAppliedEventId: number) => void;
    },
  ) => Promise<DustDirectResult>;
  /** Override cache directory (tests use a tmp dir). */
  cacheDir?: string;
}

// ── Implementation ────────────────────────────────────────

interface MemoEntry<T> {
  value: T;
  fetchedAt: number;
  tipAtFetch: TipFingerprint;
}

/** Re-fetching the chain tip on every cache check is overkill; memo it briefly. */
const TIP_PROBE_TTL_MS = 5_000;

/**
 * Max iterations of the partial-resume loop in `dust()`. Each iteration covers
 * one full `timeoutMs` window of the underlying fetcher (default 600s). With
 * 6 iterations and the default timeout, total wall-time ceiling is ~60min —
 * enough to fully cold-sync any preprod wallet from event 0 even at a slow
 * indexer. A misbehaving indexer that streams events forever still terminates.
 */
const DUST_PARTIAL_RETRIES = 6;

export class WalletDataRepository {
  private readonly now: () => number;
  private readonly fetchTip: NonNullable<RepoDeps['fetchTip']>;
  private readonly fetchUnshielded: NonNullable<RepoDeps['fetchUnshielded']>;
  private readonly fetchDust: NonNullable<RepoDeps['fetchDust']>;
  private readonly cacheDir: string | undefined;

  private readonly dustMemo = new Map<string, MemoEntry<DustView>>();
  private readonly unshieldedMemo = new Map<string, MemoEntry<UnshieldedView>>();
  private readonly tipMemo = new Map<string, { tip: TipFingerprint; fetchedAt: number }>();

  constructor(deps: RepoDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.fetchTip = deps.fetchTip ?? defaultTipFetcher;
    this.fetchUnshielded = deps.fetchUnshielded ?? defaultUnshieldedFetcher;
    this.fetchDust = deps.fetchDust ?? defaultDustFetcher;
    this.cacheDir = deps.cacheDir;
  }

  // ── Reads ─────────────────────────────────────────

  async dust(seed: Buffer, network: NetworkConfig, opts: ReadOptions = {}): Promise<DustView> {
    const networkName = networkNameOf(network);
    const pubkeyHex = dustPublicKeyHexFromSeed(seed);
    const memoKey = `${networkName}:${pubkeyHex}`;

    if (!opts.forceFresh) {
      const hit = await this.tryMemo(memoKey, network, this.dustMemo, opts.signal);
      if (hit) return { ...hit, fromCache: true, eventsApplied: 0 };
    }

    // Validate disk cache against chain genesis hash (cheap once memoised).
    await validateDustCacheChainId(networkName, pubkeyHex, network.node);

    let cached = opts.forceFresh ? null : loadDustCache(networkName, pubkeyHex, this.cacheDir);
    const startedFromCache = cached !== null;
    let totalEventsApplied = 0;
    let result: DustDirectResult;

    // Auto-retry on `partial: true`. Cold preprod has ~250k dust events;
    // the underlying fetcher resolves with `partial` after its soft timeout
    // (default 600s) instead of throwing. Each call's `onCheckpoint` saves
    // intermediate state to disk, so retries resume from where we left off
    // and never re-process events. Bounded so a broken indexer doesn't
    // loop forever.
    for (let attempt = 0; attempt < DUST_PARTIAL_RETRIES; attempt++) {
      if (opts.signal?.aborted) throw new Error('Operation cancelled');
      const startFromId = cached ? cached.lastAppliedEventId + 1 : 0;
      opts.onStatus?.(
        attempt > 0
          ? `Resuming dust from event ${startFromId} (continuation ${attempt + 1})…`
          : (cached ? `Resuming dust from event ${startFromId}…` : 'Reading dust events…'),
      );

      result = await this.fetchDust(seed, network, {
        startFromId,
        initialState: cached?.state,
        signal: opts.signal,
        onProgress: (applied, max) => {
          const target = Math.max(1, max + 1 - startFromId);
          opts.onStatus?.(`Reading dust events… ${applied}/${target}`);
        },
        // Persist after each chunk so a Ctrl+C / process kill / SIGTERM
        // doesn't lose 100k events of work.
        onCheckpoint: (state, lastAppliedEventId) => {
          try { saveDustCache(networkName, pubkeyHex, state, lastAppliedEventId, this.cacheDir); } catch { /* best-effort */ }
        },
      });

      // Final save (covers the last sub-chunk that didn't trip onCheckpoint).
      if (result.lastAppliedEventId >= 0 || !cached) {
        const savedId = result.lastAppliedEventId >= 0
          ? result.lastAppliedEventId
          : (cached?.lastAppliedEventId ?? -1);
        try { saveDustCache(networkName, pubkeyHex, result.state, savedId, this.cacheDir); } catch { /* best-effort */ }
      }

      totalEventsApplied += result.eventCount;
      if (!result.partial) break;

      // Reload for the next iteration so cached.state is the latest checkpoint.
      cached = loadDustCache(networkName, pubkeyHex, this.cacheDir);
    }

    const view: DustView = {
      state: result!.state,
      balance: result!.balance,
      availableCoins: result!.availableCoins,
      ownedUtxoCount: result!.ownedUtxoCount,
      syncTime: result!.syncTime,
      fromCache: startedFromCache,
      eventsApplied: totalEventsApplied,
      fetchedAt: this.now(),
    };
    const tip = await this.getTip(network, opts.signal);
    this.dustMemo.set(memoKey, { value: view, fetchedAt: view.fetchedAt, tipAtFetch: tip });
    return view;
  }

  async unshielded(
    identity: string | Buffer,
    network: NetworkConfig,
    opts: ReadOptions = {},
  ): Promise<UnshieldedView> {
    const networkName = networkNameOf(network);
    const address = typeof identity === 'string'
      ? identity
      : deriveUnshieldedAddress(identity, networkName);
    const memoKey = `${networkName}:${address}`;

    if (!opts.forceFresh) {
      const hit = await this.tryMemo(memoKey, network, this.unshieldedMemo, opts.signal);
      if (hit) return { ...hit, fromCache: true };
    }

    const summary = await this.fetchUnshielded(address, network);
    const view: UnshieldedView = { ...summary, fromCache: false, fetchedAt: this.now() };
    const tip = await this.getTip(network, opts.signal);
    this.unshieldedMemo.set(memoKey, { value: view, fetchedAt: view.fetchedAt, tipAtFetch: tip });
    return view;
  }

  // ── Borrow pattern (writes) ───────────────────────

  async withFacade<T>(
    seed: Buffer,
    network: NetworkConfig,
    fn: (lease: FacadeLease) => Promise<T>,
    opts: FacadeOptions = {},
  ): Promise<T> {
    const syncMode = opts.syncMode ?? 'full';
    const requireStrictSync = opts.requireStrictSync ?? true;
    const networkName = networkNameOf(network);
    const address = deriveUnshieldedAddress(seed, networkName);

    await validateWalletCacheChainId(address, networkName, network.node);
    const cache = opts.forceFresh ? null : loadWalletCache(address, networkName, this.cacheDir);
    const bundle = await buildFacade(seed, network, cache);
    try {
      const state = await startAndSyncFacade(bundle, { syncMode, requireStrictSync });
      const result = await fn({ bundle, state });
      try { await saveWalletCache(address, networkName, bundle.facade, this.cacheDir); } catch { /* best-effort */ }
      if (!opts.readOnly) this.invalidate({ network, seed });
      return result;
    } finally {
      await stopFacade(bundle);
    }
  }

  // ── Invalidation ──────────────────────────────────

  invalidate(scope: InvalidationScope): void {
    const networkName = networkNameOf(scope.network);
    const kinds = scope.kinds ?? ['dust', 'unshielded', 'facade'];

    if (kinds.includes('dust')) {
      if (scope.seed) {
        const pubkeyHex = dustPublicKeyHexFromSeed(scope.seed);
        this.dustMemo.delete(`${networkName}:${pubkeyHex}`);
      } else {
        this.deleteByPrefix(this.dustMemo, `${networkName}:`);
      }
    }

    if (kinds.includes('unshielded')) {
      const addr = scope.address
        ?? (scope.seed ? deriveUnshieldedAddress(scope.seed, networkName) : null);
      if (addr) this.unshieldedMemo.delete(`${networkName}:${addr}`);
      else this.deleteByPrefix(this.unshieldedMemo, `${networkName}:`);
    }

    if (kinds.includes('facade') && scope.seed) {
      const address = deriveUnshieldedAddress(scope.seed, networkName);
      try { clearWalletCache(address, networkName, this.cacheDir); } catch { /* best-effort */ }
    }
  }

  /** Drop the chain-tip memo so the next read re-checks. Test/diagnostic helper. */
  resetTipMemo(): void {
    this.tipMemo.clear();
  }

  // ── Internals ─────────────────────────────────────

  private async tryMemo<T>(
    key: string,
    network: NetworkConfig,
    memo: Map<string, MemoEntry<T>>,
    signal?: AbortSignal,
  ): Promise<T | null> {
    const entry = memo.get(key);
    if (!entry) return null;
    let tip: TipFingerprint;
    try {
      tip = await this.getTip(network, signal);
    } catch {
      // Network down on the tip-check → serve cache. Caller can pass forceFresh
      // if they need certainty over availability.
      return entry.value;
    }
    if (tip === entry.tipAtFetch) return entry.value;
    memo.delete(key);
    return null;
  }

  private async getTip(network: NetworkConfig, signal?: AbortSignal): Promise<TipFingerprint> {
    const cached = this.tipMemo.get(network.networkId);
    if (cached && this.now() - cached.fetchedAt < TIP_PROBE_TTL_MS) return cached.tip;
    const tip = await this.fetchTip(network, signal);
    this.tipMemo.set(network.networkId, { tip, fetchedAt: this.now() });
    return tip;
  }

  private deleteByPrefix(memo: Map<string, unknown>, prefix: string): void {
    for (const k of memo.keys()) {
      if (k.startsWith(prefix)) memo.delete(k);
    }
  }
}

// ── Default seam implementations ──────────────────────────

async function defaultTipFetcher(network: NetworkConfig): Promise<TipFingerprint> {
  return callNodeRpc<string>({ url: network.node, timeoutMs: 3_000 }, 'chain_getBlockHash', []);
}

function defaultUnshieldedFetcher(
  address: string,
  network: NetworkConfig,
  onProgress?: (current: number, highest: number) => void,
): Promise<BalanceSummary> {
  return checkBalance(address, network.indexerWS, onProgress);
}

function defaultDustFetcher(
  seed: Buffer,
  network: NetworkConfig,
  opts: { startFromId: number; initialState?: ledger.DustLocalState; signal?: AbortSignal; onProgress?: (applied: number, max: number) => void },
): Promise<DustDirectResult> {
  const dustSeed = deriveDustSeed(seed);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(dustSeed);
  return readDustBalanceDirect(dustSecretKey, network.indexerWS, opts);
}

// ── Helpers ───────────────────────────────────────────────

function networkNameOf(network: NetworkConfig): NetworkName {
  const lower = network.networkId.toLowerCase();
  if (isValidNetworkName(lower)) return lower;
  throw new Error(`Unsupported network: ${network.networkId}`);
}

// ── Process-wide singleton ────────────────────────────────

let defaultRepo: WalletDataRepository | null = null;

/**
 * Process-wide repository instance. Long-lived MCP sessions share this so
 * the in-memory cache layer is meaningful across tool calls.
 */
export function defaultRepository(): WalletDataRepository {
  if (!defaultRepo) defaultRepo = new WalletDataRepository();
  return defaultRepo;
}

/** Test/diagnostic: replace the process singleton (e.g. with a different `cacheDir`). */
export function setDefaultRepository(repo: WalletDataRepository | null): void {
  defaultRepo = repo;
}
