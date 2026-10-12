// Dust that has just been registered is "available" long before there is
// enough of it to pay for a transaction: it accrues with time. This waits for
// an amount, not for the first coin.

import { setTimeout as sleep } from 'node:timers/promises';

export interface DustWaitOptions {
  /** Give up after this long and return what there is. */
  timeoutMs: number;
  /** How often to read the balance. */
  intervalMs?: number;
  /** Called with each balance read that is still short of the minimum. */
  onBalance?: (balance: bigint) => void;
}

/**
 * Read the Dust balance until it reaches `minimum` or `timeoutMs` has passed.
 * Returns the last balance read: the caller compares it with `minimum`.
 */
export async function waitForDustBalance(
  readBalance: () => Promise<bigint> | bigint,
  minimum: bigint,
  opts: DustWaitOptions,
): Promise<bigint> {
  const deadline = Date.now() + opts.timeoutMs;
  const intervalMs = opts.intervalMs ?? 2_000;
  for (;;) {
    const balance = await readBalance();
    if (balance >= minimum) return balance;
    const left = deadline - Date.now();
    if (left <= 0) return balance;
    opts.onBalance?.(balance);
    await sleep(Math.min(intervalMs, left));
  }
}
