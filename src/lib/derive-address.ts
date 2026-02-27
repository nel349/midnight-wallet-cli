// Address derivation helper — wraps HD derivation + keystore + PublicKey
// into a single call returning the bech32m address string.

import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { createKeystore, PublicKey } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';
import { type NetworkName } from './network.ts';

const NETWORK_ID_MAP: Record<NetworkName, NetworkId.NetworkId> = {
  preprod: NetworkId.NetworkId.PreProd,
  preview: NetworkId.NetworkId.Preview,
  undeployed: NetworkId.NetworkId.Undeployed,
};

/**
 * Derive an unshielded address from a seed buffer, network, and optional key index.
 * Path: m/44'/2400'/0'/NightExternal/<keyIndex>
 *
 * Returns the bech32m address string (e.g., mn_addr_preprod1...).
 */
export function deriveUnshieldedAddress(
  seedBuffer: Buffer,
  networkName: NetworkName,
  keyIndex: number = 0,
): string {
  const networkId = NETWORK_ID_MAP[networkName];

  const hdResult = HDWallet.fromSeed(seedBuffer);
  if (hdResult.type !== 'seedOk') {
    throw new Error('Invalid seed for HD wallet');
  }

  const derivation = hdResult.hdWallet
    .selectAccount(0)
    .selectRole(Roles.NightExternal)
    .deriveKeyAt(keyIndex);

  if (derivation.type === 'keyOutOfBounds') {
    throw new Error(`Key index ${keyIndex} out of bounds`);
  }

  const keystore = createKeystore(derivation.key, networkId);
  const publicKey = PublicKey.fromKeyStore(keystore);
  return publicKey.address;
}
