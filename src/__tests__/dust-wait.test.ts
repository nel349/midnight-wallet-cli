// Waiting for Dust to cover a fee. The Dust state is the SDK's at the
// interface boundary: a balance that grows linearly with time, as registered
// NIGHT generates it (1000 NIGHT: ~0.0083 DUST/s on a ledger-9 localnet).

import { describe, it, expect, vi } from 'vitest';
import { DUST_SHORT_WAIT_MS, awaitDustForFee, dustShortError, msUntilDust } from '../lib/dust-wait.ts';

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
      expect(statuses).toEqual(['Waiting about a minute for Dust to cover the fee (0.660000 of 0.900000 DUST)...']);
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
