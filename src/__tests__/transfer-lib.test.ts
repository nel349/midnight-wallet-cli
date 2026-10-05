import { describe, it, expect } from 'vitest';
import { nightToMicro, parseAmount, validateRecipientAddress, isDustRelatedError } from '../lib/transfer.ts';
import { getNetworkConfig } from '../lib/network.ts';
import { deriveUnshieldedAddress } from '../lib/derive-address.ts';
import { GENESIS_SEED, SYNC_ATTEMPT_TIMEOUT_MS, SYNC_ATTEMPT_REMOTE_TIMEOUT_MS } from '../lib/constants.ts';

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

describe('parseAmount: exact amounts only (NIGHT has 6 decimals)', () => {
  // Found live: "1.0000001" was accepted and 1.000000 NIGHT was sent; the
  // conversion rounds, so "1.0000005" would have sent 1.000001.
  it.each(['1.0000001', '1.0000005', '0.0000001'])('refuses %s: more decimals than NIGHT has', (input) => {
    expect(() => parseAmount(input)).toThrow(`Invalid amount: "${input}" — NIGHT has 6 decimals, this has 7`);
  });

  it.each(['1e3', '-5', '1,000', '0x10', 'Infinity', '.', '1.2.3', '+1'])('refuses %j: not a plain positive decimal', (input) => {
    expect(() => parseAmount(input)).toThrow(`Invalid amount: "${input}" — must be a positive number, e.g. 1.5`);
  });

  it('refuses an amount a number cannot carry to the exact smallest unit', () => {
    expect(() => parseAmount('24000000000.000001')).toThrow('too many digits to handle exactly');
  });

  it.each([
    ['1.000001', 1_000_001n], ['.5', 500_000n], ['1.', 1_000_000n], [' 2 ', 2_000_000n], ['999999999.999999', 999_999_999_999_999n],
  ] as const)('accepts %j as exactly %s micro-NIGHT', (input, micro) => {
    expect(nightToMicro(parseAmount(input))).toBe(micro);
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
    expect(() => parseAmount('-10')).toThrow('Invalid amount: "-10" — must be a positive number');
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

describe('isDustRelatedError', () => {
  it('matches "not enough dust" errors', () => {
    expect(isDustRelatedError(new Error('Not enough dust to pay fees'))).toBe(true);
  });

  it('matches "dust generated" errors', () => {
    expect(isDustRelatedError(new Error('dust generated capacity insufficient'))).toBe(true);
  });

  it('matches "insufficient funds" errors', () => {
    expect(isDustRelatedError(new Error('Insufficient funds: dust wallet sync timed out'))).toBe(true);
  });

  it('matches "no dust tokens" errors', () => {
    expect(isDustRelatedError(new Error('No dust tokens found in the wallet state'))).toBe(true);
  });

  it('matches transaction submission errors', () => {
    expect(isDustRelatedError(new Error('Transaction submission error'))).toBe(true);
  });

  it('matches errors with _tag TransactionInvalidError', () => {
    const err = new Error('fail');
    (err as any)._tag = 'TransactionInvalidError';
    expect(isDustRelatedError(err)).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isDustRelatedError(new Error('Network timeout'))).toBe(false);
    expect(isDustRelatedError(new Error('Invalid address format'))).toBe(false);
  });

  it('handles null/undefined errors', () => {
    expect(isDustRelatedError(null)).toBe(false);
    expect(isDustRelatedError(undefined)).toBe(false);
  });
});

describe('sync timeout constants', () => {
  it('remote timeout is longer than local timeout', () => {
    expect(SYNC_ATTEMPT_REMOTE_TIMEOUT_MS).toBeGreaterThan(SYNC_ATTEMPT_TIMEOUT_MS);
  });

  it('local timeout is 30 seconds', () => {
    expect(SYNC_ATTEMPT_TIMEOUT_MS).toBe(30_000);
  });

  it('remote timeout is 120 seconds', () => {
    expect(SYNC_ATTEMPT_REMOTE_TIMEOUT_MS).toBe(120_000);
  });
});
