import { ShieldedWallet } from '@midnightntwrk/wallet-sdk/shielded';
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
  type UnshieldedKeystore,
} from '@midnightntwrk/wallet-sdk/unshielded';
import { DustWallet } from '@midnightntwrk/wallet-sdk/dust';
import {
  WalletFacade,
  WalletEntrySchema,
  mergeWalletEntries,
  type FacadeState,
} from '@midnightntwrk/wallet-sdk/facade';
import { type WalletSeeds } from '@midnightntwrk/wallet-sdk/hd';
import * as ledger from '@midnightntwrk/ledger-v9';
import { InMemoryTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk';
import * as rx from 'rxjs';

import { type NetworkConfig, FORK_SCHEDULE } from './network.ts';
import { getNetworkId } from './network-id.ts';
import { deriveShieldedSeed, deriveUnshieldedSeed, deriveDustSeed } from './derivation.ts';
import { type WalletCacheData } from './wallet-cache.ts';
import { loadDustCache, dustPublicKeyHex, type DustCacheEntry } from './dust-direct-cache.ts';
import {
  DUST_COST_OVERHEAD,
  DUST_FEE_BLOCKS_MARGIN,
  SYNC_TIMEOUT_MS,
  PRE_SEND_SYNC_TIMEOUT_MS,
} from './constants.ts';
import { verbose } from './verbose.ts';

export type SyncMode = 'full' | 'lite' | 'no-dust';
// full    = shielded + unshielded + dust
// lite    = unshielded + dust (skip shielded — used by dust register/status)
// no-dust = shielded + unshielded (skip dust — used by balance; dust isn't needed
//           to read NIGHT balances and avoids the dust `isConnected` SDK hang)

/** A shielded or dust wallet that can be started from its seed (both SDK forking wallets can). */
interface SeedStartable {
  startWithSeed(seed: Uint8Array): Promise<void>;
}

export interface FacadeBundle {
  facade: WalletFacade;
  keystore: UnshieldedKeystore;
  /** Per-role seeds: the material the wallets are started with. */
  seeds: WalletSeeds;
  /** The shielded and dust wallets the facade wraps, kept so a restored facade can be started from seeds. */
  seedStartable: { shielded: SeedStartable; dust: SeedStartable };
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
  const networkId = getNetworkId(networkConfig.networkId);

  verbose('facade', `Building facade for network ${networkConfig.networkId}`);
  verbose('facade', `Node: ${networkConfig.node}`);
  verbose('facade', `Indexer: ${networkConfig.indexerWS}`);
  verbose('facade', `Proof server: ${networkConfig.proofServer}`);

  const seeds: WalletSeeds = {
    shielded: deriveShieldedSeed(seedBuffer),
    unshielded: deriveUnshieldedSeed(seedBuffer),
    dust: deriveDustSeed(seedBuffer),
  };
  const keystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, networkId);

  // Merged configuration for WalletFacade.init() — all wallet types
  // and services draw from this single config object.
  const configuration = {
    networkId,
    forks: FORK_SCHEDULE,
    indexerClientConnection: {
      indexerHttpUrl: networkConfig.indexer,
      indexerWsUrl: networkConfig.indexerWS,
    },
    costParameters: {
      additionalFeeOverhead: DUST_COST_OVERHEAD,
      feeBlocksMargin: DUST_FEE_BLOCKS_MARGIN,
    },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    provingServerUrl: new URL(networkConfig.proofServer),
    relayURL: new URL(networkConfig.node),
  };

  // The init factories hand back the wallets they build, so the bundle can
  // start a restored facade from seeds (see startFacade).
  let shielded: SeedStartable | undefined;
  let dust: SeedStartable | undefined;

  // Fresh build. The class-level startWithSeed derives and keeps both ledger
  // versions' keys, so the wallet can read whichever side of the fork the
  // chain is on. It doesn't start syncing; startFacade does that.
  const initFresh = () => WalletFacade.init({
    configuration,
    shielded: async (cfg) => (shielded = await ShieldedWallet(cfg).startWithSeed(seeds.shielded)),
    unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: async (cfg) => (dust = await DustWallet(cfg).startWithSeed(seeds.dust)),
  });

  // Bridge: if the dust-direct cache has a more recent DustLocalState than the
  // facade cache, overlay it into the facade cache's dust snapshot before
  // restore. This lets commands that use the facade (transfer, airdrop, dust
  // register) benefit from the indexer-direct reader's checkpoint without
  // re-implementing the whole transaction flow.
  const dustPublicKey = ledger.DustSecretKey.fromSeed(seeds.dust).publicKey;
  const effectiveCache = cache ? maybeBridgeDustCache(cache, networkConfig, dustPublicKey) : null;

  // Attempt cache restore — fall back to fresh build on any deserialization error.
  let restoredFromCache = false;
  let facade: WalletFacade;

  if (effectiveCache) {
    verbose('facade', 'Restoring from cache...');
    try {
      facade = await WalletFacade.init({
        configuration,
        shielded: (cfg) => (shielded = ShieldedWallet(cfg).restore(effectiveCache.shielded)),
        unshielded: (cfg) => UnshieldedWallet(cfg).restore(effectiveCache.unshielded),
        dust: (cfg) => (dust = DustWallet(cfg).restore(effectiveCache.dust)),
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

  if (!shielded || !dust) {
    throw new Error('Wallet facade was built without its shielded or dust wallet');
  }
  return { facade, keystore, seeds, seedStartable: { shielded, dust }, restoredFromCache };
}

/**
 * Start the facade's wallets and background sync, exactly once.
 *
 * A fresh facade takes the SDK's own path. Its wallets already hold both
 * ledger versions' keys, and `facade.start` adds the ledger-v9 ones.
 *
 * A restored facade can't take that path. A snapshot carries no keys, and
 * `facade.start` only supplies ledger-v9 keys, which can't drive a wallet
 * restored onto the ledger-v8 variant. So the shielded and dust wallets are
 * started from their seeds instead, which covers both ledger versions.
 * Starting a wallet twice runs two sync streams against the same state, so
 * this replaces `facade.start` rather than following it, and starts the same
 * four things it does.
 */
async function startFacade(bundle: FacadeBundle): Promise<void> {
  const { facade, seeds, seedStartable } = bundle;
  if (!bundle.restoredFromCache) {
    await facade.start(seeds);
    return;
  }
  await Promise.all([
    seedStartable.shielded.startWithSeed(seeds.shielded),
    facade.unshielded.start(),
    seedStartable.dust.startWithSeed(seeds.dust),
    facade.pendingTransactionsService.start(),
  ]);
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
// dust-wallet/src/v2/Serialization.ts `SnapshotSchema` — JSON on disk with
// BigInts rendered as decimal strings. The `state` field is a hex-encoded
// `DustLocalState.serialize()` (ledger-v9) — the same blob the dust-direct
// cache stores, which is why the two are interchangeable via the overlay below.
export interface FacadeDustSnapshot {
  publicKey: { publicKey: string };
  state: string;
  protocolVersion: string;
  networkId: string;
  offset?: string;
}

/**
 * Overlay a dust-direct checkpoint onto a facade dust snapshot: swap in the
 * `DustLocalState` from the indexer-direct reader and set the offset to its last
 * applied event id. Keeps publicKey/protocolVersion/networkId from the base
 * snapshot untouched. This is an UNCONDITIONAL overlay — whether the dust-direct
 * state is the one you want is the caller's policy (see `maybeBridgeDustCache`'s
 * freshness guard, and `dust export`'s "any events applied?" check). Overlaying
 * must not itself decide to skip: a base facade snapshot always carries
 * `offset:"0"`, which would otherwise collide with a genuine checkpoint at id 0.
 *
 * This is the seam that lets a facade restore from the fast dust-direct sync:
 * `maybeBridgeDustCache` uses it to speed up write commands, and `dust export`
 * uses it to hand a restorable snapshot to other wallets (e.g. a dApp operator).
 */
export function overlayDustDirectSnapshot(
  dustSnapshotJson: string,
  direct: Pick<DustCacheEntry, 'state' | 'lastAppliedEventId'>,
): string {
  const snapshot: FacadeDustSnapshot = JSON.parse(dustSnapshotJson);
  // The wallet restores a snapshot onto the variant its protocolVersion names.
  // A ledger-9 state in a snapshot stamped below the fork would be read by the
  // ledger-8 variant (e.g. a facade that started on V1 when the probe failed).
  if (BigInt(snapshot.protocolVersion) < FORK_SCHEDULE.v9) {
    throw new Error(
      `Can't put a ledger-9 dust state into a snapshot at protocol version ${snapshot.protocolVersion}: ` +
      `the wallet would read it as ledger 8 (fork at ${FORK_SCHEDULE.v9}).`,
    );
  }
  snapshot.state = Buffer.from(direct.state.serialize()).toString('hex');
  snapshot.offset = direct.lastAppliedEventId.toString();
  return JSON.stringify(snapshot);
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

    // Only overlay when dust-direct is AHEAD of the facade cache's own offset — a prior
    // write may have advanced the facade past our indexer-direct checkpoint, and we must
    // not roll it back.
    const snapshot: FacadeDustSnapshot = JSON.parse(cache.dust);
    const facadeOffset = snapshot.offset !== undefined ? Number(snapshot.offset) : -1;
    if (facadeOffset >= direct.lastAppliedEventId) {
      verbose('facade', `Facade dust offset=${facadeOffset} >= dust-direct offset=${direct.lastAppliedEventId}; skipping bridge`);
      return cache;
    }
    verbose('facade', `Bridged dust-direct cache (facade offset ${facadeOffset} → dust-direct offset ${direct.lastAppliedEventId})`);
    return { ...cache, dust: overlayDustDirectSnapshot(cache.dust, direct) };
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
/** The index fields of a shielded or dust wallet's sync progress (bigints in the SDK). */
interface IndexProgress {
  isStrictlyComplete(): boolean;
  readonly appliedIndex: bigint;
  readonly highestRelevantWalletIndex: bigint;
}

/**
 * Dust is caught up when it's strictly complete, or when its indices show it
 * is despite the `isConnected` bug above. A wallet with no dust events at all
 * (0/0) counts as caught up once unshielded is, because there's nothing to sync.
 */
function isDustCaughtUp(dust: IndexProgress, unshieldedOk: boolean): boolean {
  if (dust.isStrictlyComplete()) return true;
  if (dust.highestRelevantWalletIndex > 0n && dust.appliedIndex >= dust.highestRelevantWalletIndex) return true;
  return isUntouched(dust) && unshieldedOk;
}

/** No events have reached this wallet yet: nothing applied, nothing relevant. */
function isUntouched(progress: IndexProgress): boolean {
  return progress.highestRelevantWalletIndex === 0n && progress.appliedIndex === 0n;
}

export function isFacadeSynced(state: FacadeState, syncMode: SyncMode = 'full'): boolean {
  const unshieldedOk = state.unshielded.progress.isStrictlyComplete();
  const dustOk = syncMode === 'no-dust' || isDustCaughtUp(state.dust.progress, unshieldedOk);

  if (syncMode === 'lite') {
    return unshieldedOk && dustOk;
  }

  // Same pattern for shielded: an unfunded wallet has no zswap events.
  const shielded = state.shielded.progress;
  const shieldedOk = shielded.isStrictlyComplete() || (unshieldedOk && isUntouched(shielded));

  return shieldedOk && unshieldedOk && dustOk;
}

/** Check if dust wallet sync is pending (for diagnostics). */
function isDustSyncPending(state: FacadeState): boolean {
  return !isDustCaughtUp(state.dust.progress, state.unshielded.progress.isStrictlyComplete());
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
  const { facade } = bundle;

  verbose('sync', 'Starting facade (connecting to node and indexer)...');
  await startFacade(bundle);
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
            const up = lastState.unshielded.progress;
            verbose('sync', `  unshielded: applied=${up.appliedId} highest=${up.highestTransactionId} complete=${up.isStrictlyComplete()}`);
            const dp = lastState.dust.progress;
            verbose('sync', `  dust: applied=${dp.appliedIndex} highest=${dp.highestRelevantWalletIndex} complete=${dp.isStrictlyComplete()} connected=${dp.isConnected}`);
            if (syncMode === 'full') {
              const sp = lastState.shielded.progress;
              verbose('sync', `  shielded: complete=${sp.isStrictlyComplete()}`);
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
          if ((syncMode === 'full' || syncMode === 'no-dust') && !state.shielded.progress.isStrictlyComplete()) pending.push('shielded');
          if (syncMode !== 'no-dust' && isDustSyncPending(state)) pending.push('dust');
          if (!state.unshielded.progress.isStrictlyComplete()) pending.push('unshielded');
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
export function detectStaleCache(state: FacadeState): string | undefined {
  const { appliedId: applied, highestTransactionId: highest } = state.unshielded.progress;
  // We require highest > 0 to ensure the indexer has reported at least once;
  // otherwise we can't make a reliable comparison. applied > highest means
  // our local state has applied events the chain doesn't have.
  if (highest > 0n && applied > highest) {
    return `unshielded cache applied=${applied} but chain highest=${highest}.`;
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
    const unshieldedOk = s.unshielded.progress.isStrictlyComplete();
    const dustOk = s.dust.progress.isStrictlyComplete();
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
/** Whether the wallet holds dust it can spend on fees right now. */
export function hasDustAvailable(state: FacadeState): boolean {
  return state.dust.availableCoins.length > 0 || state.dust.balance(new Date()) > 0n;
}

export async function waitForDustAvailable(bundle: FacadeBundle, timeoutMs = 60_000): Promise<FacadeState> {

  try {
    return await rx.firstValueFrom(
      bundle.facade.state().pipe(
        rx.filter(hasDustAvailable),
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
