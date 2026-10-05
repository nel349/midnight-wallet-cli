// The indexer's latest ledger event id per stream, and the chain-reset check
// it feeds. A real in-process WebSocket server speaks the graphql-transport-ws
// handshake and answers the subscription the way the indexer does.

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { fetchEventTip, isCursorBeyondTip } from '../lib/event-tip.ts';

let servers: WebSocketServer[] = [];
afterEach(() => { for (const s of servers) s.close(); servers = []; });

/** An indexer stand-in: on subscribe, sends `events` as `next` payloads; records each subscription query. */
async function indexer(events: unknown[]): Promise<{ url: string; queries: string[] }> {
  const queries: string[] = [];
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'connection_init') ws.send(JSON.stringify({ type: 'connection_ack' }));
      else if (msg.type === 'subscribe') {
        queries.push(msg.payload.query);
        for (const data of events) ws.send(JSON.stringify({ id: msg.id, type: 'next', payload: { data } }));
      }
    });
  });
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
  const addr = wss.address();
  return { url: `ws://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`, queries };
}

describe('fetchEventTip', () => {
  it('reads the latest event id from the first Dust event, subscribing from event 0', async () => {
    const server = await indexer([{ dustLedgerEvents: { id: 0, maxId: 106 } }]);
    expect(await fetchEventTip(server.url, 'dust')).toBe(106);
    expect(server.queries).toEqual(['subscription { dustLedgerEvents(id: 0) { id maxId } }']);
  });

  it('reads the zswap stream for the shielded cache', async () => {
    const server = await indexer([{ zswapLedgerEvents: { id: 0, maxId: 41 } }]);
    expect(await fetchEventTip(server.url, 'zswap')).toBe(41);
  });

  it('is null when the stream has no events, or the indexer is unreachable', async () => {
    const empty = await indexer([]);
    expect(await fetchEventTip(empty.url, 'dust')).toBeNull();
    expect(await fetchEventTip('ws://127.0.0.1:9', 'dust')).toBeNull();
  }, 10_000);
});

describe('isCursorBeyondTip', () => {
  it('flags a cache past the chain\'s latest event (the chain was reset under it)', () => {
    expect(isCursorBeyondTip(500, 106)).toBe(true);
  });

  it('accepts a cache at or behind the tip, and makes no call when the tip is unknown', () => {
    expect(isCursorBeyondTip(106, 106)).toBe(false);
    expect(isCursorBeyondTip(40, 106)).toBe(false);
    expect(isCursorBeyondTip(500, null)).toBe(false);
  });
});
