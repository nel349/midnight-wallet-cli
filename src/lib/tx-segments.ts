// Per-segment results of an applied transaction, from the indexer. The wallet
// history keeps only the transaction's overall status; the indexer lists the
// segments of a partially successful one (segment 0 is the guaranteed section,
// each intent's fallible section is its own segment).

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

/** The segment results the indexer lists for a transaction (only a partial success has any). */
export async function fetchSegmentResults(indexerHttpUrl: string, txHash: string): Promise<SegmentResult[]> {
  let body: { data?: { transactions?: Array<{ __typename: string; transactionResult?: { segments?: SegmentResult[] | null } }> }; errors?: Array<{ message: string }> };
  try {
    const res = await fetch(indexerHttpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: SEGMENTS_QUERY, variables: { hash: txHash } }),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    body = await res.json() as typeof body;
  } catch (err) {
    throw new SegmentResultsUnavailableError(txHash, (err as Error).message);
  }
  if (body.errors?.length) {
    throw new SegmentResultsUnavailableError(txHash, body.errors.map((e) => e.message).join('; '));
  }
  const tx = body.data?.transactions?.find((t) => t.__typename === 'RegularTransaction');
  if (!tx) throw new SegmentResultsUnavailableError(txHash, 'the indexer has no such transaction');
  return tx.transactionResult?.segments ?? [];
}
