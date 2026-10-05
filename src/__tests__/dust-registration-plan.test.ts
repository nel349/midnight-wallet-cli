// Planning a Dust registration's wait. The figures are those the SDK's
// estimateRegistration reported on a ledger-9 localnet on 2026-10-05 for a
// wallet airdropped 20 NIGHT 34 minutes earlier.

import { describe, it, expect } from 'vitest';
import { DustFeeNotGeneratedError, formatWait, planRegistration } from '../lib/dust-registration-plan.ts';
import { classifyError, EXIT_INSUFFICIENT_BALANCE } from '../lib/exit-codes.ts';

const FEE = 526_587_115_818_352n;
const TWENTY_NIGHT = { dust: { generatedNow: 337_954_960_000_000n, rate: 165_340_000_000n, maxCap: 100_000_000_000_000_000n } };

describe('planRegistration', () => {
  it('works out the wait from what is generated and the rate: about 20 minutes for 20 NIGHT, 34 minutes in', () => {
    const plan = planRegistration(FEE, [TWENTY_NIGHT]);
    // (fee - generated) / rate = 188632155818352 / 165340000000 = 1140.8743 s, rounded up to the millisecond.
    expect(plan.waitMs).toBe(1_140_875);
    expect(plan).toMatchObject({ fee: FEE, generated: 337_954_960_000_000n, ratePerSecond: 165_340_000_000n });
    expect(formatWait(plan.waitMs!)).toBe('about 20 minutes');
  });

  it('needs no wait once the fee is generated', () => {
    expect(planRegistration(FEE, [{ dust: { ...TWENTY_NIGHT.dust, generatedNow: FEE } }]).waitMs).toBe(0);
    expect(planRegistration(0n, []).waitMs).toBe(0);
  });

  it('adds up several UTXOs', () => {
    const plan = planRegistration(FEE, [TWENTY_NIGHT, TWENTY_NIGHT]);
    expect(plan.generated).toBe(675_909_920_000_000n);
    expect(plan.waitMs).toBe(0);
  });

  it('says never when the cap is below the fee, or nothing is generated', () => {
    expect(planRegistration(FEE, [{ dust: { generatedNow: 0n, rate: 1n, maxCap: FEE - 1n } }]).waitMs).toBeNull();
    expect(planRegistration(FEE, [{ dust: { generatedNow: 0n, rate: 0n, maxCap: FEE * 10n } }]).waitMs).toBeNull();
    expect(planRegistration(FEE, []).waitMs).toBeNull();
  });
});

describe('formatWait', () => {
  it.each([[1, 'about 1 second'], [29_000, 'about 29 seconds'], [60_000, 'about a minute'], [61_000, 'about 2 minutes'], [119 * 60_000, 'about 119 minutes'],
    [120 * 60_000, 'about 2 hours'], [3.5 * 3_600_000, 'about 4 hours']])('%i ms is %s', (ms, words) => {
    expect(formatWait(ms)).toBe(words);
  });
});

describe('DustFeeNotGeneratedError', () => {
  const now = new Date('2026-10-05T04:05:23.000Z');

  it('says what the fee is, what is generated, when it is covered, and what to do', () => {
    const err = new DustFeeNotGeneratedError(planRegistration(FEE, [TWENTY_NIGHT]), now);
    expect(err.message).toBe('Registering for Dust costs a 0.526587115818352 DUST fee, paid from the Dust this wallet\'s NIGHT generates. '
      + 'It has generated 0.33795496 DUST so far, so the fee is covered in about 20 minutes (around 2026-10-05T04:24:23.875Z). '
      + 'Run midnight dust register again then, or add more NIGHT to register sooner (on undeployed: midnight airdrop 1000).');
  });

  it('says it never will when the cap is below the fee', () => {
    const err = new DustFeeNotGeneratedError(planRegistration(FEE, [{ dust: { generatedNow: 1n, rate: 1n, maxCap: 2n } }]), now);
    expect(err.message).toContain('but it can never generate that much: its NIGHT holds at most');
    expect(err.message).toContain('Add more NIGHT (on undeployed: midnight airdrop 1000), then run: midnight dust register');
  });

  it('exits as an insufficient balance, with its own error code', () => {
    expect(classifyError(new DustFeeNotGeneratedError(planRegistration(FEE, [TWENTY_NIGHT]), now)))
      .toEqual({ exitCode: EXIT_INSUFFICIENT_BALANCE, errorCode: 'DUST_GENERATING' });
  });
});
