// The chain's clock against this computer's. The lagging timestamp is the one
// a local ledger-9 chain's latest block carried on 2026-10-05 while the wall
// clock read 02:33 UTC: about 14 hours behind.

import { afterEach, describe, expect, it } from 'vitest';
import { ChainClockBehindError, CHAIN_CLOCK_TOLERANCE_MS, assertChainClockCurrent, fetchChainTime } from '../lib/chain-clock.ts';
import { classifyError, EXIT_NETWORK_ERROR } from '../lib/exit-codes.ts';
import { startLocalIndexer, type LocalIndexer } from './helpers/local-indexer.ts';

const LAGGING_BLOCK = 1_791_116_964_002; // 2026-10-04T12:29:24.002Z
const WALL = new Date('2026-10-05T02:33:00.000Z');

let indexer: LocalIndexer | undefined;
afterEach(async () => { await indexer?.close(); indexer = undefined; });

describe('fetchChainTime', () => {
  it('reads the latest block\'s timestamp', async () => {
    indexer = await startLocalIndexer(() => JSON.stringify({ data: { block: { height: 24903, timestamp: LAGGING_BLOCK } } }));
    expect(await fetchChainTime(indexer.url)).toEqual(new Date(LAGGING_BLOCK));
    expect(indexer.requests).toEqual([{ query: '{ block { timestamp } }' }]);
  });

  it('is null when the indexer cannot say', async () => {
    indexer = await startLocalIndexer(() => JSON.stringify({ errors: [{ message: 'boom' }] }));
    expect(await fetchChainTime(indexer.url)).toBeNull();
    expect(await fetchChainTime('http://127.0.0.1:9/')).toBeNull();
  });
});

describe('assertChainClockCurrent', () => {
  it('refuses a chain about 14 hours behind, saying how far and what to do', () => {
    let err: any;
    try { assertChainClockCurrent(new Date(LAGGING_BLOCK), WALL); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ChainClockBehindError);
    expect(err.message).toBe("This chain's clock is about 14 hours behind this computer's (its latest block is stamped "
      + '2026-10-04T12:29:24.002Z). Dust is generated in chain time, so a registration now would be refused for an unpaid fee. '
      + 'A local chain falls behind like this after the machine sleeps and catches up as it produces blocks: run midnight dust '
      + 'register again once it has, or restart the local chain.');
    expect(classifyError(err)).toEqual({ exitCode: EXIT_NETWORK_ERROR, errorCode: 'CHAIN_CLOCK_BEHIND' });
  });

  it('accepts a chain within the tolerance, or ahead', () => {
    expect(() => assertChainClockCurrent(new Date(WALL.getTime() - CHAIN_CLOCK_TOLERANCE_MS), WALL)).not.toThrow();
    expect(() => assertChainClockCurrent(new Date(WALL.getTime() + 60_000), WALL)).not.toThrow();
    expect(() => assertChainClockCurrent(new Date(WALL.getTime() - CHAIN_CLOCK_TOLERANCE_MS - 1), WALL)).toThrow(ChainClockBehindError);
  });
});
