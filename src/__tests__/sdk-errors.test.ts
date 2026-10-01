// isDustShortage: recognises the wallet running out of dust for a fee, and
// nothing else. Errors are built in the shape wallet-sdk 2.0 raises them
// (an Effect tagged error carrying tokenType), not just matching strings.

import { describe, it, expect } from 'vitest';
import { isDustShortage } from '../lib/sdk-errors.ts';

/** wallet-sdk 2.0's dust InsufficientFundsError: tagged, with the token it could not balance. */
function sdkInsufficientFunds(tokenType: string): Error {
  return Object.assign(new Error(`Insufficient Funds: could not balance ${tokenType}`), {
    _tag: 'Wallet.InsufficientFunds',
    tokenType,
  });
}

describe('isDustShortage', () => {
  it('matches the SDK\'s dust InsufficientFunds error', () => {
    expect(isDustShortage(sdkInsufficientFunds('dust'))).toBe(true);
  });

  it('matches it when the facade wraps it as a cause', () => {
    const wrapped = Object.assign(new Error('Balancing failed'), { cause: sdkInsufficientFunds('dust') });
    expect(isDustShortage(wrapped)).toBe(true);
  });

  it('does not match a shortage of another token: waiting for dust would not fix it', () => {
    const night = '0000000000000000000000000000000000000000000000000000000000000000';
    expect(isDustShortage(sdkInsufficientFunds(night))).toBe(false);
    expect(isDustShortage(sdkInsufficientFunds('shielded'))).toBe(false);
  });

  it('still matches the ledger-8 SDK\'s wording', () => {
    expect(isDustShortage(new Error('No dust tokens found in the wallet state'))).toBe(true);
  });

  it('does not match unrelated errors or non-errors', () => {
    expect(isDustShortage(new Error('ZK proof generation timed out'))).toBe(false);
    expect(isDustShortage(undefined)).toBe(false);
    expect(isDustShortage('dust')).toBe(false);
  });

  it('terminates on a cyclic cause chain', () => {
    const a: any = new Error('a');
    const b: any = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(isDustShortage(a)).toBe(false);
  });
});
