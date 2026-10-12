// Reusing a running `mn serve` is only safe when it pays from the wallet the
// command was given: a serve pays from the wallet it was started with.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deriveAllAddresses } from '../lib/derive-address.ts';
import { serveWalletMismatch } from '../lib/test/serve-manager.ts';
import { saveWalletConfig } from '../lib/wallet-config.ts';

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
  // A fake `mn serve`: a real JSON-RPC WebSocket server answering the probes
  // the reuse check makes.
  async function fakeServe(unshieldedAddress?: string) {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    wss.on('connection', (ws) => ws.on('message', (data) => {
      const req = JSON.parse(data.toString());
      const result = req.method === 'getConnectionStatus' ? { status: 'connected', networkId: 'undeployed' }
        : req.method === 'getUnshieldedAddress' && unshieldedAddress !== undefined ? { unshieldedAddress } : null;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
    }));
    const port = (wss.address() as import('node:net').AddressInfo).port;
    return { port, close: () => new Promise<void>((r) => wss.close(() => r())) };
  }

  const TWO = Buffer.alloc(32, 2);
  const BOB = Buffer.alloc(32, 7);
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

  it('reuses a serve that pays from the command\'s wallet, and does not stop what it did not start', async () => {
    const { startServeOrReuse, probeServeNetwork } = await import('../lib/test/serve-manager.ts');
    const serve = await fakeServe(deriveAllAddresses(TWO).undeployed);
    try {
      const messages: string[] = [];
      const handle = await startServeOrReuse({ port: serve.port, network: 'undeployed', wallet: 'two', onMessage: (m) => messages.push(m) });
      expect(handle.port).toBe(serve.port);
      expect(messages).toContain(`Reusing existing mn serve on port ${serve.port}`);
      await handle.stop(); // a no-op for a reused serve: the fake must still answer
      expect(await probeServeNetwork(serve.port)).toBe('undeployed');
    } finally {
      await serve.close();
    }
  });

  // `mn contract deploy --wallet two` beside a running serve for bob had bob
  // pay, with no word of it.
  it('refuses a serve that pays from another wallet', async () => {
    const { startServeOrReuse } = await import('../lib/test/serve-manager.ts');
    const bob = deriveAllAddresses(BOB).undeployed;
    const serve = await fakeServe(bob);
    try {
      await expect(startServeOrReuse({ port: serve.port, network: 'undeployed', wallet: 'two' }))
        .rejects.toThrow(`can't pay for this command: it serves the wallet at ${bob}, and this command pays from two (${deriveAllAddresses(TWO).undeployed})`);
    } finally {
      await serve.close();
    }
  });

  it('reuses a serve that does not say whose it is', async () => {
    const { startServeOrReuse } = await import('../lib/test/serve-manager.ts');
    const serve = await fakeServe();
    try {
      expect((await startServeOrReuse({ port: serve.port, network: 'undeployed', wallet: 'two' })).port).toBe(serve.port);
    } finally {
      await serve.close();
    }
  });
});
