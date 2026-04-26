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
  StaleCacheError,
  type FacadeBundle,
  type SyncMode,
} from './facade.ts';
import { isSdkInsufficientFundsError } from './sdk-errors.ts';
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
  /**
   * Raw progress signal during the underlying network fetch. For dust this
   * fires per-chunk (events applied vs max event id); for unshielded it
   * fires per-UTXO-batch (current tx vs highest tx id). Callers that already
   * have a spinner usually use this to render a percentage.
   */
  onProgress?: (current: number, highest: number) => void;
}

export interface FacadeOptions extends ReadOptions {
  syncMode?: SyncMode;
  requireStrictSync?: boolean;
  /** If true, skip the post-resolve invalidation (read-only borrowers). */
  readOnly?: boolean;
  /**
   * If true, skip the automatic post-resolve `saveWalletCache`. For callers
   * that have nuanced save logic — e.g. `mn serve` skips the save if there
   * are pending in-flight transactions, because the SDK drops `pendingDustTokens`
   * on serialization and persisting that state corrupts the dust balance.
   */
  skipAutoSave?: boolean;
  /** Per-attempt sync deadline. Default: SYNC_ATTEMPT_TIMEOUT_MS (local) or SYNC_ATTEMPT_REMOTE_TIMEOUT_MS (remote). */
  syncTimeoutMs?: number;
  /** Per-emission sync progress hook (forwards startAndSyncFacade onProgress). */
  onSyncProgress?: (applied: number, highest: number) => void;
  /** Per-emission detail hook (which wallets are still syncing). */
  onSyncDetail?: (detail: string) => void;
  /** Suppressed-but-relayed SDK transient warnings (Wallet.Sync, etc). */
  onSyncWarning?: (tag: string, message: string) => void;
  /** Suppress the dust pre-prime even in write mode (used by tests / debug). */
  noPrime?: boolean;
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

/** Default per-sync-attempt deadline (local). */
const SYNC_ATTEMPT_LOCAL_MS = 30_000;
/** Default per-sync-attempt deadline (remote — preprod/preview Day 0). */
const SYNC_ATTEMPT_REMOTE_MS = 120_000;
/** Sync-retry budget: number of build+sync attempts before giving up on transient sync errors. */
const SYNC_MAX_ATTEMPTS = 3;
/** Cold-start race retry budget: how many times to stop+rebuild+re-sync when the SDK reports InsufficientFunds despite a synced state with coins. */
const COLD_START_MAX_ATTEMPTS = 5;
/** Backoff between cold-start retries — gives the indexer time to settle. */
const COLD_START_DELAY_MS = 5_000;

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

