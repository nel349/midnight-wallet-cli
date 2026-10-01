// Shared NetworkId mapping — the one place that turns mn's network names
// into the SDK's NetworkId values.

import { NetworkId } from '@midnightntwrk/wallet-sdk';
import type { NetworkName } from './network.ts';

const NETWORK_ID_MAP: Record<string, NetworkId.NetworkId> = {
  PreProd: NetworkId.NetworkId.PreProd,
  Preview: NetworkId.NetworkId.Preview,
  Undeployed: NetworkId.NetworkId.Undeployed,
};

const NETWORK_ID_BY_NAME: Record<NetworkName, NetworkId.NetworkId> = {
  preprod: NetworkId.NetworkId.PreProd,
  preview: NetworkId.NetworkId.Preview,
  undeployed: NetworkId.NetworkId.Undeployed,
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

/** Get the SDK NetworkId for one of mn's network names (e.g. 'undeployed'). */
export function networkIdForName(name: NetworkName): NetworkId.NetworkId {
  return NETWORK_ID_BY_NAME[name];
}
