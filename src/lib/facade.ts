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
 * Start the facade and wait for initial sync.
 * Calls onProgress with sync progress updates.
 */
export async function startAndSyncFacade(
  bundle: FacadeBundle,
  onProgress?: (applied: number, highest: number) => void,
): Promise<FacadeState> {
  const { facade, zswapSecretKeys, dustSecretKey } = bundle;

  await facade.start(zswapSecretKeys, dustSecretKey);

  return rx.firstValueFrom(
    facade.state().pipe(
      rx.tap((state) => {
        if (onProgress) {
          const progress = state.unshielded.progress;
          if (progress) {
            onProgress(Number(progress.appliedId), Number(progress.highestTransactionId));
          }
        }
      }),
      rx.filter((state) => state.isSynced),
      rx.timeout(SYNC_TIMEOUT_MS),
    )
  );
}

/**
 * Quick sync for pre-send validation.
 * Shorter timeout — just catches stale UTXOs before building a transaction.
 */
export async function quickSync(bundle: FacadeBundle): Promise<FacadeState> {
  return rx.firstValueFrom(
    bundle.facade.state().pipe(
      rx.filter((state) => state.isSynced),
      rx.timeout(PRE_SEND_SYNC_TIMEOUT_MS),
    )
  );
}

/**
 * Clean shutdown of the wallet facade.
 */
export async function stopFacade(bundle: FacadeBundle): Promise<void> {
  await bundle.facade.stop();
}

/**
 * Suppress known transient SDK errors (e.g. Wallet.Sync: Internal Server Error)
 * that leak as unhandled promise rejections during facade operations.
 * The SDK retries internally — these are safe to suppress.
 *
 * Returns a cleanup function to remove the handler.
 */
export function suppressSdkTransientErrors(
  onWarning?: (tag: string, message: string) => void,
): () => void {
  const handler = (reason: unknown) => {
    const tag = (reason as any)?._tag;
    if (typeof tag === 'string' && tag.startsWith('Wallet.')) {
      const msg = (reason as any)?.message ?? 'transient error';
      onWarning?.(tag, msg);
      return;
    }
    // Not a known SDK error — mimic Node's default unhandled rejection behavior
    console.error('Unhandled rejection:', reason);
    process.exit(1);
  };

  process.on('unhandledRejection', handler);
  return () => {
    process.removeListener('unhandledRejection', handler);
  };
}
