import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { WalletFacade, type FacadeState } from '@midnight-ntwrk/wallet-sdk-facade';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import {
  NetworkId,
  InMemoryTransactionHistoryStorage,
  TransactionHistoryStorage,
} from '@midnight-ntwrk/wallet-sdk-abstractions';
import * as rx from 'rxjs';

import { type NetworkConfig } from './network.ts';
import { deriveShieldedSeed, deriveUnshieldedSeed, deriveDustSeed } from './derivation.ts';
import { type WalletCacheData } from './wallet-cache.ts';
import { loadDustCache, dustPublicKeyHex } from './dust-direct-cache.ts';
import {
  DUST_COST_OVERHEAD,
  DUST_FEE_BLOCKS_MARGIN,
  SYNC_TIMEOUT_MS,
  PRE_SEND_SYNC_TIMEOUT_MS,
} from './constants.ts';
import { verbose } from './verbose.ts';

const NETWORK_ID_MAP: Record<string, NetworkId.NetworkId> = {
  PreProd: NetworkId.NetworkId.PreProd,
  Preview: NetworkId.NetworkId.Preview,
  Undeployed: NetworkId.NetworkId.Undeployed,
};

export type SyncMode = 'full' | 'lite' | 'no-dust';
// full    = shielded + unshielded + dust
// lite    = unshielded + dust (skip shielded — used by dust register/status)
// no-dust = shielded + unshielded (skip dust — used by balance; dust isn't needed
//           to read NIGHT balances and avoids the dust `isConnected` SDK hang)

export interface FacadeBundle {
  facade: WalletFacade;
  keystore: ReturnType<typeof createKeystore>;
  zswapSecretKeys: ReturnType<typeof ledger.ZswapSecretKeys.fromSeed>;
  dustSecretKey: ReturnType<typeof ledger.DustSecretKey.fromSeed>;
  /** Active subscription that keeps shareReplay buffers alive. Cleaned up by stopFacade. */
  keepAlive?: rx.Subscription;
  /** Whether the facade was restored from cached state (vs built from scratch). */
  restoredFromCache?: boolean;
}

/**
 * Build a complete WalletFacade from a seed and network config.
 * Returns the facade plus all keys needed for signing and proving.
 *
 * When `cache` is provided, wallets are restored from serialized state
 * instead of starting fresh — the SDK then only syncs new transactions
 * since the last checkpoint.
 */
export async function buildFacade(
  seedBuffer: Buffer,
  networkConfig: NetworkConfig,
  cache?: WalletCacheData | null,
): Promise<FacadeBundle> {
  const networkId = NETWORK_ID_MAP[networkConfig.networkId];
  if (networkId === undefined) {
    throw new Error(`Unknown networkId: ${networkConfig.networkId}`);
  }

  verbose('facade', `Building facade for network ${networkConfig.networkId}`);
  verbose('facade', `Node: ${networkConfig.node}`);
  verbose('facade', `Indexer: ${networkConfig.indexerWS}`);
  verbose('facade', `Proof server: ${networkConfig.proofServer}`);

  const shieldedSeed = deriveShieldedSeed(seedBuffer);
  const unshieldedSeed = deriveUnshieldedSeed(seedBuffer);
  const dustSeed = deriveDustSeed(seedBuffer);

  const zswapSecretKeys = ledger.ZswapSecretKeys.fromSeed(shieldedSeed);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(dustSeed);
  const keystore = createKeystore(unshieldedSeed, networkId);

  // Merged configuration for WalletFacade.init() — all wallet types
  // and services draw from this single config object.
  const configuration = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: networkConfig.indexer,
      indexerWsUrl: networkConfig.indexerWS,
    },
    costParameters: {
      additionalFeeOverhead: DUST_COST_OVERHEAD,
      feeBlocksMargin: DUST_FEE_BLOCKS_MARGIN,
    },
    // SDK 4.0.0 made the schema explicit; use the unshielded wallet's standard
    // TransactionHistoryEntryWithHash schema, matching the v1 builder's expectation.
    txHistoryStorage: new InMemoryTransactionHistoryStorage(TransactionHistoryStorage.TransactionHistoryCommonSchema),
    provingServerUrl: new URL(networkConfig.proofServer),
    relayURL: new URL(networkConfig.node),
  };

  // Fresh build — starts all wallets from keys (no cache).
  const initFresh = () => WalletFacade.init({
    configuration,
    shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(zswapSecretKeys),
    unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: (cfg) => DustWallet(cfg).startWithSecretKey(
      dustSecretKey,
      ledger.LedgerParameters.initialParameters().dust,
    ),
  });

  // Bridge: if the dust-direct cache has a more recent DustLocalState than the
  // facade cache, overlay it into the facade cache's dust snapshot before
  // restore. This lets commands that use the facade (transfer, airdrop, dust
  // register) benefit from the indexer-direct reader's checkpoint without
  // re-implementing the whole transaction flow.
  const effectiveCache = cache ? maybeBridgeDustCache(cache, networkConfig, dustSecretKey.publicKey) : null;

  // Attempt cache restore — fall back to fresh build on any deserialization error.
  let restoredFromCache = false;
  let facade: WalletFacade;

  if (effectiveCache) {
    verbose('facade', 'Restoring from cache...');
    try {
      facade = await WalletFacade.init({
        configuration,
        shielded: (cfg) => ShieldedWallet(cfg).restore(effectiveCache.shielded),
        unshielded: (cfg) => UnshieldedWallet(cfg).restore(effectiveCache.unshielded),
        dust: (cfg) => DustWallet(cfg).restore(effectiveCache.dust),
      });
      restoredFromCache = true;
      verbose('facade', 'Cache restore successful');
    } catch (err) {
      verbose('facade', `Cache restore failed: ${(err as Error).message}`);
      process.stderr.write(`  Cache restore failed, building from scratch: ${(err as Error).message}\n`);
      facade = await initFresh();
    }
  } else {
    verbose('facade', 'No cache, building fresh');
    facade = await initFresh();
  }

  return { facade, keystore, zswapSecretKeys, dustSecretKey, restoredFromCache };
}

