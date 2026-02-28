import { describe, it, expect } from 'vitest';
import { nightToMicro, parseAmount, validateRecipientAddress } from '../lib/transfer.ts';
import { getNetworkConfig } from '../lib/network.ts';
import { deriveUnshieldedAddress } from '../lib/derive-address.ts';
import { GENESIS_SEED } from '../lib/constants.ts';

describe('nightToMicro', () => {
  it('converts whole NIGHT to micro-NIGHT', () => {
    expect(nightToMicro(1)).toBe(1_000_000n);
    expect(nightToMicro(100)).toBe(100_000_000n);
    expect(nightToMicro(1000)).toBe(1_000_000_000n);
  });

  it('converts fractional NIGHT to micro-NIGHT', () => {
    expect(nightToMicro(0.5)).toBe(500_000n);
    expect(nightToMicro(0.000001)).toBe(1n);
    expect(nightToMicro(1.5)).toBe(1_500_000n);
    expect(nightToMicro(0.123456)).toBe(123_456n);
  });

  it('throws for zero amount', () => {
    expect(() => nightToMicro(0)).toThrow('greater than 0');
  });

  it('throws for negative amount', () => {
    expect(() => nightToMicro(-1)).toThrow('greater than 0');
  });

  it('throws for Infinity', () => {
    expect(() => nightToMicro(Infinity)).toThrow('finite number');
  });

  it('throws for NaN', () => {
    expect(() => nightToMicro(NaN)).toThrow('finite number');
  });

  it('handles large amounts', () => {
    expect(nightToMicro(999_999)).toBe(999_999_000_000n);
  });
});

describe('parseAmount', () => {
  it('parses integer amounts', () => {
    expect(parseAmount('100')).toBe(100);
    expect(parseAmount('1')).toBe(1);
    expect(parseAmount('1000000')).toBe(1_000_000);
  });

  it('parses decimal amounts', () => {
    expect(parseAmount('0.5')).toBe(0.5);
    expect(parseAmount('1.23')).toBe(1.23);
    expect(parseAmount('0.000001')).toBe(0.000001);
  });

  it('throws for non-numeric strings', () => {
    expect(() => parseAmount('abc')).toThrow('Invalid amount');
    expect(() => parseAmount('')).toThrow('Invalid amount');
    expect(() => parseAmount('hello')).toThrow('Invalid amount');
  });

  it('throws for zero', () => {
    expect(() => parseAmount('0')).toThrow('greater than 0');
  });

  it('throws for negative amounts', () => {
    expect(() => parseAmount('-10')).toThrow('greater than 0');
  });

  it('throws for Infinity', () => {
    expect(() => parseAmount('Infinity')).toThrow('Invalid amount');
  });
});

describe('validateRecipientAddress', () => {
  const genesisSeed = Buffer.from(GENESIS_SEED, 'hex');

  it('accepts a valid undeployed address', () => {
    const address = deriveUnshieldedAddress(genesisSeed, 'undeployed');
    const config = getNetworkConfig('undeployed');
    expect(() => validateRecipientAddress(address, config)).not.toThrow();
  });

  it('accepts a valid preprod address', () => {
    const address = deriveUnshieldedAddress(genesisSeed, 'preprod');
    const config = getNetworkConfig('preprod');
    expect(() => validateRecipientAddress(address, config)).not.toThrow();
  });

  it('accepts a valid preview address', () => {
    const address = deriveUnshieldedAddress(genesisSeed, 'preview');
    const config = getNetworkConfig('preview');
    expect(() => validateRecipientAddress(address, config)).not.toThrow();
  });

  it('rejects an address for the wrong network', () => {
    const preprodAddr = deriveUnshieldedAddress(genesisSeed, 'preprod');
    const undeployedConfig = getNetworkConfig('undeployed');
    expect(() => validateRecipientAddress(preprodAddr, undeployedConfig)).toThrow('Invalid recipient address');
  });

  it('rejects a garbage string', () => {
    const config = getNetworkConfig('undeployed');
    expect(() => validateRecipientAddress('not-an-address', config)).toThrow('Invalid recipient address');
  });

  it('rejects an empty string', () => {
    const config = getNetworkConfig('undeployed');
    expect(() => validateRecipientAddress('', config)).toThrow('Invalid recipient address');
  });
});
