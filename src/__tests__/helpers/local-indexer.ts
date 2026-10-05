// A local HTTP server standing in for the indexer's GraphQL endpoint: real
// fetch, real JSON. It answers each request with `respond(body)` and records
// the parsed request bodies.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LocalIndexer {
  url: string;
  requests: Array<{ query: string; variables?: Record<string, unknown> }>;
  close: () => Promise<void>;
}

export async function startLocalIndexer(respond: (request: { query: string; variables?: Record<string, unknown> }) => string): Promise<LocalIndexer> {
  const requests: LocalIndexer['requests'] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const request = JSON.parse(raw);
      requests.push(request);
      res.setHeader('content-type', 'application/json');
      res.end(respond(request));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/v4/graphql`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A local indexer serving a ledger-9 localnet's latest block (protocol version
 * and ledger parameters), and the endpoint flags that point a command at it.
 */
export async function localIndexerFlags(): Promise<{ flags: string[]; close: () => Promise<void> }> {
  const { LEDGER9_PARAMETERS_HEX } = await import('../fixtures/ledger9-parameters.ts');
  const indexer = await startLocalIndexer(() =>
    JSON.stringify({ data: { block: { height: 26919, protocolVersion: 2001000, ledgerParameters: LEDGER9_PARAMETERS_HEX } } }));
  const ws = indexer.url.replace(/^http:/, 'ws:') + '/ws';
  return {
    flags: ['--network', 'undeployed', '--indexer-ws', ws, '--node', 'ws://127.0.0.1:9', '--proof-server', 'http://127.0.0.1:9'],
    close: indexer.close,
  };
}
