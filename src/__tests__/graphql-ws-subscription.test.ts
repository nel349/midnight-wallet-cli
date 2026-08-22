// Settle-semantics tests for the shared graphql-transport-ws driver. Spins up a
// real in-process WebSocket server that speaks the graphql-transport-ws handshake
// so each finish reason (caught-up / idle / timeout / graceful-close /
// closed-early / initial-silence / error / abort) is exercised end-to-end.

import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';

import { subscribeGraphqlWs } from '../lib/graphql-ws-subscription.ts';

type ServerScript = (ws: WsSocket) => void;

let servers: WebSocketServer[] = [];
afterEach(() => { for (const s of servers) s.close(); servers = []; });

/** Start a ws server that ACKs the handshake then runs `script` after `subscribe`. */
async function startServer(script: ServerScript): Promise<string> {
  const wss = new WebSocketServer({ port: 0 });
  servers.push(wss);
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'connection_init') ws.send(JSON.stringify({ type: 'connection_ack' }));
      else if (msg.type === 'subscribe') script(ws);
    });
  });
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()));
  const addr = wss.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return `ws://localhost:${port}`;
}

const next = (data: unknown) => JSON.stringify({ id: '1', type: 'next', payload: { data } });

// A subscription that finishes as soon as onNext sees `{ done: true }`.
interface SubOverrides {
  idleMs?: number;
  timeoutMs?: number;
  initialSilenceMs?: number;
  idleBeforeFirstEvent?: boolean;
  signal?: AbortSignal;
}

function sub(url: string, opts: SubOverrides = {}) {
  const seen: unknown[] = [];
  return {
    seen,
    run: subscribeGraphqlWs<{ seen: unknown[]; partial: boolean }>(url, {
      query: 'subscription { x }',
      variables: {},
      idleMs: 100,
      timeoutMs: 2_000,
      onNext: (d) => { seen.push(d); return (d as { done?: boolean })?.done === true; },
      buildResult: (partial) => ({ seen, partial }),
      ...opts,
    }),
  };
}

describe('subscribeGraphqlWs — settle semantics', () => {
  it('caught-up: onNext returning true resolves partial=false', async () => {
    const url = await startServer((ws) => ws.send(next({ done: true })));
    const r = await sub(url).run;
    expect(r.partial).toBe(false);
    expect(r.seen).toEqual([{ done: true }]);
  });

  it('idle: events then silence resolves partial=false after idleMs', async () => {
    const url = await startServer((ws) => ws.send(next({ done: false })));
    const r = await sub(url).run;
    expect(r.partial).toBe(false);
    expect(r.seen.length).toBe(1);
  });

  it('graceful-close: close with no events resolves partial=false', async () => {
    const url = await startServer((ws) => ws.close());
    const r = await sub(url).run;
    expect(r.partial).toBe(false);
    expect(r.seen.length).toBe(0);
  });

  it('closed-early: close AFTER an event resolves partial=true (resumable)', async () => {
    const url = await startServer((ws) => { ws.send(next({ done: false })); setTimeout(() => ws.close(), 20); });
    // idle is 100ms; the 20ms close beats it, so the outcome is closed-early.
    const r = await sub(url, { idleMs: 5_000 }).run;
    expect(r.partial).toBe(true);
    expect(r.seen.length).toBe(1);
  });

  it('timeout: never caught up, idle disabled, resolves partial=true', async () => {
    const url = await startServer((ws) => ws.send(next({ done: false })));
    // idleMs > timeoutMs so the soft-timeout fires first.
    const r = await sub(url, { idleMs: 60_000, timeoutMs: 150 }).run;
    expect(r.partial).toBe(true);
  });

  it('initial-silence: resume with no events resolves partial=false quickly', async () => {
    const url = await startServer(() => { /* ack+subscribe, then send nothing */ });
    const r = await sub(url, { initialSilenceMs: 80, idleMs: 60_000, timeoutMs: 60_000 }).run;
    expect(r.partial).toBe(false);
    expect(r.seen.length).toBe(0);
  });

  it('idleBeforeFirstEvent=false: empty stream does NOT idle-finish (waits for timeout)', async () => {
    const url = await startServer(() => { /* send nothing */ });
    // No initial-silence, idle only counts after first event → only timeout ends it.
    const r = await sub(url, { idleMs: 50, timeoutMs: 250 }).run;
    expect(r.partial).toBe(true); // timed out, never idle-finished on an empty stream
  });

  it('subscription error rejects', async () => {
    const url = await startServer((ws) => ws.send(JSON.stringify({ type: 'error', payload: { m: 'boom' } })));
    await expect(sub(url).run).rejects.toThrow(/GraphQL subscription error/);
  });

  it('GraphQL errors in a next payload reject', async () => {
    const url = await startServer((ws) => ws.send(JSON.stringify({ id: '1', type: 'next', payload: { errors: [{ message: 'bad' }] } })));
    await expect(sub(url).run).rejects.toThrow(/GraphQL error: bad/);
  });

  it('abort rejects with Operation cancelled', async () => {
    const url = await startServer((ws) => ws.send(next({ done: false })));
    const ac = new AbortController();
    const p = sub(url, { idleMs: 60_000, timeoutMs: 60_000, signal: ac.signal }).run;
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toThrow(/Operation cancelled/);
  });

  it('a throw inside onNext rejects with that error', async () => {
    const url = await startServer((ws) => ws.send(next({ done: false })));
    const p = subscribeGraphqlWs(url, {
      query: 'q', variables: {}, idleMs: 60_000, timeoutMs: 60_000,
      onNext: () => { throw new Error('parse failed'); },
      buildResult: (partial) => ({ partial }),
    });
    await expect(p).rejects.toThrow(/parse failed/);
  });
});
