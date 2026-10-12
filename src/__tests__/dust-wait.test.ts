import { describe, it, expect } from 'vitest';
import { waitForDustBalance } from '../lib/dust-wait.ts';

describe('waitForDustBalance', () => {
  it('returns at once when the balance is already enough', async () => {
    let reads = 0;
    const balance = await waitForDustBalance(() => { reads++; return 900n; }, 800n, { timeoutMs: 5_000, intervalMs: 1 });
    expect(balance).toBe(900n);
    expect(reads).toBe(1);
  });

  it('waits while the balance accrues and reports each short reading', async () => {
    const readings = [100n, 400n, 700n, 850n];
    const seen: bigint[] = [];
    const balance = await waitForDustBalance(() => readings.shift() ?? 850n, 800n, {
      timeoutMs: 5_000, intervalMs: 1, onBalance: (b) => seen.push(b),
    });
    expect(balance).toBe(850n);
    expect(seen).toEqual([100n, 400n, 700n]);
  });

  it('gives up at the timeout and returns what there is', async () => {
    const started = Date.now();
    const balance = await waitForDustBalance(async () => 10n, 800n, { timeoutMs: 60, intervalMs: 10 });
    expect(balance).toBe(10n);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('accepts a balance that is exactly the minimum', async () => {
    expect(await waitForDustBalance(() => 800n, 800n, { timeoutMs: 1_000, intervalMs: 1 })).toBe(800n);
  });
});