/**
 * If our indexer-direct cache has a NEWER DustLocalState than the facade
 * cache, overlay it into the facade cache's dust snapshot. Keeps publicKey,
 * protocolVersion, networkId from the existing snapshot; only state + offset
 * change. Returns the cache unchanged if:
 *   - no dust-direct entry exists
 *   - facade cache's own offset is already >= dust-direct's offset (prior
 *     transfer already advanced it past our indexer-direct snapshot)
 *   - parsing fails
 */
// Shape of the facade's serialized dust-wallet snapshot. See
// dust-wallet/src/v1/Serialization.ts `SnapshotSchema` — JSON on disk with
// BigInts rendered as decimal strings.
interface FacadeDustSnapshot {
  publicKey: { publicKey: string };
  state: string;
  protocolVersion: string;
  networkId: string;
  offset?: string;
}

function maybeBridgeDustCache(
  cache: WalletCacheData,
  networkConfig: NetworkConfig,
  dustPublicKey: ledger.DustPublicKey,
): WalletCacheData {
  try {
    const networkName = networkConfig.networkId.toLowerCase();
    const pubkeyHex = dustPublicKeyHex(dustPublicKey);
    const direct = loadDustCache(networkName, pubkeyHex);
    if (!direct) return cache;

    const snapshot: FacadeDustSnapshot = JSON.parse(cache.dust);
    const facadeOffset = snapshot.offset !== undefined ? Number(snapshot.offset) : -1;
    if (facadeOffset >= direct.lastAppliedEventId) {
      verbose('facade', `Facade dust offset=${facadeOffset} >= dust-direct offset=${direct.lastAppliedEventId}; skipping bridge`);
      return cache;
    }

    snapshot.state = Buffer.from(direct.state.serialize()).toString('hex');
    snapshot.offset = direct.lastAppliedEventId.toString();
    verbose('facade', `Bridged dust-direct cache (facade offset ${facadeOffset} → dust-direct offset ${direct.lastAppliedEventId})`);
    return { ...cache, dust: JSON.stringify(snapshot) };
  } catch (err) {
    verbose('facade', `Dust-direct bridge skipped: ${(err as Error).message}`);
    return cache;
  }
}

