// What an owner is told when an account deploy stops for want of Dust.

import { describe, expect, it } from 'vitest';
import { ERROR_CODES, EXIT_INSUFFICIENT_BALANCE, classifyError } from '../lib/exit-codes.ts';
import { MEASURED_ACCOUNT_DEPLOY, deployShortOfDustNote } from '../lib/grant/deploy-cost.ts';

describe('deployShortOfDustNote', () => {
  it('says what a deploy takes, what the wallet had, and that running again carries on', () => {
    const note = deployShortOfDustNote(789_792_293_850_357n);
    expect(note).toContain('about 34 DUST over 5 transactions, the largest about 12.3 DUST');
    expect(note).toContain('This wallet had 0.789792293850357 DUST when the deploy began.');
    expect(note).toContain('midnight dust status');
    expect(note).toContain('carries on from where it stopped');
  });

  it('rounds the measured cost up, never down: the total covers the largest transaction several times', () => {
    expect(MEASURED_ACCOUNT_DEPLOY.totalDust).toBeGreaterThanOrEqual(33.74);
    expect(MEASURED_ACCOUNT_DEPLOY.largestDust).toBeGreaterThanOrEqual(12.23);
    expect(MEASURED_ACCOUNT_DEPLOY.totalDust).toBeGreaterThan(MEASURED_ACCOUNT_DEPLOY.largestDust);
  });

  it('leaves the error it is added to a Dust shortage, with the same exit code', () => {
    const fromServe = 'No Dust is free to pay the fee (Insufficient Funds: could not balance dust).';
    expect(classifyError(new Error(`${fromServe}\n\n${deployShortOfDustNote(0n)}`)))
      .toEqual({ exitCode: EXIT_INSUFFICIENT_BALANCE, errorCode: ERROR_CODES.DUST_REQUIRED });
  });
});
