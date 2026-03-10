import { describe, it, expect } from 'vitest';
import { reviveBalanceRecord, reviveDustBalance } from '../bigint.ts';

describe('reviveBalanceRecord', () => {
  it('converts all string values to bigint', () => {
    const input = {
      '0000000000000000000000000000000000000000000000000000000000000000': '5000000',
      'aabbccdd': '123456789012345678',
    };
    const result = reviveBalanceRecord(input);

    expect(result['0000000000000000000000000000000000000000000000000000000000000000']).toBe(5000000n);
    expect(result['aabbccdd']).toBe(123456789012345678n);
  });

  it('handles empty record', () => {
    const result = reviveBalanceRecord({});
    expect(result).toEqual({});
  });

  it('handles zero values', () => {
    const result = reviveBalanceRecord({ token: '0' });
    expect(result.token).toBe(0n);
  });

  it('handles very large values', () => {
    const result = reviveBalanceRecord({ token: '999999999999999999999999' });
    expect(result.token).toBe(999999999999999999999999n);
  });
});

describe('reviveDustBalance', () => {
  it('converts cap and balance to bigint', () => {
    const result = reviveDustBalance({ cap: '300000000000000', balance: '150000000000000' });
    expect(result.cap).toBe(300000000000000n);
    expect(result.balance).toBe(150000000000000n);
  });

  it('handles zero values', () => {
    const result = reviveDustBalance({ cap: '0', balance: '0' });
    expect(result.cap).toBe(0n);
    expect(result.balance).toBe(0n);
  });
});
