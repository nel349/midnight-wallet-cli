import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { MIN_DUST_FOR_TRANSFER } from '../lib/constants.ts';
import { waitForFeeDust } from '../lib/test/fee-dust.ts';
import { probeServeDust } from '../lib/test/serve-manager.ts';

const ENOUGH = MIN_DUST_FOR_TRANSFER;
const SHORT = MIN_DUST_FOR_TRANSFER / 2n;

describe('waitForFeeDust', () => {
  it('goes ahead at once when the wallet has the Dust a transaction needs', async () => {
    let reads = 0;
    await waitForFeeDust(async () => { reads++; return ENOUGH; }, { intervalMs: 1 });
    expect(reads).toBe(1);
  });

  it('waits while Dust regrows after a fee, saying how much there is', async () => {
    const readings = [SHORT, SHORT + 1n, ENOUGH];
    const messages: string[] = [];
    await waitForFeeDust(async () => readings.shift() ?? ENOUGH, { intervalMs: 1, onMessage: (m) => messages.push(m) });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe('Waiting for Dust to regrow: 0.400000 of the 0.800000 DUST a transaction needs');
  });

  it('fails with the amounts when Dust does not regrow in time', async () => {
    await expect(waitForFeeDust(async () => SHORT, { timeoutMs: 40, intervalMs: 10 }))
      .rejects.toThrow(/Only 0\.400000 DUST after waiting 0s, and a transaction needs 0\.800000/);
  });

  it('does not wait when the balance cannot be read: the transaction speaks for itself', async () => {
    let reads = 0;
    await waitForFeeDust(async () => { reads++; return null; }, { timeoutMs: 5_000, intervalMs: 1 });
    expect(reads).toBe(1);
  });
});

describe('probeServeDust', () => {
  /** A JSON-RPC WebSocket server answering getDustBalance with `result`, as `mn serve` does. */
  async function serveAnswering(result: unknown) {
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const asked: string[] = [];
    wss.on('connection', (ws) => ws.on('message', (data) => {
      const req = JSON.parse(data.toString());
      asked.push(req.method);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
    }));
    return { port: (wss.address() as AddressInfo).port, asked, close: () => new Promise<void>((r) => wss.close(() => r())) };
  }

  it("reads the served wallet's spendable Dust in specks", async () => {
    const serve = await serveAnswering({ cap: '824909549999997', balance: '824909549999997' });
    try {
      expect(await probeServeDust(serve.port)).toBe(824909549999997n);
      expect(serve.asked).toEqual(['getDustBalance']);
    } finally {
      await serve.close();
    }
  });

  it('is null when the serve gives no balance, or one that is not a number', async () => {
    for (const result of [null, {}, { balance: 'lots' }]) {
      const serve = await serveAnswering(result);
      try {
        expect(await probeServeDust(serve.port)).toBeNull();
      } finally {
        await serve.close();
      }
    }
  });
});
