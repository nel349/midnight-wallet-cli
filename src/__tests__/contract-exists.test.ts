import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { contractExists } from '../lib/contract/exists.ts';

const DEPLOYED = 'fecb24d516a11c3d3fb196c99cba4071ca96c78061fe1e36bd168039f4a114b4';
const NOT_DEPLOYED = 'ab'.repeat(32);

let servers: Server[] = [];
afterEach(() => {
  for (const server of servers) server.close();
  servers = [];
});

/** An HTTP server on a free local port, answering each POST with `answer(body)`. */
async function indexer(answer: (body: { query: string; variables: { address: string } }, res: ServerResponse) => void): Promise<string> {
  const server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => answer(JSON.parse(raw), res));
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
  return `http://127.0.0.1:${port}/api/v4/graphql`;
}

/** Answers as the indexer does: the contract's action when it knows the address, null when it doesn't. */
function knowsOnly(address: string) {
  return (body: { variables: { address: string } }, res: ServerResponse) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: { contractAction: body.variables.address === address ? { address } : null } }));
  };
}

describe('contractExists', () => {
  it('is true for an address the indexer has a contract at', async () => {
    expect(await contractExists(await indexer(knowsOnly(DEPLOYED)), DEPLOYED)).toBe(true);
  });

  it('is false for an address the indexer has no contract at', async () => {
    expect(await contractExists(await indexer(knowsOnly(DEPLOYED)), NOT_DEPLOYED)).toBe(false);
  });

  it('asks about the address it was given', async () => {
    let asked: { query: string; variables: { address: string } } | undefined;
    const url = await indexer((body, res) => { asked = body; res.end(JSON.stringify({ data: { contractAction: null } })); });
    await contractExists(url, NOT_DEPLOYED);
    expect(asked?.variables.address).toBe(NOT_DEPLOYED);
    expect(asked?.query).toContain('contractAction');
  });

  it('is undefined when the indexer answers with a GraphQL error', async () => {
    const url = await indexer((_body, res) => { res.end(JSON.stringify({ data: null, errors: [{ message: 'invalid address' }] })); });
    expect(await contractExists(url, 'zz')).toBeUndefined();
  });

  it('is undefined when the indexer answers with an HTTP error', async () => {
    const url = await indexer((_body, res) => { res.statusCode = 503; res.end('unavailable'); });
    expect(await contractExists(url, DEPLOYED)).toBeUndefined();
  });

  it('is undefined when nothing listens there', async () => {
    const closed = createTcpServer();
    const port = await new Promise<number>((resolve) => closed.listen(0, '127.0.0.1', () => resolve((closed.address() as AddressInfo).port)));
    await new Promise((resolve) => closed.close(resolve));
    expect(await contractExists(`http://127.0.0.1:${port}/api/v4/graphql`, DEPLOYED)).toBeUndefined();
  });
});
