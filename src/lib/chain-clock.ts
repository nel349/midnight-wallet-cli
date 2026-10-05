// The chain's clock, as its latest block is stamped. Dust generation is
// counted in chain time, while the wallet SDK's estimates use this computer's
// clock; a local chain whose clock has fallen behind (seen after the machine
// slept: about 14 hours behind, then catching up block by block) makes those
// estimates credit Dust the chain doesn't recognise yet, and a registration
// built on them is refused with a bare "Transaction submission error".

import { queryIndexer } from './indexer-graphql.ts';
import { formatWait } from './dust-registration-plan.ts';

/** How far behind this computer's clock the chain may be before mn says so. */
export const CHAIN_CLOCK_TOLERANCE_MS = 2 * 60_000;

/** The latest block's timestamp, or null when the indexer can't say. */
export async function fetchChainTime(indexerHttpUrl: string): Promise<Date | null> {
  try {
    const data = await queryIndexer<{ block?: { timestamp?: number } }>(indexerHttpUrl, '{ block { timestamp } }', undefined, 5_000);
    const ms = data.block?.timestamp;
    return typeof ms === 'number' ? new Date(ms) : null;
  } catch {
    return null;
  }
}

/** The chain's clock is too far behind this computer's for Dust estimates to hold. */
export class ChainClockBehindError extends Error {
  readonly code = 'CHAIN_CLOCK_BEHIND';

  constructor(chainTime: Date, now: Date) {
    super(
      `This chain's clock is ${formatWait(now.getTime() - chainTime.getTime())} behind this computer's `
      + `(its latest block is stamped ${chainTime.toISOString()}). Dust is generated in chain time, so a registration now would be `
      + 'refused for an unpaid fee. A local chain falls behind like this after the machine sleeps and catches up as it produces '
      + 'blocks: run midnight dust register again once it has, or restart the local chain.',
    );
    this.name = 'ChainClockBehindError';
    Object.setPrototypeOf(this, ChainClockBehindError.prototype);
  }
}

/** Throw when the chain's clock is more than the tolerance behind `now`. */
export function assertChainClockCurrent(chainTime: Date, now: Date): void {
  if (now.getTime() - chainTime.getTime() > CHAIN_CLOCK_TOLERANCE_MS) throw new ChainClockBehindError(chainTime, now);
}
