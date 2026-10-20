// Reusing a running `mn serve` is only safe on the same chain. Two local
// stacks both call themselves `undeployed`, so the network name alone can't
// tell them apart; the node and indexer the serve reports can.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deriveAllAddresses } from '../lib/derive-address.ts';
import { serveEndpointMismatch, serveWalletMismatch } from '../lib/test/serve-manager.ts';
import { saveWalletConfig } from './helpers/plain-wallet.ts';

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

describe('serveWalletMismatch', () => {
  const wanted = { address: 'mn_addr_undeployed1two', name: 'two' };

  it('allows reuse when the serve pays from the wallet the command was given', () => {
    expect(serveWalletMismatch('mn_addr_undeployed1two', wanted)).toBeUndefined();
  });

  it('refuses a serve that pays from another wallet, naming both', () => {
    expect(serveWalletMismatch('mn_addr_undeployed1bob', wanted))
      .toBe('it serves the wallet at mn_addr_undeployed1bob, and this command pays from two (mn_addr_undeployed1two)');
  });

  it('allows a serve that does not say whose it is: its operator approves each request', () => {
    expect(serveWalletMismatch(null, wanted)).toBeUndefined();
  });
});

describe('startServeOrReuse against a running serve', () => {
  // A fake `mn serve`: a real JSON-RPC WebSocket server answering the two
  // probes the reuse check makes. Endpoints are passed explicitly, so neither
  // docker nor saved config affects what is requested.
  async function fakeServe(configuration: Record<string, string>, unshieldedAddress?: string) {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    wss.on('connection', (ws) => ws.on('message', (data) => {
      const req = JSON.parse(data.toString());
      const result = req.method === 'getConnectionStatus' ? { status: 'connected', networkId: 'undeployed' }
        : req.method === 'getConfiguration' ? configuration
        : req.method === 'getUnshieldedAddress' && unshieldedAddress !== undefined ? { unshieldedAddress } : null;
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

  describe('for a wallet', () => {
    const TWO = Buffer.alloc(32, 2);
    const BOB = Buffer.alloc(32, 7);
    const sameChain = { substrateNodeUri: requested.node, indexerWsUri: requested.indexerWS };
    let home: string;
    let origHome: string | undefined;

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-serve-reuse-'));
      origHome = process.env.HOME;
      process.env.HOME = home;
      fs.mkdirSync(path.join(home, '.midnight', 'wallets'), { recursive: true });
      for (const [name, seed] of [['two', TWO], ['bob', BOB]] as const) {
        saveWalletConfig(
          { seed: seed.toString('hex'), addresses: deriveAllAddresses(seed), createdAt: new Date(0).toISOString() },
          path.join(home, '.midnight', 'wallets', `${name}.json`),
        );
      }
    });

    afterEach(() => {
      process.env.HOME = origHome;
      fs.rmSync(home, { recursive: true, force: true });
    });

    it('reuses a serve that pays from that wallet', async () => {
      const { startServeOrReuse } = await import('../lib/test/serve-manager.ts');
      const serve = await fakeServe(sameChain, deriveAllAddresses(TWO).undeployed);
      try {
        const handle = await startServeOrReuse({ port: serve.port, network: 'undeployed', endpoints: requested, wallet: 'two' });
        expect(handle.port).toBe(serve.port);
      } finally {
        await serve.close();
      }
    });

    // Found reading the code: `mn grant --wallet two` beside a running serve
    // for bob had bob pay, with no word of it.
    it('refuses a serve that pays from another wallet, on the same chain', async () => {
      const { startServeOrReuse } = await import('../lib/test/serve-manager.ts');
      const bob = deriveAllAddresses(BOB).undeployed;
      const serve = await fakeServe(sameChain, bob);
      try {
        await expect(startServeOrReuse({ port: serve.port, network: 'undeployed', endpoints: requested, wallet: 'two' }))
          .rejects.toThrow(`can't pay for this command: it serves the wallet at ${bob}, and this command pays from two (${deriveAllAddresses(TWO).undeployed})`);
      } finally {
        await serve.close();
      }
    });
  });
});
