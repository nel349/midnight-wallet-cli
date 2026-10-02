// Reading a partially successful transaction's per-segment results from the
// indexer. The answers below have the shape the ledger-9 indexer returned on
// 2026-10-02: a successful transaction has `segments: null`; only a partial
// success lists segments.

import { afterEach, describe, expect, it } from 'vitest';
import { SegmentResultsUnavailableError, fetchPartialSuccessSegments } from '../lib/tx-segments.ts';
import { startLocalIndexer, type LocalIndexer } from './helpers/local-indexer.ts';

const HASH = '2ee4f2b48b659ff6b6f6312b85b49cbfba53fc5f77f430603c845c1a3378464b';
const regular = (status: string, segments: unknown) =>
  JSON.stringify({ data: { transactions: [{ __typename: 'RegularTransaction', transactionResult: { status, segments } }] } });

let indexer: LocalIndexer | undefined;
afterEach(async () => { await indexer?.close(); indexer = undefined; });

describe('fetchPartialSuccessSegments', () => {
  it('returns the segments of a partial success, asking for the transaction by its hash', async () => {
    indexer = await startLocalIndexer(() => regular('PARTIAL_SUCCESS', [{ id: 0, success: true }, { id: 1, success: false }]));

    expect(await fetchPartialSuccessSegments(indexer.url, HASH)).toEqual([{ id: 0, success: true }, { id: 1, success: false }]);
    expect(indexer.requests).toHaveLength(1);
    expect(indexer.requests[0]!.variables).toEqual({ hash: HASH });
    expect(indexer.requests[0]!.query).toContain('transactions(offset: { hash: $hash })');
  });

  it('refuses when the indexer reports the transaction as anything but a partial success', async () => {
    indexer = await startLocalIndexer(() => regular('SUCCESS', null));
    const err = await fetchPartialSuccessSegments(indexer.url, HASH).catch((e) => e);
    expect(err).toBeInstanceOf(SegmentResultsUnavailableError);
    expect(err.message).toContain('the indexer reports it as SUCCESS, not a partial success');
  });

  it.each([
    ['an unknown transaction', JSON.stringify({ data: { transactions: [] } }), 'the indexer has no such transaction'],
    ['a system transaction', JSON.stringify({ data: { transactions: [{ __typename: 'SystemTransaction' }] } }), 'the indexer has no such transaction'],
    ['a GraphQL error', JSON.stringify({ errors: [{ message: 'invalid transaction hash' }] }), 'invalid transaction hash'],
    ['a non-JSON answer', 'gateway timeout', 'not JSON'],
    ['an answer with neither data nor errors', JSON.stringify({}), 'no data'],
  ])('throws SegmentResultsUnavailableError for %s, naming the hash and the reason', async (_case, body, reason) => {
    indexer = await startLocalIndexer(() => body);
    const err = await fetchPartialSuccessSegments(indexer.url, HASH).catch((e) => e);
    expect(err).toBeInstanceOf(SegmentResultsUnavailableError);
    expect(err.message).toContain(HASH);
    expect(err.message).toContain(reason);
  });

  it('reports an HTTP error as such, not as a missing transaction', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => { res.statusCode = 429; res.statusMessage = 'Too Many Requests'; res.end(JSON.stringify({ message: 'slow down' })); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as import('node:net').AddressInfo;
    try {
      const err = await fetchPartialSuccessSegments(`http://127.0.0.1:${port}/api/v4/graphql`, HASH).catch((e) => e);
      expect(err).toBeInstanceOf(SegmentResultsUnavailableError);
      expect(err.message).toContain('HTTP 429 Too Many Requests');
    } finally {
      server.close();
    }
  });

  it('throws SegmentResultsUnavailableError when nothing listens', async () => {
    await expect(fetchPartialSuccessSegments('http://127.0.0.1:9/api/v4/graphql', HASH)).rejects.toBeInstanceOf(SegmentResultsUnavailableError);
  });
});
