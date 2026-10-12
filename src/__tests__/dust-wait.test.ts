// Waiting for Dust to cover a fee. The Dust state is the SDK's at the
// interface boundary: a balance that grows linearly with time, as registered
// NIGHT generates it (1000 NIGHT: ~0.0083 DUST/s on a ledger-9 localnet).

import { describe, it, expect, vi } from 'vitest';
import { DUST_SHORT_WAIT_MS, awaitDustForFee, dustShortError, msUntilDust, payWhenDustCovers, planDustWait, sleep } from '../lib/dust-wait.ts';
import { withDustShortfall } from '../lib/sdk-errors.ts';

const DUST = 10n ** 15n;
const NOW = new Date('2026-10-05T05:00:00Z');
/** A balance of `start` specks at NOW, growing `perSecond` specks a second (never shrinking before NOW). */
const growing = (start: bigint, perSecond: bigint) => ({
  balance: (at: Date) => start + perSecond * BigInt(Math.max(0, Math.floor((at.getTime() - NOW.getTime()) / 1000))),
});
// Just registered 1000 NIGHT: 0.66 DUST, +0.0083 DUST/s.
const JUST_REGISTERED = growing(660_000_000_000_000n, 8_300_000_000_000n);
const NEEDED = 900_000_000_000_000n;

describe('msUntilDust', () => {
  it('finds the wait to the second: 0.66 -> 0.9 DUST at 0.0083 DUST/s is 29 s', () => {
    expect(msUntilDust(JUST_REGISTERED, NEEDED, NOW, 86_400_000)).toBe(29_000);
  });

  it('is 0 when the balance already covers it, and null when the horizon is too short', () => {
    expect(msUntilDust(growing(DUST, 0n), NEEDED, NOW, 60_000)).toBe(0);
    expect(msUntilDust(JUST_REGISTERED, NEEDED, NOW, 10_000)).toBeNull();
    expect(msUntilDust(growing(DUST / 10n, 0n), NEEDED, NOW, 86_400_000)).toBeNull();
  });
});

