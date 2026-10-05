// How long a Dust registration has to wait before it can pay its own fee.
//
// On ledger 9 a registration pays its fee from the Dust its NIGHT UTXOs have
// generated since they were created, and generation scales with the amount of
// NIGHT: on a ledger-9 localnet 20 NIGHT took about 53 minutes to generate a
// 0.53 DUST fee, 1000 NIGHT about a minute. The SDK's estimateRegistration
// reports the fee and, per UTXO, what it has generated so far, its rate and
// its cap; that is enough to say up front how long the wait is.

import { toDust } from '../ui/format.ts';

/** The per-UTXO generation figures from the SDK's estimateRegistration (specks; rate per second). */
export interface DustGenerationEstimate {
  dust: { generatedNow: bigint; rate: bigint; maxCap: bigint };
}

export interface RegistrationPlan {
  fee: bigint;
  /** Dust the UTXOs have generated so far, together. */
  generated: bigint;
  /** Specks per second, together. */
  ratePerSecond: bigint;
  /** The most Dust they can ever hold, together. */
  cap: bigint;
  /** Milliseconds until the fee is covered: 0 when it already is, null when it never will be. */
  waitMs: number | null;
}

export function planRegistration(fee: bigint, estimates: readonly DustGenerationEstimate[]): RegistrationPlan {
  const sum = (pick: (e: DustGenerationEstimate) => bigint) => estimates.reduce((total, e) => total + pick(e), 0n);
  const generated = sum((e) => e.dust.generatedNow);
  const ratePerSecond = sum((e) => e.dust.rate);
  const cap = sum((e) => e.dust.maxCap);
  let waitMs: number | null;
  if (generated >= fee) waitMs = 0;
  else if (cap < fee || ratePerSecond <= 0n) waitMs = null;
  else waitMs = Number(((fee - generated) * 1000n + ratePerSecond - 1n) / ratePerSecond);
  return { fee, generated, ratePerSecond, cap, waitMs };
}

/** A wait in words: "about 19 minutes", "about 3 hours". */
export function formatWait(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 2) return 'about a minute';
  if (minutes < 120) return `about ${minutes} minutes`;
  return `about ${Math.round(minutes / 60)} hours`;
}

/** The NIGHT can't pay the registration fee within the time mn waits (or ever). */
export class DustFeeNotGeneratedError extends Error {
  readonly code = 'DUST_GENERATING';

  constructor(plan: RegistrationPlan, now: Date) {
    const what = `Registering for Dust costs a ${toDust(plan.fee)} DUST fee, paid from the Dust this wallet's NIGHT generates`;
    const so = `It has generated ${toDust(plan.generated)} DUST so far`;
    super(plan.waitMs === null
      ? `${what}, but it can never generate that much: its NIGHT holds at most ${toDust(plan.cap)} DUST. `
        + `${so}. Add more NIGHT (on undeployed: midnight airdrop 1000), then run: midnight dust register`
      : `${what}. ${so}, so the fee is covered in ${formatWait(plan.waitMs)} `
        + `(around ${new Date(now.getTime() + plan.waitMs).toISOString()}). `
        + 'Run midnight dust register again then, or add more NIGHT to register sooner (on undeployed: midnight airdrop 1000).');
    this.name = 'DustFeeNotGeneratedError';
    Object.setPrototypeOf(this, DustFeeNotGeneratedError.prototype);
  }
}