/**
 * SDK bug workaround: the dust wallet's `isStrictlyComplete()` requires
 * `isConnected === true`, but `isConnected` only becomes true when a non-empty
 * batch of DustLedgerEvents arrives from the indexer. On an idle chain (no new
 * dust transactions), empty batches don't set `isConnected`, so
 * `isStrictlyComplete()` stays false forever and `isSynced` never becomes true.
 *
 * This predicate bypasses the `isConnected` check for dust by verifying the
 * actual sync index values directly: if `appliedIndex >= highestRelevantWalletIndex`,
 * the dust wallet is caught up regardless of `isConnected`.
 *
 * Shielded and unshielded wallets don't have this issue because the indexer
 * sends progress messages (unshielded) or zswap events (shielded) on every block.
 */
export function isFacadeSynced(state: FacadeState, syncMode: SyncMode = 'full'): boolean {
  const unshieldedOk = state.unshielded?.progress?.isStrictlyComplete() ?? false;

  // Dust check (only evaluated for modes that need dust).
  // For dust: try isStrictlyComplete first; if it fails due to isConnected bug,
  // fall back to checking index values directly.
  const needsDust = syncMode !== 'no-dust';
  let dustOk = !needsDust;
  if (needsDust) {
    dustOk = state.dust?.state?.progress?.isStrictlyComplete() ?? false;
    if (!dustOk) {
      try {
        const p = state.dust?.state?.progress as any;
        if (p && p.highestRelevantWalletIndex > 0 && p.appliedIndex >= p.highestRelevantWalletIndex) {
          dustOk = true;
        }
        // Unfunded wallet: both indices are 0 and isConnected is false.
        // If unshielded is done (it syncs independently), treat dust as done too —
        // there's nothing to sync, the wallet just has no dust events.
        if (p && p.highestRelevantWalletIndex === 0 && p.appliedIndex === 0 && unshieldedOk) {
          dustOk = true;
        }
      } catch { /* best-effort */ }
    }
  }

  if (syncMode === 'lite') {
    return unshieldedOk && dustOk;
  }

  let shieldedOk = state.shielded?.state?.progress?.isStrictlyComplete() ?? false;
  // Same pattern for shielded: unfunded wallet has no zswap events.
  // If unshielded is synced and shielded shows 0/0 indices, consider it done.
  if (!shieldedOk && unshieldedOk) {
    try {
      const p = state.shielded?.state?.progress as any;
      if (p && p.highestRelevantWalletIndex === 0 && p.appliedIndex === 0) {
        shieldedOk = true;
      }
    } catch { /* best-effort */ }
  }

  return shieldedOk && unshieldedOk && dustOk;
}

/** Check if dust wallet sync is pending (for diagnostics). */
function isDustSyncPending(state: FacadeState): boolean {
  if (state.dust?.state?.progress?.isStrictlyComplete()) return false;
  try {
    const p = state.dust?.state?.progress as any;
    if (p && p.highestRelevantWalletIndex > 0 && p.appliedIndex >= p.highestRelevantWalletIndex) return false;
    // Unfunded wallet: 0/0 indices with unshielded synced = not pending
    if (p && p.highestRelevantWalletIndex === 0 && p.appliedIndex === 0
        && state.unshielded?.progress?.isStrictlyComplete()) return false;
  } catch { /* best-effort */ }
  return true;
}

/**
 * Start the facade and wait for initial sync.
 * Calls onProgress with sync progress updates.
 *
 * Uses a single persistent subscription to facade.state() that serves three purposes:
 * 1. Reports unshielded progress (and which wallets are still syncing)
 * 2. Detects sync completion to resolve the sync promise
 * 3. Keeps shareReplay({ refCount: true }) buffers alive for the command lifetime
 */
export interface SyncOptions {
  onProgress?: (applied: number, highest: number) => void;
  onSyncDetail?: (detail: string) => void;
  timeoutMs?: number;
  syncMode?: SyncMode;
  /**
   * Require strict sync before resolving (disables the cached-restore grace
   * period). Write operations (transfer, airdrop, dust register, contract
   * calls) MUST pass this because they construct ZK proofs against the
   * commitment tree — if the tree is stale, the proof fails validation on
   * chain (MalformedError::InvalidDustSpendProof, error code 170). Read-only
   * operations (balance, dust status) can leave this off for the speedup.
   */
  requireStrictSync?: boolean;
}

