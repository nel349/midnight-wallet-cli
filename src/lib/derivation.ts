import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';

/**
 * Derive a key from the HD wallet for a given role.
 * All derivations use account=0, index=0.
 * Path: m/44'/2400'/0'/<role>/0
 */
function deriveKey(seedBuffer: Buffer, role: typeof Roles[keyof typeof Roles]): Uint8Array {
  const hdResult = HDWallet.fromSeed(seedBuffer);
  if (hdResult.type !== 'seedOk') {
    throw new Error('Invalid seed for HD wallet');
  }

  const derivation = hdResult.hdWallet.selectAccount(0).selectRole(role).deriveKeyAt(0);
  if (derivation.type === 'keyOutOfBounds') {
    throw new Error('Key derivation out of bounds');
  }

  return derivation.key;
}

/**
 * Derive shielded (Zswap) seed for ZK proofs.
 */
export function deriveShieldedSeed(seedBuffer: Buffer): Uint8Array {
  return deriveKey(seedBuffer, Roles.Zswap);
}

/**
 * Derive unshielded (NightExternal) seed for NIGHT transfers.
 */
export function deriveUnshieldedSeed(seedBuffer: Buffer): Uint8Array {
  return deriveKey(seedBuffer, Roles.NightExternal);
}

/**
 * Derive dust seed for fee token generation.
 */
export function deriveDustSeed(seedBuffer: Buffer): Uint8Array {
  return deriveKey(seedBuffer, Roles.Dust);
}
