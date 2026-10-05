// The chain's current ledger parameters (block limits, fee prices), as the
// indexer serves them for the latest block. They differ from
// LedgerParameters.initialParameters(): on a ledger-9 localnet the block
// limits for read time and block usage are 2x and 5x the initial ones.

import * as ledger from '@midnightntwrk/ledger-v9';
import { queryIndexer } from './indexer-graphql.ts';

export interface ChainLedgerParameters {
  height: number;
  params: ledger.LedgerParameters;
}

/** The latest block's ledger parameters. Throws IndexerQueryError when the indexer can't answer. */
export async function fetchLedgerParameters(indexerHttpUrl: string): Promise<ChainLedgerParameters> {
  const data = await queryIndexer<{ block?: { height?: number; ledgerParameters?: string } }>(
    indexerHttpUrl, '{ block { height ledgerParameters } }', undefined, 10_000);
  const hex = data.block?.ledgerParameters;
  if (typeof hex !== 'string' || typeof data.block?.height !== 'number') {
    throw new Error('The indexer returned no ledger parameters for its latest block');
  }
  return { height: data.block.height, params: ledger.LedgerParameters.deserialize(Buffer.from(hex, 'hex')) };
}
