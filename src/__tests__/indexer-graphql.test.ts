// One GraphQL query to the indexer over HTTP: real fetch against a local server.

import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IndexerQueryError, queryIndexer } from '../lib/indexer-graphql.ts';
import { startLocalIndexer, type LocalIndexer } from './helpers/local-indexer.ts';

let indexer: LocalIndexer | undefined;
afterEach(async () => { await indexer?.close(); indexer = undefined; });

describe('queryIndexer', () => {
  it('returns the data, sending the query and its variables', async () => {
    indexer = await startLocalIndexer(() => JSON.stringify({ data: { block: { protocolVersion: 2001000 } } }));

    expect(await queryIndexer(indexer.url, 'query ($h: HexEncoded!) { x }', { h: 'ab' }, 5_000)).toEqual({ block: { protocolVersion: 2001000 } });
    expect(indexer.requests).toEqual([{ query: 'query ($h: HexEncoded!) { x }', variables: { h: 'ab' } }]);
  });

  it('sends no variables field when there are none', async () => {
    indexer = await startLocalIndexer(() => JSON.stringify({ data: {} }));
    await queryIndexer(indexer.url, '{ block { height } }', undefined, 5_000);
    expect(indexer.requests).toEqual([{ query: '{ block { height } }' }]);
  });

  it.each([
    ['GraphQL errors, joined', JSON.stringify({ errors: [{ message: 'bad hash' }, { message: 'bad id' }] }), 'bad hash; bad id'],
    ['no data', JSON.stringify({ data: null }), 'the answer has no data'],
    ['a non-JSON body', 'upstream timeout', 'the answer is not JSON'],
  ])('throws IndexerQueryError for %s', async (_case, body, message) => {
    indexer = await startLocalIndexer(() => body);
    const err: any = await queryIndexer(indexer.url, '{ x }', undefined, 5_000).catch((e: any) => e);
    expect(err).toBeInstanceOf(IndexerQueryError);
    expect(err.message).toContain(message);
  });

  it('throws IndexerQueryError naming an HTTP error status, even with a JSON body', async () => {
    const server = createServer((_req, res) => { res.statusCode = 503; res.statusMessage = 'Service Unavailable'; res.end('{"data":{}}'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const err: any = await queryIndexer(`http://127.0.0.1:${port}/`, '{ x }', undefined, 5_000).catch((e: any) => e);
      expect(err).toBeInstanceOf(IndexerQueryError);
      expect(err.message).toBe('HTTP 503 Service Unavailable');
    } finally {
      server.close();
    }
  });

  it('throws IndexerQueryError when nothing listens', async () => {
    await expect(queryIndexer('http://127.0.0.1:9/', '{ x }', undefined, 5_000)).rejects.toBeInstanceOf(IndexerQueryError);
  });
});