    const summary = await this.fetchUnshielded(address, network, opts.onProgress);
    const view: UnshieldedView = { ...summary, fromCache: false, fetchedAt: this.now() };
    const tip = await this.getTip(network, opts.signal);
    this.unshieldedMemo.set(memoKey, { value: view, fetchedAt: view.fetchedAt, tipAtFetch: tip });
    return view;
  }

  // ── Borrow pattern (writes) ───────────────────────

  /**
   * Borrow a synced WalletFacade for a write or facade-bound read. Owns the
   * full lifecycle plus the recovery loops every write path used to
   * re-implement:
   *
   *   1. Optional dust pre-prime (skipped when `noPrime: true` or when in
   *      read-only mode). Warms the dust-direct cache so the facade's dust
   *      wallet restores from a near-tip checkpoint instead of cold-syncing
   *      via the SDK's `isConnected` path.
   *   2. Sync-retry on `StaleCacheError` (chain reset / re-index): wipe both
   *      caches, re-prime, rebuild from a clean cache, re-sync.
   *   3. Sync-retry on timeout: persist whatever progress the facade made,
   *      reload from disk so the next attempt resumes from the checkpoint.
   *   4. Cold-start race retry around `fn`: when the SDK throws
   *      `Wallet.InsufficientFunds` despite the synced state showing coins
   *      (the SDK's internal coin index hadn't caught up to the state
   *      snapshot), stop+rebuild+re-sync and call fn again. Bounded.
   *   5. Save wallet cache on success.
   *   6. Auto-invalidate dust+unshielded+facade memo entries for this seed
   *      (writes mutate state). Read-only borrowers pass `readOnly: true`.
   *   7. stopFacade in `finally`.
   *
   * The SDK's `FacadeBundle` is intentionally exposed via `lease.bundle` so
   * callers can build/sign/submit transactions. Tests of write paths through
   * this method are integration tests against a real network.
   */
  async withFacade<T>(
    seed: Buffer,
    network: NetworkConfig,
    fn: (lease: FacadeLease) => Promise<T>,
    opts: FacadeOptions = {},
  ): Promise<T> {
    const syncMode = opts.syncMode ?? 'full';
    const requireStrictSync = opts.requireStrictSync ?? true;
    const writeMode = requireStrictSync && !opts.readOnly;
    const networkName = networkNameOf(network);
    const address = deriveUnshieldedAddress(seed, networkName);
    const isRemote = network.networkId !== 'Undeployed';
    const syncTimeoutMs = opts.syncTimeoutMs
      ?? (isRemote ? SYNC_ATTEMPT_REMOTE_MS : SYNC_ATTEMPT_LOCAL_MS);

    await validateWalletCacheChainId(address, networkName, network.node);

    // ── Pre-prime the dust-direct cache for write-mode borrowers ──
    // Equivalent to the legacy `primeDustCacheWithFeedback` step: warms the
    // dust state to chain tip on disk so buildFacade's dust bridge starts
    // near-tip. Read-only borrowers skip it.
    if (writeMode && !opts.noPrime && !opts.forceFresh) {
      try {
        await this.dust(seed, network, { signal: opts.signal, onStatus: opts.onStatus });
      } catch (err) {
        // Pre-prime is best-effort — the actual sync below will re-attempt
        // anyway. Surface the error only via onSyncWarning if anyone cares.
        opts.onSyncWarning?.('PrePrime', (err as Error).message);
      }
    }

    let bundle: FacadeBundle | undefined;
    let syncedState: FacadeState | undefined;
    let cleanupDone = false;
    const cleanup = async () => {
      if (cleanupDone || !bundle) return;
      cleanupDone = true;
      try { await stopFacade(bundle); } catch { /* best-effort */ }
    };

    try {
      // ── Sync-retry loop (build + start) ────────────────────
      for (let attempt = 1; attempt <= SYNC_MAX_ATTEMPTS; attempt++) {
        if (opts.signal?.aborted) throw new Error('Operation cancelled');
        const cacheBeforeBuild = opts.forceFresh
          ? null
          : loadWalletCache(address, networkName, this.cacheDir);
        bundle = await buildFacade(seed, network, cacheBeforeBuild);
        try {
          syncedState = await startAndSyncFacade(bundle, {
            onProgress: opts.onSyncProgress,
            onSyncDetail: opts.onSyncDetail,
            timeoutMs: syncTimeoutMs,
            syncMode,
            requireStrictSync,
          });
          break;
        } catch (err: any) {
          if (opts.signal?.aborted) throw new Error('Operation cancelled');

          if (err instanceof StaleCacheError && attempt < SYNC_MAX_ATTEMPTS && writeMode) {
            opts.onStatus?.(`Cache is stale, clearing and rebuilding (attempt ${attempt + 1}/${SYNC_MAX_ATTEMPTS})...`);
            await stopFacade(bundle).catch(() => {});
            bundle = undefined;
            clearWalletCache(address, networkName, this.cacheDir);
            clearDustDirectCache(networkName, dustPublicKeyHexFromSeed(seed), this.cacheDir);
            // Re-prime the dust cache so the next attempt restores from a
            // current checkpoint instead of a full SDK resync.
            try {
              await this.dust(seed, network, { signal: opts.signal, onStatus: opts.onStatus });
            } catch { /* best-effort */ }
            continue;
          }

          if (attempt < SYNC_MAX_ATTEMPTS && String(err?.message ?? '').includes('timed out')) {
            // Save partial sync progress to cache before retrying so the next
            // attempt resumes from the latest event id.
            try { await saveWalletCache(address, networkName, bundle.facade, this.cacheDir); } catch { /* best-effort */ }
            opts.onStatus?.(`Sync timed out, retrying (attempt ${attempt + 1}/${SYNC_MAX_ATTEMPTS})...`);
            await stopFacade(bundle).catch(() => {});
            bundle = undefined;
            continue;
          }

          throw err;
        }
      }

      if (!bundle || !syncedState) throw new Error('Sync failed: no facade state after retries');

      // ── Cold-start race retry around fn ───────────────────
      // The SDK's state observable can emit a snapshot with coins populated
      // BEFORE the internal #balanceSegment coin index is built. fn's call
      // to transferTransaction then throws Wallet.InsufficientFunds. Recovery
      // is a full facade restart, not in-place quick-sync. Bounded.
      let result: T;
      let attempt = 0;
      while (true) {
        attempt++;
        if (opts.signal?.aborted) throw new Error('Operation cancelled');
        try {
          result = await fn({ bundle, state: syncedState });
          break;
        } catch (err) {
          const canRetry = writeMode && attempt < COLD_START_MAX_ATTEMPTS && isSdkInsufficientFundsError(err);
          if (!canRetry) throw err;
          opts.onStatus?.(`Refreshing wallet state (attempt ${attempt + 1}/${COLD_START_MAX_ATTEMPTS})...`);
          await stopFacade(bundle).catch(() => {});
          bundle = undefined;
          await new Promise((r) => setTimeout(r, COLD_START_DELAY_MS));
          if (opts.signal?.aborted) throw new Error('Operation cancelled');
          const retryCache = loadWalletCache(address, networkName, this.cacheDir);
          bundle = await buildFacade(seed, network, retryCache);
          syncedState = await startAndSyncFacade(bundle, {
            onProgress: opts.onSyncProgress,
            onSyncDetail: opts.onSyncDetail,
            timeoutMs: syncTimeoutMs,
            syncMode,
            requireStrictSync,
          });
        }
      }

      if (!opts.skipAutoSave) {
        try { await saveWalletCache(address, networkName, bundle.facade, this.cacheDir); } catch { /* best-effort */ }
      }
      if (!opts.readOnly) this.invalidate({ network, seed });
      return result;
    } finally {
      await cleanup();
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
