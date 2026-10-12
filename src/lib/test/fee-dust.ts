// A suite's transactions follow one another, and each fee leaves the wallet
// short of Dust until it regrows: a call sent the moment a deploy lands fails
// with "could not balance dust". Before each transaction the runner waits for
// the amount mn asks for before any transaction.

import { MIN_DUST_FOR_TRANSFER } from '../constants.ts';
import { waitForDustBalance } from '../dust-wait.ts';

/** How long a suite waits for Dust to regrow before one transaction. A 1000 NIGHT wallet regains a fee in under a minute. */
export const FEE_DUST_TIMEOUT_MS = 180_000;

/** Specks as DUST with six decimals. */
function dust(specks: bigint): string {
  return `${specks / 1_000_000_000_000_000n}.${(specks % 1_000_000_000_000_000n).toString().padStart(15, '0').slice(0, 6)}`;
}

export interface FeeDustOptions {
  timeoutMs?: number;
  intervalMs?: number;
  onMessage?: (message: string) => void;
}

/**
 * Wait until the wallet holds the Dust a transaction needs. `readDust` gives
 * its spendable Dust in specks, or null when it can't be read: the wait then
 * ends and the transaction is left to speak for itself. Throws when the amount
 * isn't reached in time.
 */
export async function waitForFeeDust(readDust: () => Promise<bigint | null>, opts: FeeDustOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? FEE_DUST_TIMEOUT_MS;
  const needed = dust(MIN_DUST_FOR_TRANSFER);
  const balance = await waitForDustBalance(async () => (await readDust()) ?? MIN_DUST_FOR_TRANSFER, MIN_DUST_FOR_TRANSFER, {
    timeoutMs,
    intervalMs: opts.intervalMs,
    onBalance: (b) => opts.onMessage?.(`Waiting for Dust to regrow: ${dust(b)} of the ${needed} DUST a transaction needs`),
  });
  if (balance < MIN_DUST_FOR_TRANSFER) {
    throw new Error(
      `Only ${dust(balance)} DUST after waiting ${Math.round(timeoutMs / 1000)}s, and a transaction needs ${needed}. ` +
      'Dust regrows with time, faster the more NIGHT is registered: fund the wallet with more NIGHT, or run the suite again in a while.',
    );
  }
}