export async function startAndSyncFacade(
  bundle: FacadeBundle,
  options: SyncOptions = {},
): Promise<FacadeState> {
  const { onProgress, onSyncDetail, timeoutMs, syncMode = 'full', requireStrictSync = false } = options;
  const { facade, zswapSecretKeys, dustSecretKey } = bundle;

  verbose('sync', 'Starting facade (connecting to node and indexer)...');
  await facade.start(zswapSecretKeys, dustSecretKey);
  verbose('sync', 'Facade started, subscribing to state...');

  const effectiveTimeout = timeoutMs ?? SYNC_TIMEOUT_MS;
  verbose('sync', `Sync timeout: ${effectiveTimeout / 1000}s, mode: ${syncMode}`);

  // Cached-restore grace: if the facade was restored from cache and we're a
  // READ operation, accept dust as "good enough" once non-dust wallets are
  // strictly complete AND `CACHED_RESTORE_DUST_GRACE_MS` has elapsed — without
  // waiting for the dust-wallet SDK's `isConnected` flag (known bug — never
  // flips on idle preprod streams). Writes set `requireStrictSync` to opt out,
  // because ZK proofs built against a stale commitment tree are rejected by
  // the chain as MalformedError::InvalidDustSpendProof (error code 170).
  const graceEligible = !requireStrictSync && bundle.restoredFromCache;
  const startedAt = Date.now();

  return new Promise<FacadeState>((resolve, reject) => {
    let resolved = false;
    let emissionCount = 0;
    let lastPendingKey = '';

    let lastState: FacadeState | null = null;

    const timeout = setTimeout(() => {
      if (!resolved) {
        verbose('sync', `Sync timed out after ${effectiveTimeout / 1000}s (${emissionCount} emissions)`);
        if (lastState) {
          try {
            const up = lastState.unshielded?.progress;
            verbose('sync', `  unshielded: applied=${up?.appliedId} highest=${up?.highestTransactionId} complete=${up?.isStrictlyComplete()}`);
            const dp = lastState.dust?.state?.progress as any;
            verbose('sync', `  dust: applied=${dp?.appliedIndex} highest=${dp?.highestRelevantWalletIndex} complete=${dp?.isStrictlyComplete?.()} connected=${dp?.isConnected}`);
            if (syncMode === 'full') {
              const sp = lastState.shielded?.state?.progress;
              verbose('sync', `  shielded: complete=${sp?.isStrictlyComplete()}`);
            }
          } catch { /* best-effort */ }
        }
        reject(new Error('Wallet sync timed out'));
      }
    }, effectiveTimeout);

    bundle.keepAlive = facade.state().subscribe({
      next: (state) => {
        if (resolved) return;
        emissionCount++;
        lastState = state;

        // Stale-cache detection: if we restored from cache and our cached
        // appliedIndex exceeds the chain's currently-reported highest, the
        // cache is from a different chain (common on localnet restarts).
        // Runs on every emission so the error fires before `isFacadeSynced`
        // might accept a stale state (sync can "complete" against cached
        // data before any chain-tip data arrives on emission 1-2).
        if (bundle.restoredFromCache) {
          const staleReason = detectStaleCache(state);
          if (staleReason) {
            resolved = true;
            clearTimeout(timeout);
            verbose('sync', `Stale cache detected: ${staleReason}`);
            reject(new StaleCacheError(staleReason));
            return;
          }
        }

        if (onProgress) {
          const progress = state.unshielded.progress;
          if (progress) {
            const applied = Number(progress.appliedId);
            const highest = Number(progress.highestTransactionId);
            onProgress(Math.min(applied, highest), highest);
          }
        }

        // Report which wallets are still syncing (only the ones this mode needs).
        const pending: string[] = [];
        try {
          if ((syncMode === 'full' || syncMode === 'no-dust') && !state.shielded?.state?.progress?.isStrictlyComplete()) pending.push('shielded');
          if (syncMode !== 'no-dust' && isDustSyncPending(state)) pending.push('dust');
          if (!state.unshielded?.progress?.isStrictlyComplete()) pending.push('unshielded');
        } catch { /* best-effort */ }

        if (pending.length > 0) {
          onSyncDetail?.(pending.join(', '));
          const pendingKey = pending.join(',');
          if (emissionCount === 1 || pendingKey !== lastPendingKey || emissionCount % 100 === 0) {
            verbose('sync', `Waiting on: ${pending.join(', ')} (emission #${emissionCount})`);
            lastPendingKey = pendingKey;
          }
        }

        // Primary: strict sync per mode (uses the isFacadeSynced workaround for
        // the dust isConnected bug — see that function above).
        if (isFacadeSynced(state, syncMode)) {
          resolved = true;
          clearTimeout(timeout);
          verbose('sync', `Sync complete after ${emissionCount} emissions`);
          resolve(state);
          return;
        }

        // Grace fallback: treat "everything except dust synced, and grace
        // elapsed" as done. Reuses the existing no-dust predicate so the two
        // completion paths can't drift.
        if (graceEligible) {
          const elapsed = Date.now() - startedAt;
          if (elapsed >= CACHED_RESTORE_DUST_GRACE_MS && isFacadeSynced(state, 'no-dust')) {
            resolved = true;
            clearTimeout(timeout);
            verbose('sync', `Sync resolved via cached-restore grace (${elapsed}ms, ${emissionCount} emissions)`);
            resolve(state);
          }
        }
      },
      error: (err) => {
        if (!resolved) {
          verbose('sync', `Sync error: ${(err as Error).message}`);
          clearTimeout(timeout);
          reject(err);
        }
      },
    });
  });
}

