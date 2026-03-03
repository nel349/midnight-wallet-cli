import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
  InMemoryTransactionHistoryStorage,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { WalletFacade, type FacadeState } from '@midnight-ntwrk/wallet-sdk-facade';
import * as ledger from '@midnight-ntwrk/ledger-v7';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';
import * as rx from 'rxjs';

import { type NetworkConfig } from './network.ts';
import { deriveShieldedSeed, deriveUnshieldedSeed, deriveDustSeed } from './derivation.ts';
import {
  DUST_COST_OVERHEAD,
  DUST_FEE_BLOCKS_MARGIN,
  SYNC_TIMEOUT_MS,
  PRE_SEND_SYNC_TIMEOUT_MS,
} from './constants.ts';

const NETWORK_ID_MAP: Record<string, NetworkId.NetworkId> = {
  PreProd: NetworkId.NetworkId.PreProd,
  Preview: NetworkId.NetworkId.Preview,
  Undeployed: NetworkId.NetworkId.Undeployed,
};

export interface FacadeBundle {
  facade: WalletFacade;
  keystore: ReturnType<typeof createKeystore>;
  zswapSecretKeys: ReturnType<typeof ledger.ZswapSecretKeys.fromSeed>;
  dustSecretKey: ReturnType<typeof ledger.DustSecretKey.fromSeed>;
  /** Active subscription that keeps shareReplay buffers alive. Cleaned up by stopFacade. */
  keepAlive?: rx.Subscription;
}

/**
 * Build a complete WalletFacade from a seed and network config.
 * Returns the facade plus all keys needed for signing and proving.
 */
export function buildFacade(seedBuffer: Buffer, networkConfig: NetworkConfig): FacadeBundle {
  const networkId = NETWORK_ID_MAP[networkConfig.networkId];
  if (networkId === undefined) {
    throw new Error(`Unknown networkId: ${networkConfig.networkId}`);
  }

  const shieldedSeed = deriveShieldedSeed(seedBuffer);
  const unshieldedSeed = deriveUnshieldedSeed(seedBuffer);
  const dustSeed = deriveDustSeed(seedBuffer);

  const zswapSecretKeys = ledger.ZswapSecretKeys.fromSeed(shieldedSeed);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(dustSeed);
  const keystore = createKeystore(unshieldedSeed, networkId);

  const shieldedConfig = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: networkConfig.indexer,
      indexerWsUrl: networkConfig.indexerWS,
    },
    provingServerUrl: new URL(networkConfig.proofServer),
    relayURL: new URL(networkConfig.node),
  };

  const unshieldedConfig = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: networkConfig.indexer,
      indexerWsUrl: networkConfig.indexerWS,
    },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
  };

  const dustConfig = {
    networkId,
    costParameters: {
      additionalFeeOverhead: DUST_COST_OVERHEAD,
      feeBlocksMargin: DUST_FEE_BLOCKS_MARGIN,
    },
    indexerClientConnection: {
      indexerHttpUrl: networkConfig.indexer,
      indexerWsUrl: networkConfig.indexerWS,
    },
    provingServerUrl: new URL(networkConfig.proofServer),
    relayURL: new URL(networkConfig.node),
  };

  const shieldedWallet = ShieldedWallet(shieldedConfig).startWithSecretKeys(zswapSecretKeys);
  const unshieldedWallet = UnshieldedWallet(unshieldedConfig).startWithPublicKey(
    PublicKey.fromKeyStore(keystore)
  );
  const dustWallet = DustWallet(dustConfig).startWithSecretKey(
    dustSecretKey,
    ledger.LedgerParameters.initialParameters().dust
  );

  const facade = new WalletFacade(shieldedWallet, unshieldedWallet, dustWallet);

  return { facade, keystore, zswapSecretKeys, dustSecretKey };
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
function isFacadeSynced(state: FacadeState): boolean {
  const shieldedOk = state.shielded?.state?.progress?.isStrictlyComplete() ?? false;
  const unshieldedOk = state.unshielded?.progress?.isStrictlyComplete() ?? false;

  // For dust: try isStrictlyComplete first; if it fails due to isConnected bug,
  // fall back to checking index values directly.
  let dustOk = state.dust?.state?.progress?.isStrictlyComplete() ?? false;
  if (!dustOk) {
    try {
      const p = state.dust?.state?.progress as any;
      if (p && p.appliedIndex >= p.highestRelevantWalletIndex) {
        dustOk = true;
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
    if (p && p.appliedIndex >= p.highestRelevantWalletIndex) return false;
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
export async function startAndSyncFacade(
  bundle: FacadeBundle,
  onProgress?: (applied: number, highest: number) => void,
  onSyncDetail?: (detail: string) => void,
  timeoutMs?: number,
): Promise<FacadeState> {
  const { facade, zswapSecretKeys, dustSecretKey } = bundle;

  await facade.start(zswapSecretKeys, dustSecretKey);

  return new Promise<FacadeState>((resolve, reject) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) reject(new Error('Wallet sync timed out'));
    }, timeoutMs ?? SYNC_TIMEOUT_MS);

    bundle.keepAlive = facade.state().subscribe({
      next: (state) => {
        if (resolved) return;

        // Report unshielded progress
        if (onProgress) {
          const progress = state.unshielded.progress;
          if (progress) {
            const applied = Number(progress.appliedId);
            const highest = Number(progress.highestTransactionId);
            onProgress(Math.min(applied, highest), highest);
          }
        }

        // Report which wallets are still syncing (diagnostic)
        if (onSyncDetail) {
          try {
            const pending: string[] = [];
            if (!state.shielded?.state?.progress?.isStrictlyComplete()) pending.push('shielded');
            if (isDustSyncPending(state)) pending.push('dust');
            if (!state.unshielded?.progress?.isStrictlyComplete()) pending.push('unshielded');
            if (pending.length > 0) onSyncDetail(pending.join(', '));
          } catch { /* best-effort diagnostic */ }
        }

        // Resolve when fully synced (uses custom predicate to work around
        // dust wallet isConnected bug — see isFacadeSynced above)
        if (isFacadeSynced(state)) {
          resolved = true;
          clearTimeout(timeout);
          resolve(state);
        }
      },
      error: (err) => {
        if (!resolved) {
          clearTimeout(timeout);
          reject(err);
        }
      },
    });
  });
}

/**
 * Quick sync for pre-send validation.
 * Shorter timeout — just catches stale UTXOs before building a transaction.
 */
export async function quickSync(bundle: FacadeBundle): Promise<FacadeState> {
  return rx.firstValueFrom(
    bundle.facade.state().pipe(
      rx.filter((state) => isFacadeSynced(state)),
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
