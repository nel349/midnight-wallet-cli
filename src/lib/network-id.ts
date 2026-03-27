// Shared NetworkId mapping — used by facade, transfer, dapp-connector, balance, etc.

import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';

const NETWORK_ID_MAP: Record<string, NetworkId.NetworkId> = {
  PreProd: NetworkId.NetworkId.PreProd,
  Preview: NetworkId.NetworkId.Preview,
  Undeployed: NetworkId.NetworkId.Undeployed,
};

/**
 * Get the SDK NetworkId enum from a network config string (e.g. 'Undeployed').
 * Throws if the networkId is unknown.
 */
export function getNetworkId(networkIdStr: string): NetworkId.NetworkId {
  const id = NETWORK_ID_MAP[networkIdStr];
  if (id === undefined) {
    throw new Error(`Unknown networkId: ${networkIdStr}`);
  }
  return id;
}
