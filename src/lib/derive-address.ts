// Address derivation helper — wraps HD derivation + keystore + PublicKey
// into a single call returning the bech32m address string.

import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { createKeystore, PublicKey } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from '@midnight-ntwrk/wallet-sdk-address-format';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { type NetworkName, getValidNetworkNames } from './network.ts';
import { deriveShieldedSeed } from './derivation.ts';

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

/**
 * Derive unshielded addresses for all supported networks from a single seed.
 * Returns a map of network name → bech32m address string.
 */
export function deriveAllAddresses(
  seedBuffer: Buffer,
  keyIndex: number = 0,
): Record<NetworkName, string> {
  const addresses = {} as Record<NetworkName, string>;
  for (const name of getValidNetworkNames()) {
    addresses[name as NetworkName] = deriveUnshieldedAddress(seedBuffer, name as NetworkName, keyIndex);
  }
  return addresses;
}

/**
 * Derive shielded (Zswap) addresses for all supported networks from a single seed.
 * The underlying keys are network-independent — only the bech32m prefix changes
 * per network (e.g. mn_shield-addr_preprod1..., mn_shield-addr_preview1...).
 *
 * Returns a map of network name → bech32m shielded address string.
 */
export function deriveAllShieldedAddresses(
  seedBuffer: Buffer,
): Record<NetworkName, string> {
  const shieldedSeed = deriveShieldedSeed(seedBuffer);
  const keys = ledger.ZswapSecretKeys.fromSeed(shieldedSeed);
  const address = new ShieldedAddress(
    new ShieldedCoinPublicKey(Buffer.from(keys.coinPublicKey, 'hex')),
    new ShieldedEncryptionPublicKey(Buffer.from(keys.encryptionPublicKey, 'hex')),
  );
  const out = {} as Record<NetworkName, string>;
  for (const name of getValidNetworkNames()) {
    const networkId = NETWORK_ID_MAP[name as NetworkName];
    out[name as NetworkName] = MidnightBech32m.encode(networkId, address).asString();
  }
  return out;
}
