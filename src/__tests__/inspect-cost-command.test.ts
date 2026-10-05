// inspect-cost reports the chain's block limits from the ledger parameters of
// its latest block. A local HTTP server stands in for the indexer and serves
// the parameters a ledger-9 localnet served (fixture); nothing else is faked.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as ledger from '@midnightntwrk/ledger-v9';
import inspectCostCommand from '../commands/inspect-cost.ts';
import { parseArgs } from '../lib/argv.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import { startLocalIndexer, type LocalIndexer } from './helpers/local-indexer.ts';
import { LEDGER9_PARAMETERS_HEX } from './fixtures/ledger9-parameters.ts';

let io: CapturedOutput;
let indexer: LocalIndexer | undefined;

/** The latest block as the indexer serves it, to both the ledger check and the parameters read. */
const servesBlock = (height: number, ledgerParameters: string, protocolVersion = 2001000) => () =>
  JSON.stringify({ data: { block: { height, ledgerParameters, protocolVersion } } });

/** inspect-cost against the local indexer, with explicit endpoints so no config or detection is involved. */
async function run(extra: string[] = []): Promise<void> {
  const ws = indexer!.url.replace(/^http:/, 'ws:') + '/ws';
  await inspectCostCommand(parseArgs(['inspect-cost', '--network', 'undeployed', '--indexer-ws', ws,
    '--node', 'ws://127.0.0.1:9', '--proof-server', 'http://127.0.0.1:9', ...extra]));
}

beforeEach(() => {
  process.env.NO_COLOR = '';
  io = captureOutput();
});

afterEach(async () => {
  delete process.env.NO_COLOR;
  io.restore();
  await indexer?.close();
  indexer = undefined;
});

describe('inspect-cost reads the chain\'s ledger parameters', () => {
  it('reports the chain\'s limits, which differ from the initial parameters', async () => {
    indexer = await startLocalIndexer(servesBlock(26919, LEDGER9_PARAMETERS_HEX));
    await run();

    const limits = Object.fromEntries(io.stdout().trim().split('\n').map((l) => l.split('=')));
    // The ledger-9 localnet's own limits: readTime and blockUsage are 2x and 5x the initial ones.
    expect(limits).toEqual({
      readTime: '2000000000000', computeTime: expect.any(String), blockUsage: '1000000',
      bytesWritten: '50000', bytesChurned: expect.any(String),
    });
    const initial = ledger.LedgerParameters.initialParameters()
      .normalizeFullness({ readTime: 1_000_000_000n, computeTime: 0n, blockUsage: 10_000n, bytesWritten: 0n, bytesChurned: 0n } as unknown as ledger.SyntheticCost) as unknown as Record<string, number>;
    expect(Math.round(10_000 / initial.blockUsage!)).toBe(200_000);
    expect(indexer.requests).toEqual([{ query: '{ block { protocolVersion } }' }, { query: '{ block { height ledgerParameters } }' }]);
  });

  it('--json includes the network and the block the limits come from', async () => {
    indexer = await startLocalIndexer(servesBlock(26919, LEDGER9_PARAMETERS_HEX));
    await run(['--json']);

    expect(JSON.parse(io.stdout())).toMatchObject({ readTime: 2_000_000_000_000, blockUsage: 1_000_000, network: 'undeployed', height: 26919 });
  });

  it('says on stderr which block and network the limits come from', async () => {
    indexer = await startLocalIndexer(servesBlock(26919, LEDGER9_PARAMETERS_HEX));
    await run();

    const err = io.stderr();
    expect(err).toContain('Block Limits');
    expect(err).toContain('From the ledger parameters of block 26919 on undeployed');
    expect(err).toContain('picoseconds');
    expect(err).toContain('tightest constraint');
  });

  it('refuses a ledger-8 chain before reading its parameters', async () => {
    indexer = await startLocalIndexer(servesBlock(26919, LEDGER9_PARAMETERS_HEX, 1000300));
    await expect(run()).rejects.toMatchObject({ code: 'UNSUPPORTED_LEDGER' });
    expect(indexer.requests).toEqual([{ query: '{ block { protocolVersion } }' }]);
  });

  it('fails, naming the cause, when the indexer has no parameters to give', async () => {
    indexer = await startLocalIndexer(() => JSON.stringify({ data: { block: null } }));
    await expect(run()).rejects.toThrow('The indexer returned no ledger parameters for its latest block');
  });
});