// Cached-restore grace period: after this long, if the facade was built from
// a cache, accept dust as "good enough" without waiting for the SDK's
// isConnected flag (which has a known bug and may never flip).
const CACHED_RESTORE_DUST_GRACE_MS = 10_000;

/**
 * Raised when a restored facade's cached state references event ids that
 * don't exist on the current chain — typically because the local chain was
 * reset (e.g. `mn localnet clean`) while the cache on disk kept the old
 * wallet state. Commands should catch this and clear the cache before retrying.
 */
export class StaleCacheError extends Error {
  readonly code = 'STALE_CACHE';
  constructor(detail: string) {
    super(
      `Cached wallet state is stale (from a previous chain). ${detail}\n` +
      `Run: midnight cache clear --wallet <name> --network <name>\n` +
      `Or:  midnight cache clear  (wipe all caches)`,
    );
    this.name = 'StaleCacheError';
  }
}

/**
 * Detect a cache whose `appliedIndex` exceeds the chain's currently-reported
 * `highestRelevantWalletIndex` — a signature of a cache restored against a
 * different chain (new localnet, networkId reuse, etc).
 *
 * Returns a human-readable reason string if stale, otherwise undefined.
 * Only checks unshielded (the indexer sends progress on every block so its
 * `highestTransactionId` is populated reliably — dust's `highest` can be 0
 * genuinely on a quiet stream even when cache is valid, so checking it would
 * produce false positives).
 */
function detectStaleCache(state: FacadeState): string | undefined {
  try {
    const up = state.unshielded?.progress as any;
    if (!up) return undefined;
    const applied = Number(up.appliedId ?? 0);
    const highest = Number(up.highestTransactionId ?? 0);
    // We require highest > 0 to ensure the indexer has reported at least once;
    // otherwise we can't make a reliable comparison. applied > highest means
    // our local state has applied events the chain doesn't have.
    if (highest > 0 && applied > highest) {
      return `unshielded cache applied=${applied} but chain highest=${highest}.`;
    }
  } catch {
    /* best-effort */
  }
  return undefined;
}

/**
 * Wait for a fully-populated lite-synced state (unshielded + dust data ready).
 *
 * The index fallback in `isFacadeSynced` resolves sync before the dust wallet
 * has processed its events into `balance()` and `availableCoins`. This helper
 * waits for dust's `isStrictlyComplete()` (which requires `isConnected` — set
 * when actual DustLedgerEvents arrive and populate state data).
 *
 * On active chains (preprod): resolves quickly — a few seconds after lite sync.
 * On idle chains (no dust events): times out after 15s, returns best-effort state.
 *
 * Use this for data-reading calls (dust status, balances) where accurate state
 * matters. Use `isFacadeSynced` with lite mode for sync gating where the index
 * fallback is acceptable.
 */
export async function waitForLiteSyncedState(bundle: FacadeBundle): Promise<FacadeState> {
  const isDataReady = (s: FacadeState): boolean => {
    const unshieldedOk = s.unshielded?.progress?.isStrictlyComplete() ?? false;
    const dustOk = s.dust?.state?.progress?.isStrictlyComplete() ?? false;
    return unshieldedOk && dustOk;
  };

  try {
    return await rx.firstValueFrom(
      bundle.facade.state().pipe(
        rx.filter(isDataReady),
        rx.timeout(15_000),
      )
    );
  } catch {
    // Timeout — idle chain where dust never connects (no DustLedgerEvents).
    // Fall back to the latest available state (dust balance will be 0, which
    // is correct for a chain with no dust activity).
    return await rx.firstValueFrom(bundle.facade.state());
  }
}

