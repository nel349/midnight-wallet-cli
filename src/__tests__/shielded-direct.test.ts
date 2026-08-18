import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { readShieldedBalanceDirect } from '../lib/shielded-direct.ts';
import { deriveShieldedSeed } from '../lib/derivation.ts';
import zswapEvents from './fixtures/zswap-events-localnet.json';

// Real zswap ledger events captured from a fresh localnet chain. Seeds 0x01 and
// 0x02 are localnet genesis-funded wallets (250M shielded NIGHT each); genesis
// (0x01) airdropped 100M to 0x02, so 0x01 ends at 150M (a spend) and 0x02 at
// 350M (its 250M allocation + the 100M it received). All seeds are throwaway
// constants — no real wallet's seed is committed. The fixture is the FULL event
// stream; each wallet's balance is reconstructed by replaying it with that
// wallet's secret keys.
const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001'; // spender
const GENESIS2_SEED = '0000000000000000000000000000000000000000000000000000000000000002'; // received on top
const EMPTY_SEED = '00000000000000000000000000000000000000000000000000000000000000aa'; // non-genesis, no coins
const NIGHT_150M = 150_000_000_000_000n;
const NIGHT_350M = 350_000_000_000_000n;

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

  it('removes SPENT coins for the spender (regression: was a 250M over-count)', async () => {
    // Genesis started with a 250M allocation and spent 100M. If spends weren't
    // reconciled, this would read 250M — the bug this reader fixes.
    const r = await readShieldedBalanceDirect(secretKeysFor(GENESIS_SEED), indexer.url, { idleMs: 200 });
    expect(r.balance).toBe(NIGHT_150M);
    expect(r.availableCoins).toBe(3);
    expect(r.partial).toBe(false);
    expect(r.eventCount).toBe(zswapEvents.length);
  });

  it('adds received coins on top of an existing balance', async () => {
    // 0x02 holds its own 250M allocation AND the 100M it received from genesis.
    const r = await readShieldedBalanceDirect(secretKeysFor(GENESIS2_SEED), indexer.url, { idleMs: 200 });
    expect(r.balance).toBe(NIGHT_350M);
    expect(r.availableCoins).toBe(6);
  });

  it('returns a zero balance for a wallet with no shielded coins', async () => {
    const r = await readShieldedBalanceDirect(secretKeysFor(EMPTY_SEED), indexer.url, { idleMs: 200 });
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
    expect(resumed.balance).toBe(NIGHT_150M);
    expect(resumed.availableCoins).toBe(3);
  });
});