describe('awaitDustForFee', () => {
  it('waits when the Dust is moments away, saying how long', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const statuses: string[] = [];
      let done = false;
      const waiting = awaitDustForFee(JUST_REGISTERED, NEEDED, (s) => statuses.push(s)).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(28_000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await waiting;
      expect(done).toBe(true);
      expect(statuses).toEqual(['Waiting about 29 seconds for Dust to cover the fee (0.660000 of 0.900000 DUST)...']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns at once when the balance covers the fee, or there is no Dust at all (registration handles that)', async () => {
    const onStatus = vi.fn();
    await awaitDustForFee(growing(DUST, 0n), NEEDED, onStatus);
    await awaitDustForFee(growing(0n, 0n), NEEDED, onStatus);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('refuses, saying how long, when the wait is longer than it waits', async () => {
    vi.useFakeTimers({ now: NOW });
    const slow = growing(660_000_000_000_000n, 1_000_000_000_000n); // 240 s to go
    const err = await awaitDustForFee(slow, NEEDED).catch((e) => e).finally(() => vi.useRealTimers());
    expect(err.message).toBe('Insufficient dust for transaction fees.\nAvailable: 0.660000 DUST, need ≥0.900000 DUST.\n'
      + "This wallet's NIGHT generates that in about 4 minutes; retry then.");
    expect(240_000).toBeGreaterThan(DUST_SHORT_WAIT_MS);
  });

  it('stops waiting when cancelled', async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const controller = new AbortController();
      const waiting = awaitDustForFee(JUST_REGISTERED, NEEDED, undefined, controller.signal);
      controller.abort();
      await expect(waiting).rejects.toThrow('Operation cancelled');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dustShortError', () => {
  it('says registered NIGHT will not generate it within a day when it will not', () => {
    expect(dustShortError(1n, NEEDED, null).message).toContain("won't generate that within a day: register more NIGHT (midnight dust register)");
  });
});

describe('sleep', () => {
  it('rejects at once when the signal has already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(60_000, controller.signal)).rejects.toThrow('Operation cancelled');
  });

  it('resolves after the wait and stops listening to the signal', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const removed = vi.spyOn(controller.signal, 'removeEventListener');
      const done = sleep(1_000, controller.signal);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(done).resolves.toBeUndefined();
      expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a Dust shortage that says what the wallet is short by', () => {
  // The shape mn's fee planner raises: the SDK's tagged shortage, marked with
  // what the fee takes and what the wallet's coins held.
  const shortage = (needed: bigint, available: bigint) => withDustShortfall(
    Object.assign(new Error('Insufficient Funds: could not balance dust'), { _tag: 'Wallet.InsufficientFunds', tokenType: 'dust' }),
    { needed, available },
  );
  // After a payment: 0.10 DUST, +0.0083 DUST/s.
  const AFTER_PAYING = growing(100_000_000_000_000n, 8_300_000_000_000n);

  describe('planDustWait', () => {
    it('times the growth the wallet is short by, a little over: 0.80 more at 0.0083 DUST/s is 99 s', () => {
      expect(planDustWait(shortage(NEEDED, 100_000_000_000_000n), AFTER_PAYING, NOW)).toEqual({
        have: 100_000_000_000_000n, needed: NEEDED, waitMs: 99_000,
      });
    });

    it('goes by what the coins held on the wallet\'s clock, not by the balance read here', () => {
      // The chain's clock runs behind: the coins held 0.05 when the balance here read 0.10.
      expect(planDustWait(shortage(NEEDED, 50_000_000_000_000n), AFTER_PAYING, NOW)!.waitMs).toBe(105_000);
    });

    it('is never a wait too short to matter', () => {
      expect(planDustWait(shortage(NEEDED, NEEDED - 1n), AFTER_PAYING, NOW)!.waitMs).toBe(3_000);
    });

    it('is null when the wallet won\'t generate it within a day', () => {
      expect(planDustWait(shortage(NEEDED, 0n), growing(0n, 0n), NOW)!.waitMs).toBeNull();
    });

    it('is undefined for a shortage that carries no shortfall, and for one that isn\'t short', () => {
      expect(planDustWait(new Error('Insufficient Funds: could not balance dust'), AFTER_PAYING, NOW)).toBeUndefined();
      expect(planDustWait(shortage(NEEDED, NEEDED), AFTER_PAYING, NOW)).toBeUndefined();
    });
  });

  describe('payWhenDustCovers', () => {
    it('pays at once when there is nothing to wait for', async () => {
      const pay = vi.fn().mockResolvedValue('recipe');
      await expect(payWhenDustCovers(pay, AFTER_PAYING, { maxWaitMs: DUST_SHORT_WAIT_MS })).resolves.toBe('recipe');
      expect(pay).toHaveBeenCalledTimes(1);
    });

    it('waits the time the plan gives, saying so, then pays', async () => {
      vi.useFakeTimers({ now: NOW });
      const statuses: string[] = [];
      const pay = vi.fn().mockRejectedValueOnce(shortage(NEEDED, 100_000_000_000_000n)).mockResolvedValue('recipe');
      const paid = payWhenDustCovers(pay, AFTER_PAYING, { maxWaitMs: DUST_SHORT_WAIT_MS, onStatus: (status) => statuses.push(status) });
      await vi.advanceTimersByTimeAsync(98_000);
      expect(pay).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(paid).resolves.toBe('recipe');
      expect(statuses).toEqual(['Waiting about 2 minutes for Dust to cover the fee (0.10 of 0.90 DUST)...']);
      vi.useRealTimers();
    });

    it('refuses with the time when the wait is longer than allowed, without waiting', async () => {
      const pay = vi.fn().mockRejectedValue(shortage(2n * DUST, 100_000_000_000_000n));
      const err = await payWhenDustCovers(pay, AFTER_PAYING, { maxWaitMs: DUST_SHORT_WAIT_MS }).catch((e: Error) => e) as Error;
      expect(err.message).toContain('Insufficient dust for transaction fees.');
      expect(err.message).toContain("This wallet's NIGHT generates that in about 4 minutes; retry then.");
      expect(pay).toHaveBeenCalledTimes(1);
    });

    it('throws any other failure as it is', async () => {
      const other = new Error('Failed to prove transaction');
      await expect(payWhenDustCovers(() => Promise.reject(other), AFTER_PAYING, { maxWaitMs: DUST_SHORT_WAIT_MS })).rejects.toBe(other);
    });

    it('stops when cancelled during the wait', async () => {
      vi.useFakeTimers({ now: NOW });
      const abort = new AbortController();
      const pay = vi.fn().mockRejectedValue(shortage(NEEDED, 100_000_000_000_000n));
      const failure = payWhenDustCovers(pay, AFTER_PAYING, { maxWaitMs: DUST_SHORT_WAIT_MS, signal: abort.signal }).catch((e: Error) => e) as Promise<Error>;
      await vi.advanceTimersByTimeAsync(5_000);
      abort.abort();
      expect((await failure).message).toBe('Operation cancelled');
      expect(pay).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });
});