/**
 * Wait for dust coins to actually be available (not just synced).
 *
 * `waitForLiteSyncedState` checks sync progress (`isStrictlyComplete`), but that
 * resolves before `availableCoins` is populated. This helper waits until the dust
 * wallet has at least one available coin, which is required for any write operation
 * (balancing, transfers, swaps).
 *
 * On preprod: may take 10-30s after sync for dust coins to appear.
 * Timeout falls back gracefully — the server still starts, but writes will fail
 * until dust becomes available (the retry wrapper in dapp-connector handles that).
 */
export async function waitForDustAvailable(bundle: FacadeBundle, timeoutMs = 60_000): Promise<FacadeState> {
  const hasDust = (s: FacadeState): boolean => {
    try {
      const dust = s.dust as any;
      return dust?.availableCoins?.length > 0 || dust?.balance(new Date()) > 0n;
    } catch { return false; }
  };

  try {
    return await rx.firstValueFrom(
      bundle.facade.state().pipe(
        rx.filter(hasDust),
        rx.timeout(timeoutMs),
      )
    );
  } catch {
    // Timeout — dust may not be available yet (fresh wallet, slow chain).
    // Return latest state; caller should handle gracefully.
    return await rx.firstValueFrom(bundle.facade.state());
  }
}

/**
 * Quick sync for pre-send validation.
 * Shorter timeout — just catches stale UTXOs before building a transaction.
 */
export async function quickSync(bundle: FacadeBundle, syncMode: SyncMode = 'full'): Promise<FacadeState> {
  return rx.firstValueFrom(
    bundle.facade.state().pipe(
      rx.filter((state) => isFacadeSynced(state, syncMode)),
      rx.timeout(PRE_SEND_SYNC_TIMEOUT_MS),
    )
  );
}

/**
 * Clean shutdown of the wallet facade.
 */
export async function stopFacade(bundle: FacadeBundle): Promise<void> {
  bundle.keepAlive?.unsubscribe();
  // Timeout facade.stop() — wallets may hang if in a bad state (e.g. dust wallet stuck).
  // Don't block the caller forever; let the old facade be GC'd.
  await Promise.race([
    bundle.facade.stop(),
    new Promise<void>(resolve => setTimeout(resolve, 5_000)),
  ]);
}

/**
 * Suppress known transient SDK errors (e.g. Wallet.Sync: Internal Server Error)
 * that leak as unhandled promise rejections and console.error calls during
 * facade operations. The SDK retries internally — these are safe to suppress.
 *
 * Returns a cleanup function to restore original behavior.
 */
export function suppressSdkTransientErrors(
  onWarning?: (tag: string, message: string) => void,
): () => void {
  // Intercept unhandled rejections
  const rejectionHandler = (reason: unknown) => {
    const tag = (reason as any)?._tag;
    if (typeof tag === 'string' && tag.startsWith('Wallet.')) {
      const msg = (reason as any)?.message ?? 'transient error';
      onWarning?.(tag, msg);
      return;
    }
    // Not a known SDK error — mimic Node's default unhandled rejection behavior
    originalConsoleError('Unhandled rejection:', reason);
    process.exit(1);
  };

  // Intercept console.error to filter out SDK noise
  const originalConsoleError = console.error;
  console.error = (...args: any[]) => {
    const firstArg = args[0];
    // Suppress SDK Wallet.Sync stack traces printed directly by the SDK
    if (typeof firstArg === 'object' && firstArg?._tag?.startsWith('Wallet.')) {
      onWarning?.(firstArg._tag, firstArg?.message ?? 'transient error');
      return;
    }
    // Suppress the string form: "Wallet.Sync: Internal Server Error\n    at ..."
    if (typeof firstArg === 'string' && firstArg.startsWith('Wallet.')) {
      onWarning?.('Wallet.Sync', 'transient error');
      return;
    }
    originalConsoleError(...args);
  };

  process.on('unhandledRejection', rejectionHandler);
  return () => {
    process.removeListener('unhandledRejection', rejectionHandler);
    console.error = originalConsoleError;
  };
}
