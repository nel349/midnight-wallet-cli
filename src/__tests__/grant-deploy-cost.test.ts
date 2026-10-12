// What an owner is told when an account deploy stops for want of Dust.

import { describe, expect, it } from 'vitest';
import { ERROR_CODES, EXIT_INSUFFICIENT_BALANCE, classifyError } from '../lib/exit-codes.ts';
import { MEASURED_ACCOUNT_DEPLOY, deployShortOfDustNote } from '../lib/grant/deploy-cost.ts';

describe('deployShortOfDustNote', () => {
  it('says what a deploy takes, what the wallet had, and that running again carries on', () => {
    const note = deployShortOfDustNote(789_792_293_850_357n);
    expect(note).toContain('about 48 DUST from the wallet over 5 transactions, the largest about 17.1 DUST at once');
    expect(note).toContain('This wallet had 0.789792293850357 DUST when the deploy began.');
    expect(note).toContain('midnight dust status');
    expect(note).toContain('carries on from where it stopped');
  });

  // What leaves the wallet for a fee: the fee with the SDK's margin for five blocks, plus its fixed overhead.
  const fromWallet = (fee: number) => fee * 1.2519 + 0.3;
  const MEASURED_FEES = [
    [12.2349, 9.8673, 10.0001, 1.3712, 0.2631],
    [13.4002, 10.7393, 10.8193, 1.5282, 0.2673],
  ];

  it('covers both measured deploys, rounded up, never down', () => {
    for (const fees of MEASURED_FEES) {
      expect(fees).toHaveLength(MEASURED_ACCOUNT_DEPLOY.transactions);
      expect(MEASURED_ACCOUNT_DEPLOY.totalDust).toBeGreaterThanOrEqual(fees.reduce((total, fee) => total + fromWallet(fee), 0));
      expect(MEASURED_ACCOUNT_DEPLOY.largestDust).toBeGreaterThanOrEqual(fromWallet(Math.max(...fees)));
    }
  });

  it('leaves the error it is added to a Dust shortage, with the same exit code', () => {
    const fromServe = 'The wallet has no Dust available that covers this transaction\'s fee (Insufficient Funds: could not balance dust), and no balanced transaction is holding any back on this server.';
    expect(classifyError(new Error(`${fromServe}\n\n${deployShortOfDustNote(0n)}`)))
      .toEqual({ exitCode: EXIT_INSUFFICIENT_BALANCE, errorCode: ERROR_CODES.DUST_REQUIRED });
  });
});
