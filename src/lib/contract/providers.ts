// Contract providers — lightweight provider setup for state queries.
// Deploy/call use the runner (generated scripts in dApp context) which build their own providers.

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { assertEndpointUsable } from '../blockfrost.ts';
import type { NetworkConfig } from '../network.ts';

/**
 * Build a lightweight indexer-only provider for state queries.
 * No wallet or proof server needed.
 */
export function buildStateProvider(networkConfig: NetworkConfig) {
  assertEndpointUsable(networkConfig.indexer);
  return indexerPublicDataProvider({
    queryURL: networkConfig.indexer,
    subscriptionURL: networkConfig.indexerWS ?? networkConfig.indexer.replace('http', 'ws'),
  });
}
