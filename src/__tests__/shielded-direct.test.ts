import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { readShieldedBalanceDirect } from '../lib/shielded-direct.ts';
import { deriveShieldedSeed } from '../lib/derivation.ts';
import zswapEvents from './fixtures/zswap-events-localnet.json';

// Real zswap ledger events captured from a localnet chain where genesis
// (seed 0x01) airdropped shielded NIGHT to kuiratest twice (100M then a
// spend-with-change 25M), leaving genesis at 125M and kuiratest at 125M.
// The fixture is the FULL event stream; each wallet's balance is reconstructed
// by replaying it with that wallet's secret keys.
const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';
const KUIRATEST_SEED = '408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf705489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840';
const NIGHT_125M = 125_000_000_000_000n; // 125,000,000 NIGHT in atomic units

function secretKeysFor(seedHex: string): ledger.ZswapSecretKeys {
  return ledger.ZswapSecretKeys.fromSeed(deriveShieldedSeed(Buffer.from(seedHex, 'hex')));
}

/**
 * Minimal in-process indexer: speaks the graphql-transport-ws handshake and
 * replays the fixture's `zswapLedgerEvents` from the subscription's start index.
 * Stubs the external indexer boundary only — the reader under test is real.
 */
function startFakeIndexer(events: { id: number; raw: string; maxId: number }[]): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, handleProtocols: () => 'graphql-transport-ws' });
    wss.on('connection', (socket: WsSocket) => {
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'connection_init') {
          socket.send(JSON.stringify({ type: 'connection_ack' }));
          return;
        }
        if (msg.type === 'subscribe') {
          const startId: number = msg.payload?.variables?.id ?? 0;
          for (const e of events) {
            if (e.id < startId) continue;
            socket.send(JSON.stringify({ id: msg.id, type: 'next', payload: { data: { zswapLedgerEvents: e } } }));
          }
          // Leave the socket open; the reader finishes when it sees id >= maxId.
        }
      });
    });
    wss.on('listening', () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({
        url: `ws://127.0.0.1:${port}`,
        close: () => new Promise((r) => wss.close(() => r())),
      });
    });
  });
}

describe('readShieldedBalanceDirect', () => {
  let indexer: { url: string; close: () => Promise<void> };

  beforeAll(async () => { indexer = await startFakeIndexer(zswapEvents as any); });
  afterAll(async () => { await indexer.close(); });

  it('reconstructs the receiver balance from received coins', async () => {
    const r = await readShieldedBalanceDirect(secretKeysFor(KUIRATEST_SEED), indexer.url, { idleMs: 200 });
    expect(r.balance).toBe(NIGHT_125M);
    expect(r.availableCoins).toBe(2);
    expect(r.partial).toBe(false);
    expect(r.eventCount).toBe(zswapEvents.length);
  });

  it('removes SPENT coins for the spender (regression: was 250M over-count)', async () => {
    // Genesis started with 250M and spent 125M via the airdrops. If spends
    // weren't reconciled, this would read 250M — the bug this reader fixes.
    const r = await readShieldedBalanceDirect(secretKeysFor(GENESIS_SEED), indexer.url, { idleMs: 200 });
    expect(r.balance).toBe(NIGHT_125M);
    expect(r.availableCoins).toBe(3);
  });

  it('returns a zero balance for a wallet with no shielded coins', async () => {
    const stranger = '00000000000000000000000000000000000000000000000000000000000000ff';
    const r = await readShieldedBalanceDirect(secretKeysFor(stranger), indexer.url, { idleMs: 200 });
    expect(r.balance).toBe(0n);
    expect(r.availableCoins).toBe(0);
  });

  it('resumes from a cached state + cursor and matches a full replay', async () => {
    // Full replay of the first half, then resume from the checkpoint for the rest.
    const keys = secretKeysFor(GENESIS_SEED);
    const midId = zswapEvents[Math.floor(zswapEvents.length / 2)].id;

    const firstHalf = (zswapEvents as any[]).filter((e) => e.id <= midId).map((e) => ({ ...e, maxId: midId }));
    const partialIndexer = await startFakeIndexer(firstHalf);
    const first = await readShieldedBalanceDirect(keys, partialIndexer.url, { idleMs: 200 });
    await partialIndexer.close();
    expect(first.lastAppliedEventId).toBe(midId);

    // Resume against the full stream from the checkpoint — only the remaining
    // events are applied, and the final balance matches a from-scratch read.
    const resumed = await readShieldedBalanceDirect(keys, indexer.url, {
      idleMs: 200,
      initialState: first.state,
      startFromId: first.lastAppliedEventId + 1,
    });
    expect(resumed.balance).toBe(NIGHT_125M);
    expect(resumed.availableCoins).toBe(3);
  });
});
