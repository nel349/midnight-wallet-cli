// Limits on what an agent can make a fee wallet (`mn serve --approve-fees`)
// spend: the most Dust one transaction's fee may cost, and how many balanced
// transactions may hold Dust while waiting to be submitted. The grant on chain
// limits what the agent spends; these limit what it costs the fee wallet.

import { UsageError } from './errors.ts';
import { toDust } from '../ui/format.ts';

export const SPECKS_PER_DUST = 10n ** 15n;
const DUST_DECIMALS = 15;

export interface FeeLimits {
  /** Highest total fee (dApp tx plus the balancing tx), in specks. */
  maxFeeSpecks: bigint;
  /** Most balanced-but-unsubmitted transactions holding Dust at once. */
  maxPending: number;
}

// A simple contract call cost ~0.49 DUST in total on a ledger-9 localnet;
// 10 DUST leaves room for larger transactions (more circuits, more calls)
// while still stopping a runaway one.
export const DEFAULT_FEE_LIMITS: FeeLimits = {
  maxFeeSpecks: 10n * SPECKS_PER_DUST,
  maxPending: 2,
};

/** Parse a positive decimal DUST amount (up to 15 decimals) to specks, exactly. */
export function parseDustAmount(input: string, flag: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,15}))?$/.exec(input.trim());
  if (!match) {
    throw new UsageError(`${flag} must be a positive DUST amount with at most ${DUST_DECIMALS} decimals, e.g. 0.5`);
  }
  const whole = BigInt(match[1]!);
  const frac = BigInt((match[2] ?? '').padEnd(DUST_DECIMALS, '0'));
  const specks = whole * SPECKS_PER_DUST + frac;
  if (specks === 0n) throw new UsageError(`${flag} must be greater than 0`);
  return specks;
}

/** The limits from `--max-fee` / `--max-pending`, with defaults for those not given. */
export function parseFeeLimits(maxFee: string | undefined, maxPending: string | undefined): FeeLimits {
  const limits = { ...DEFAULT_FEE_LIMITS };
  if (maxFee !== undefined) limits.maxFeeSpecks = parseDustAmount(maxFee, '--max-fee');
  if (maxPending !== undefined) {
    if (!/^[1-9]\d*$/.test(maxPending)) throw new UsageError('--max-pending must be a whole number of at least 1');
    limits.maxPending = Number(maxPending);
  }
  return limits;
}

/** Why this fee is over the cap, or undefined if it's within it. */
export function feeLimitRefusal(feeSpecks: bigint, limits: FeeLimits): string | undefined {
  if (feeSpecks <= limits.maxFeeSpecks) return undefined;
  return `the estimated fee ${toDust(feeSpecks)} DUST is over --max-fee ${toDust(limits.maxFeeSpecks)} DUST`;
}

/** Why another balance must wait, or undefined if it may proceed. */
export function pendingLimitRefusal(pendingCount: number, limits: FeeLimits): string | undefined {
  if (pendingCount < limits.maxPending) return undefined;
  return `${pendingCount} balanced transactions are still waiting to be submitted (--max-pending ${limits.maxPending})`;
}
