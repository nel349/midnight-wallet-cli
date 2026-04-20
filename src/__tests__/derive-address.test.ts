import { describe, it, expect } from 'vitest';
import { deriveUnshieldedAddress, deriveAllShieldedAddresses } from '../lib/derive-address.ts';
import { GENESIS_SEED } from '../lib/constants.ts';

const genesisSeedBuffer = Buffer.from(GENESIS_SEED, 'hex');

describe('deriveUnshieldedAddress', () => {
  it('derives a preprod address with correct prefix', () => {
    const address = deriveUnshieldedAddress(genesisSeedBuffer, 'preprod');
    expect(address.startsWith('mn_addr_preprod1')).toBe(true);
  });

  it('derives a preview address with correct prefix', () => {
    const address = deriveUnshieldedAddress(genesisSeedBuffer, 'preview');
    expect(address.startsWith('mn_addr_preview1')).toBe(true);
  });

  it('derives an undeployed address with correct prefix', () => {
    const address = deriveUnshieldedAddress(genesisSeedBuffer, 'undeployed');
    expect(address.startsWith('mn_addr_undeployed1')).toBe(true);
  });

  it('same seed + network produces the same address', () => {
    const a = deriveUnshieldedAddress(genesisSeedBuffer, 'preprod');
    const b = deriveUnshieldedAddress(genesisSeedBuffer, 'preprod');
    expect(a).toBe(b);
  });

  it('different networks produce different addresses', () => {
    const preprod = deriveUnshieldedAddress(genesisSeedBuffer, 'preprod');
    const preview = deriveUnshieldedAddress(genesisSeedBuffer, 'preview');
    const undeployed = deriveUnshieldedAddress(genesisSeedBuffer, 'undeployed');
    expect(preprod).not.toBe(preview);
    expect(preprod).not.toBe(undeployed);
    expect(preview).not.toBe(undeployed);
  });

  it('different seeds produce different addresses', () => {
    const seedA = Buffer.from(GENESIS_SEED, 'hex');
    const seedB = Buffer.from('0000000000000000000000000000000000000000000000000000000000000002', 'hex');
    const addrA = deriveUnshieldedAddress(seedA, 'undeployed');
    const addrB = deriveUnshieldedAddress(seedB, 'undeployed');
    expect(addrA).not.toBe(addrB);
  });

  it('supports custom key index', () => {
    const index0 = deriveUnshieldedAddress(genesisSeedBuffer, 'undeployed', 0);
    const index1 = deriveUnshieldedAddress(genesisSeedBuffer, 'undeployed', 1);
    expect(index0).not.toBe(index1);
    expect(index1.startsWith('mn_addr_undeployed1')).toBe(true);
  });

  it('default key index is 0', () => {
    const withDefault = deriveUnshieldedAddress(genesisSeedBuffer, 'undeployed');
    const withExplicit = deriveUnshieldedAddress(genesisSeedBuffer, 'undeployed', 0);
    expect(withDefault).toBe(withExplicit);
  });

  it('handles all-zeros seed without throwing', () => {
    // The SDK accepts all-zeros as a valid seed
    const zeroSeed = Buffer.alloc(32, 0);
    const address = deriveUnshieldedAddress(zeroSeed, 'undeployed');
    expect(address.startsWith('mn_addr_undeployed1')).toBe(true);
  });

  it('throws for empty seed', () => {
    const emptySeed = Buffer.alloc(0);
    expect(() => deriveUnshieldedAddress(emptySeed, 'undeployed')).toThrow();
  });
});

describe('deriveAllShieldedAddresses', () => {
  it('returns one shielded address per supported network', () => {
    const out = deriveAllShieldedAddresses(genesisSeedBuffer);
    expect(Object.keys(out).sort()).toEqual(['preprod', 'preview', 'undeployed']);
  });

  it('each address has the correct network prefix', () => {
    const out = deriveAllShieldedAddresses(genesisSeedBuffer);
    expect(out.preprod.startsWith('mn_shield-addr_preprod1')).toBe(true);
    expect(out.preview.startsWith('mn_shield-addr_preview1')).toBe(true);
    expect(out.undeployed.startsWith('mn_shield-addr_undeployed1')).toBe(true);
  });

  it('addresses differ across networks', () => {
    const out = deriveAllShieldedAddresses(genesisSeedBuffer);
    expect(out.preprod).not.toBe(out.preview);
    expect(out.preprod).not.toBe(out.undeployed);
    expect(out.preview).not.toBe(out.undeployed);
  });

  it('is deterministic for a fixed seed', () => {
    const a = deriveAllShieldedAddresses(genesisSeedBuffer);
    const b = deriveAllShieldedAddresses(genesisSeedBuffer);
    expect(a).toEqual(b);
  });

  it('different seeds produce different shielded addresses', () => {
    const seedA = Buffer.from(GENESIS_SEED, 'hex');
    const seedB = Buffer.from('0000000000000000000000000000000000000000000000000000000000000002', 'hex');
    const outA = deriveAllShieldedAddresses(seedA);
    const outB = deriveAllShieldedAddresses(seedB);
    expect(outA.undeployed).not.toBe(outB.undeployed);
  });
});
