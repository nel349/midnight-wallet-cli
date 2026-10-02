// Per-segment results of an applied transaction, from the indexer. The wallet
// history keeps only the transaction's overall status; the indexer lists the
// segments of a partially successful one (segment 0 is the guaranteed section,
// each intent's fallible section is its own segment).

import { queryIndexer } from './indexer-graphql.ts';

export interface SegmentResult {
  id: number;
  success: boolean;
}

const QUERY_TIMEOUT_MS = 10_000;

const SEGMENTS_QUERY = `query ($hash: HexEncoded!) {
  transactions(offset: { hash: $hash }) {
    __typename
    ... on RegularTransaction { transactionResult { status segments { id success } } }
  }
}`;

/** The indexer could not say how each segment of a transaction went. */
export class SegmentResultsUnavailableError extends Error {
  constructor(txHash: string, reason: string) {
    super(`Could not read the segment results of transaction ${txHash} from the indexer: ${reason}`);
    this.name = 'SegmentResultsUnavailableError';
    Object.setPrototypeOf(this, SegmentResultsUnavailableError.prototype);
  }
}

/**
 * The segment results the indexer lists for a partially successful
 * transaction. Throws when the indexer can't answer, has no such transaction,
 * or doesn't report it as a partial success.
 */
export async function fetchPartialSuccessSegments(indexerHttpUrl: string, txHash: string): Promise<SegmentResult[]> {
  let data: { transactions?: Array<{ __typename: string; transactionResult?: { status?: string; segments?: SegmentResult[] | null } }> };
  try {
    data = await queryIndexer(indexerHttpUrl, SEGMENTS_QUERY, { hash: txHash }, QUERY_TIMEOUT_MS);
  } catch (err) {
    throw new SegmentResultsUnavailableError(txHash, (err as Error).message);
  }
  const tx = data.transactions?.find((t) => t.__typename === 'RegularTransaction');
  if (!tx) throw new SegmentResultsUnavailableError(txHash, 'the indexer has no such transaction');
  const status = tx.transactionResult?.status;
  if (status !== 'PARTIAL_SUCCESS') {
    throw new SegmentResultsUnavailableError(txHash, `the indexer reports it as ${status ?? 'having no result'}, not a partial success`);
  }
  return tx.transactionResult?.segments ?? [];
}
