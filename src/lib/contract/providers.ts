// Contract providers bridge — adapt mn's FacadeBundle to the SDK's MidnightProviders interface.
// This lets us use deployContract() and findDeployedContract() from @midnight-ntwrk/midnight-js-contracts.

import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { setNetworkId, type NetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { FacadeBundle } from '../facade.ts';
import type { NetworkConfig } from '../network.ts';

export interface ContractProviderOptions {
  bundle: FacadeBundle;
  networkConfig: NetworkConfig;
  managedDir: string;
  privateStateKey?: string;
}

/**
 * Build MidnightProviders from mn's existing wallet facade.
 * Bridges facade.balanceUnboundTransaction/signRecipe/finalizeRecipe/submitTransaction
 * to the walletProvider interface that SDK contract functions expect.
 */
export async function buildContractProviders(options: ContractProviderOptions): Promise<any> {
  const { bundle, networkConfig, managedDir, privateStateKey } = options;
  const { facade, zswapSecretKeys, dustSecretKey, keystore } = bundle;

  // SDK contract functions require the global network ID to be set
  setNetworkId(networkConfig.networkId as NetworkId);

  // Get synced state for shielded keys
  const state = await facade.waitForSyncedState();

  const zkConfigProvider = new NodeZkConfigProvider(managedDir);

  const walletProvider = {
    getCoinPublicKey: () => (state as any).shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => (state as any).shielded.encryptionPublicKey.toHexString(),

    async balanceTx(tx: any, ttl?: Date) {
      const secrets = { shieldedSecretKeys: zswapSecretKeys, dustSecretKey };
      const recipe = await facade.balanceUnboundTransaction(tx, secrets, {
        ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000),
      });

      // Sign the recipe
      const signFn = (payload: Uint8Array) => keystore.signData(payload);
      const signed = await facade.signRecipe(recipe, signFn);

      // Finalize (prove + build final tx)
      return await facade.finalizeRecipe(signed);
    },

    async submitTx(tx: any) {
      return await facade.submitTransaction(tx);
    },
  };

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: privateStateKey ?? 'mn-contract-state',
      privateStoragePasswordProvider: () => Promise.resolve('mn-contract-default-password'),
      accountId: keystore.getBech32Address().toString(),
    }),
    publicDataProvider: indexerPublicDataProvider(
      networkConfig.indexer,
      networkConfig.indexerWS ?? networkConfig.indexer.replace('http', 'ws'),
    ),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

/**
 * Build a lightweight indexer-only provider for state queries.
 * No wallet or proof server needed.
 */
export function buildStateProvider(networkConfig: NetworkConfig) {
  return indexerPublicDataProvider(
    networkConfig.indexer,
    networkConfig.indexerWS ?? networkConfig.indexer.replace('http', 'ws'),
  );
}
