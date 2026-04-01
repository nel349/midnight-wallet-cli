// Contract providers — lightweight provider setup for state queries.
// Deploy/call use the runner (generated scripts in dApp context) which build their own providers.

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type { NetworkConfig } from '../network.ts';

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
