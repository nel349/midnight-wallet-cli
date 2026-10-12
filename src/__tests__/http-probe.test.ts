import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { httpAnswers } from '../lib/http-probe.ts';

let servers: Array<{ close(): unknown }> = [];
afterEach(() => {
  for (const server of servers) server.close();
  servers = [];
});

function listen(server: Server | ReturnType<typeof createTcpServer>): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

describe('httpAnswers', () => {
  it('is true for a server that answers, whatever the status', async () => {
    const port = await listen(createServer((_req, res) => { res.statusCode = 400; res.end('bad request'); }));
    expect(await httpAnswers(`http://127.0.0.1:${port}/api/v4/graphql`, 2_000)).toBe(true);
  });

  it('is false when nothing listens on the port', async () => {
    const closed = createTcpServer();
    const port = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    expect(await httpAnswers(`http://127.0.0.1:${port}/`, 2_000)).toBe(false);
  });

  it('is false when the connection is accepted and nothing ever answers', async () => {
    const port = await listen(createTcpServer(() => { /* accept, say nothing */ }));
    const started = Date.now();
    expect(await httpAnswers(`http://127.0.0.1:${port}/`, 300)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
