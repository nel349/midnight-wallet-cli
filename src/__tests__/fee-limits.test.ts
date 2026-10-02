// Fee-wallet limits for `mn serve --approve-fees`: the most Dust one
// transaction may cost, and how many balanced-but-unsubmitted transactions
// may hold Dust at once. Amounts are exact: DUST has 15 decimals (specks).

import { describe, it, expect } from 'vitest';
import {
  parseDustAmount,
  parseFeeLimits,
  feeLimitRefusal,
  pendingLimitRefusal,
  DEFAULT_FEE_LIMITS,
  SPECKS_PER_DUST,
} from '../lib/fee-limits.ts';
import { UsageError } from '../lib/errors.ts';

describe('parseDustAmount', () => {
  it.each([
    ['1', SPECKS_PER_DUST],
    ['0.5', 500_000_000_000_000n],
    ['2.25', 2_250_000_000_000_000n],
    ['0.000000000000001', 1n],
    ['10', 10n * SPECKS_PER_DUST],
  ])('%s DUST is exactly %s specks', (input, specks) => {
    expect(parseDustAmount(input, '--max-fee')).toBe(specks);
  });

  it.each(['0', '0.0', '-1', 'abc', '1e3', '0.0000000000000001', '', ' ', '1.'])(
    'rejects %j, naming the flag',
    (input) => {
      expect(() => parseDustAmount(input, '--max-fee')).toThrow(UsageError);
      expect(() => parseDustAmount(input, '--max-fee')).toThrow('--max-fee');
    },
  );
});

describe('parseFeeLimits', () => {
  it('uses the defaults when no limit flags are given', () => {
    expect(parseFeeLimits(undefined, undefined)).toEqual(DEFAULT_FEE_LIMITS);
  });

  it('parses both flags', () => {
    expect(parseFeeLimits('0.25', '3')).toEqual({ maxFeeSpecks: 250_000_000_000_000n, maxPending: 3 });
  });

  it.each(['0', '-2', '1.5', 'x'])('rejects --max-pending %j (a whole number of at least 1)', (n) => {
    expect(() => parseFeeLimits(undefined, n)).toThrow(/--max-pending/);
  });
});

describe('feeLimitRefusal', () => {
  const limits = { maxFeeSpecks: SPECKS_PER_DUST, maxPending: 2 };

  it('allows a fee at or under the cap', () => {
    expect(feeLimitRefusal(SPECKS_PER_DUST, limits)).toBeUndefined();
    expect(feeLimitRefusal(1n, limits)).toBeUndefined();
  });

  it('refuses a fee over the cap, stating both amounts in DUST', () => {
    expect(feeLimitRefusal(SPECKS_PER_DUST + 1n, limits))
      .toBe('the estimated fee 1.000000000000001 DUST is over --max-fee 1.000000 DUST');
  });
});

describe('pendingLimitRefusal', () => {
  const limits = { maxFeeSpecks: SPECKS_PER_DUST, maxPending: 2 };

  it('allows a new balance below the limit', () => {
    expect(pendingLimitRefusal(0, limits)).toBeUndefined();
    expect(pendingLimitRefusal(1, limits)).toBeUndefined();
  });

  it('refuses once the limit of unsubmitted transactions is reached', () => {
    expect(pendingLimitRefusal(2, limits))
      .toBe('2 balanced transactions are still waiting to be submitted (--max-pending 2)');
  });
});
