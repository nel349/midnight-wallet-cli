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

describe('isDustShortage on what the real wallet SDK rejects with', () => {
  // The shape wallet-sdk 2.0.0-rc.0 rejected with on a ledger-9 localnet
  // (2026-10-02) when a fee wallet's only Dust coin was reserved by a pending
  // balance: an Effect FiberFailure named "(FiberFailure)
  // Wallet.InsufficientFunds", with nothing on the error itself but its
  // message; the tagged error is only in the Effect cause under this symbol.
  const FIBER_FAILURE = Symbol.for('effect/Runtime/FiberFailure');
  const FIBER_FAILURE_CAUSE = Symbol.for('effect/Runtime/FiberFailure/Cause');
  function fiberFailure(cause: object, message: string): Error {
    const err = new Error(message);
    err.name = '(FiberFailure) Wallet.InsufficientFunds';
    return Object.assign(err, { [FIBER_FAILURE]: FIBER_FAILURE, [FIBER_FAILURE_CAUSE]: cause });
  }

  it('matches the FiberFailure of a dust shortage, which carries no tag of its own', () => {
    const err = fiberFailure(
      { _tag: 'Fail', error: { _tag: 'Wallet.InsufficientFunds', tokenType: 'dust' } },
      'Insufficient Funds: could not balance dust',
    );
    expect(Object.keys(err)).toEqual(['name']); // as on the live error: no _tag, no tokenType
    expect(isDustShortage(err)).toBe(true);
  });

  it('does not match a FiberFailure whose cause is another token\'s shortage', () => {
    const err = fiberFailure(
      { _tag: 'Fail', error: { _tag: 'Wallet.InsufficientFunds', tokenType: '00'.repeat(32) } },
      'Insufficient Funds: could not balance 0000',
    );
    expect(isDustShortage(err)).toBe(false);
  });

  it('finds a dust shortage on either side of a combined (Sequential) cause', () => {
    const err = fiberFailure({
      _tag: 'Sequential',
      left: { _tag: 'Fail', error: { _tag: 'Other' } },
      right: { _tag: 'Fail', error: { _tag: 'Wallet.InsufficientFunds', tokenType: 'dust' } },
    }, 'several failures');
    expect(isDustShortage(err)).toBe(true);
  });
});
