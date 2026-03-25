import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
  InMemoryTransactionHistoryStorage,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { WalletFacade, type FacadeState } from '@midnight-ntwrk/wallet-sdk-facade';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';
import * as rx from 'rxjs';

import { type NetworkConfig } from './network.ts';
import { deriveShieldedSeed, deriveUnshieldedSeed, deriveDustSeed } from './derivation.ts';
import { type WalletCacheData } from './wallet-cache.ts';
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

export type SyncMode = 'full' | 'lite';

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
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
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

  // Attempt cache restore — fall back to fresh build on any deserialization error.
  let restoredFromCache = false;
  let facade: WalletFacade;

  if (cache) {
    verbose('facade', 'Restoring from cache...');
    try {
      facade = await WalletFacade.init({
        configuration,
        shielded: (cfg) => ShieldedWallet(cfg).restore(cache.shielded),
        unshielded: (cfg) => UnshieldedWallet(cfg).restore(cache.unshielded),
        dust: (cfg) => DustWallet(cfg).restore(cache.dust),
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

  // For dust: try isStrictlyComplete first; if it fails due to isConnected bug,
  // fall back to checking index values directly.
  let dustOk = state.dust?.state?.progress?.isStrictlyComplete() ?? false;
  if (!dustOk) {
    try {
      const p = state.dust?.state?.progress as any;
      // Guard: only use the index fallback when highestRelevantWalletIndex > 0.
      // Both indices start at 0 before the indexer reports event counts, so
      // without this guard, 0 >= 0 fires immediately on the first emission
      // before any dust events have been processed.
      if (p && p.highestRelevantWalletIndex > 0 && p.appliedIndex >= p.highestRelevantWalletIndex) {
        dustOk = true;
      }
    } catch { /* best-effort */ }
  }

  if (syncMode === 'lite') {
    return unshieldedOk && dustOk;
  }

  const shieldedOk = state.shielded?.state?.progress?.isStrictlyComplete() ?? false;
  return shieldedOk && unshieldedOk && dustOk;
}

/** Check if dust wallet sync is pending (for diagnostics). */
function isDustSyncPending(state: FacadeState): boolean {
  if (state.dust?.state?.progress?.isStrictlyComplete()) return false;
  try {
    const p = state.dust?.state?.progress as any;
    if (p && p.highestRelevantWalletIndex > 0 && p.appliedIndex >= p.highestRelevantWalletIndex) return false;
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
}

export async function startAndSyncFacade(
  bundle: FacadeBundle,
  options: SyncOptions = {},
): Promise<FacadeState> {
  const { onProgress, onSyncDetail, timeoutMs, syncMode = 'full' } = options;
  const { facade, zswapSecretKeys, dustSecretKey } = bundle;

  verbose('sync', 'Starting facade (connecting to node and indexer)...');
  await facade.start(zswapSecretKeys, dustSecretKey);
  verbose('sync', 'Facade started, subscribing to state...');

  const effectiveTimeout = timeoutMs ?? SYNC_TIMEOUT_MS;
  verbose('sync', `Sync timeout: ${effectiveTimeout / 1000}s, mode: ${syncMode}`);

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

        // Report unshielded progress
        if (onProgress) {
          const progress = state.unshielded.progress;
          if (progress) {
            const applied = Number(progress.appliedId);
            const highest = Number(progress.highestTransactionId);
            onProgress(Math.min(applied, highest), highest);
          }
        }

        // Report which wallets are still syncing
        const pending: string[] = [];
        try {
          if (syncMode === 'full' && !state.shielded?.state?.progress?.isStrictlyComplete()) pending.push('shielded');
          if (isDustSyncPending(state)) pending.push('dust');
          if (!state.unshielded?.progress?.isStrictlyComplete()) pending.push('unshielded');
        } catch { /* best-effort */ }

        if (pending.length > 0) {
          onSyncDetail?.(pending.join(', '));
          // Only log verbose on first emission, when pending wallets change, or every 100th
          const pendingKey = pending.join(',');
          if (emissionCount === 1 || pendingKey !== lastPendingKey || emissionCount % 100 === 0) {
            verbose('sync', `Waiting on: ${pending.join(', ')} (emission #${emissionCount})`);
            lastPendingKey = pendingKey;
          }
        }

        // Resolve when synced (uses custom predicate to work around
        // dust wallet isConnected bug — see isFacadeSynced above)
        if (isFacadeSynced(state, syncMode)) {
          resolved = true;
          clearTimeout(timeout);
          verbose('sync', `Sync complete after ${emissionCount} emissions`);
          resolve(state);
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
