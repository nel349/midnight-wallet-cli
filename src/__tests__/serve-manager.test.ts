// Reusing a running `mn serve` is only safe on the same chain. Two local
// stacks both call themselves `undeployed`, so the network name alone can't
// tell them apart; the node and indexer the serve reports can.

import { describe, it, expect } from 'vitest';
import { serveEndpointMismatch } from '../lib/test/serve-manager.ts';

const scratch = { node: 'ws://localhost:29944', indexerWS: 'ws://localhost:28088/api/v4/graphql/ws' };

describe('serveEndpointMismatch', () => {
  it('allows reuse when the serve reports the requested node and indexer', () => {
    expect(serveEndpointMismatch(
      { substrateNodeUri: scratch.node, indexerWsUri: scratch.indexerWS },
      scratch,
    )).toBeUndefined();
  });

  it('refuses a serve on another local stack with the same network name, naming both sides', () => {
    const reason = serveEndpointMismatch(
      { substrateNodeUri: 'ws://localhost:9944', indexerWsUri: 'ws://localhost:8088/api/v4/graphql/ws' },
      scratch,
    );
    expect(reason).toContain('node ws://localhost:9944 (need ws://localhost:29944)');
    expect(reason).toContain('indexer ws://localhost:8088/api/v4/graphql/ws (need ws://localhost:28088/api/v4/graphql/ws)');
  });

  it('treats a trailing slash as the same endpoint', () => {
    expect(serveEndpointMismatch(
      { substrateNodeUri: `${scratch.node}/`, indexerWsUri: scratch.indexerWS },
      scratch,
    )).toBeUndefined();
  });

  it('refuses when only one endpoint differs', () => {
    expect(serveEndpointMismatch({ substrateNodeUri: scratch.node, indexerWsUri: 'ws://elsewhere/ws' }, scratch))
      .toBe('indexer ws://elsewhere/ws (need ws://localhost:28088/api/v4/graphql/ws)');
  });

  it('refuses a serve that does not report its endpoints', () => {
    expect(serveEndpointMismatch({}, scratch)).toBeDefined();
  });
});

describe('startServeOrReuse against a running serve', () => {
  // A fake `mn serve`: a real JSON-RPC WebSocket server answering the two
  // probes the reuse check makes. Endpoints are passed explicitly, so neither
  // docker nor saved config affects what is requested.
  async function fakeServe(configuration: Record<string, string>) {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    wss.on('connection', (ws) => ws.on('message', (data) => {
      const req = JSON.parse(data.toString());
      const result = req.method === 'getConnectionStatus' ? { status: 'connected', networkId: 'undeployed' }
        : req.method === 'getConfiguration' ? configuration : null;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
    }));
    const port = (wss.address() as import('node:net').AddressInfo).port;
    return { port, close: () => new Promise<void>((r) => wss.close(() => r())) };
  }

  const requested = {
    node: 'ws://localhost:29944',
    indexerWS: 'ws://localhost:28088/api/v4/graphql/ws',
    proofServer: 'http://localhost:26300',
  };

  it('reuses a serve on the same chain, and does not stop what it did not start', async () => {
    const { startServeOrReuse } = await import('../lib/test/serve-manager.ts');
    const serve = await fakeServe({ substrateNodeUri: requested.node, indexerWsUri: requested.indexerWS });
    try {
      const messages: string[] = [];
      const handle = await startServeOrReuse({ port: serve.port, network: 'undeployed', endpoints: requested, onMessage: (m) => messages.push(m) });
      expect(handle.port).toBe(serve.port);
      expect(messages).toContain(`Reusing existing mn serve on port ${serve.port}`);
      await handle.stop(); // a no-op for a reused serve: the fake must still answer
      const { probeServeNetwork } = await import('../lib/test/serve-manager.ts');
      expect(await probeServeNetwork(serve.port)).toBe('undeployed');
    } finally {
      await serve.close();
    }
  });

  it('refuses a serve for the same network name on a different chain', async () => {
    const { startServeOrReuse } = await import('../lib/test/serve-manager.ts');
    const serve = await fakeServe({ substrateNodeUri: 'ws://localhost:9944', indexerWsUri: 'ws://localhost:8088/api/v4/graphql/ws' });
    try {
      await expect(startServeOrReuse({ port: serve.port, network: 'undeployed', endpoints: requested }))
        .rejects.toThrow(/on a different undeployed chain: node ws:\/\/localhost:9944 \(need ws:\/\/localhost:29944\)/);
    } finally {
      await serve.close();
    }
  });
});
