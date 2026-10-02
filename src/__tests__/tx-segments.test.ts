// Reading a transaction's per-segment results from the indexer. The answers
// below have the shape the ledger-9 indexer returned on 2026-10-02: a
// successful transaction has `segments: null`; only a partial success lists
// segments.

import { afterEach, describe, expect, it } from 'vitest';
import { SegmentResultsUnavailableError, fetchSegmentResults } from '../lib/tx-segments.ts';
import { startLocalIndexer, type LocalIndexer } from './helpers/local-indexer.ts';

const HASH = '2ee4f2b48b659ff6b6f6312b85b49cbfba53fc5f77f430603c845c1a3378464b';
const regular = (status: string, segments: unknown) =>
  JSON.stringify({ data: { transactions: [{ __typename: 'RegularTransaction', transactionResult: { status, segments } }] } });

let indexer: LocalIndexer | undefined;
afterEach(async () => { await indexer?.close(); indexer = undefined; });

describe('fetchSegmentResults', () => {
  it('returns the segments of a partial success, asking for the transaction by its hash', async () => {
    indexer = await startLocalIndexer(() => regular('PARTIAL_SUCCESS', [{ id: 0, success: true }, { id: 1, success: false }]));

    expect(await fetchSegmentResults(indexer.url, HASH)).toEqual([{ id: 0, success: true }, { id: 1, success: false }]);
    expect(indexer.requests).toHaveLength(1);
    expect(indexer.requests[0]!.variables).toEqual({ hash: HASH });
    expect(indexer.requests[0]!.query).toContain('transactions(offset: { hash: $hash })');
  });

  it('returns no segments for a success, whose segments the indexer reports as null', async () => {
    indexer = await startLocalIndexer(() => regular('SUCCESS', null));
    expect(await fetchSegmentResults(indexer.url, HASH)).toEqual([]);
  });

  it.each([
    ['an unknown transaction', JSON.stringify({ data: { transactions: [] } }), 'the indexer has no such transaction'],
    ['a system transaction', JSON.stringify({ data: { transactions: [{ __typename: 'SystemTransaction' }] } }), 'the indexer has no such transaction'],
    ['a GraphQL error', JSON.stringify({ errors: [{ message: 'invalid transaction hash' }] }), 'invalid transaction hash'],
    ['a non-JSON answer', 'gateway timeout', 'JSON'],
  ])('throws SegmentResultsUnavailableError for %s, naming the hash and the reason', async (_case, body, reason) => {
    indexer = await startLocalIndexer(() => body);
    const err = await fetchSegmentResults(indexer.url, HASH).catch((e) => e);
    expect(err).toBeInstanceOf(SegmentResultsUnavailableError);
    expect(err.message).toContain(HASH);
    expect(err.message).toContain(reason);
  });

  it('throws SegmentResultsUnavailableError when nothing listens', async () => {
    await expect(fetchSegmentResults('http://127.0.0.1:9/api/v4/graphql', HASH)).rejects.toBeInstanceOf(SegmentResultsUnavailableError);
  });
});
