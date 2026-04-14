// Unit tests for checkBalance — stubs the `ws` module at the boundary.
// Covers the registered/unregistered UTXO counts used by the fast dust-status path.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { NATIVE_TOKEN_TYPE } from '../lib/constants.ts';

type FakeWs = EventEmitter & {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const { socketRef } = vi.hoisted(() => ({
  socketRef: {} as { current?: EventEmitter & { send: any; close: any } },
}));

vi.mock('ws', async () => {
  const { EventEmitter: EE } = await import('events');
  class WS extends EE {
    send = vi.fn();
    close = vi.fn();
    constructor() {
      super();
      socketRef.current = this as any;
      setImmediate(() => this.emit('open'));
    }
  }
  return { default: WS };
});

let checkBalance: typeof import('../lib/balance-subscription.ts').checkBalance;
beforeAll(async () => {
  ({ checkBalance } = await import('../lib/balance-subscription.ts'));
});

const OTHER_TOKEN = 'ff'.repeat(32);

function sendNext(socket: FakeWs, event: unknown) {
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'next',
    payload: { data: { unshieldedTransactions: event } },
  })));
}

function ack(socket: FakeWs) {
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'connection_ack' })));
}

function tx(opts: {
  id: number;
  created?: Array<{ value: string; tokenType?: string; registered?: boolean; key?: string }>;
  spent?: Array<{ key: string }>;
}) {
  return {
    __typename: 'UnshieldedTransaction',
    transaction: { id: opts.id, hash: `h${opts.id}` },
    createdUtxos: (opts.created ?? []).map((u, i) => ({
      value: u.value,
      owner: 'owner',
      tokenType: u.tokenType ?? NATIVE_TOKEN_TYPE,
      intentHash: u.key ?? `ih${opts.id}-${i}`,
      outputIndex: 0,
      registeredForDustGeneration: u.registered === true,
    })),
    spentUtxos: (opts.spent ?? []).map((u) => ({
      value: '0',
      owner: 'owner',
      tokenType: NATIVE_TOKEN_TYPE,
      intentHash: u.key,
      outputIndex: 0,
      registeredForDustGeneration: false,
    })),
  };
}

function progress(highest: number) {
  return { __typename: 'UnshieldedTransactionsProgress', highestTransactionId: highest };
}

describe('checkBalance — registered/unregistered counts', () => {
  beforeEach(() => { socketRef.current = undefined; });
  afterEach(() => { vi.clearAllMocks(); });

  it('counts unspent NIGHT UTXOs by registration flag', async () => {
    const promise = checkBalance('addr1', 'ws://fake');

    // Wait for the subscription to open.
    await new Promise((r) => setImmediate(r));
    const ws = socketRef.current!;
    ack(ws);

    sendNext(ws, tx({
      id: 1,
      created: [
        { value: '100', registered: true, key: 'a' },
        { value: '200', registered: false, key: 'b' },
        { value: '300', registered: true, key: 'c' },
      ],
    }));
    sendNext(ws, progress(1));

    const result = await promise;
    expect(result.registeredUtxos).toBe(2);
    expect(result.unregisteredUtxos).toBe(1);
    expect(result.utxoCount).toBe(3);
    expect(result.balances.get(NATIVE_TOKEN_TYPE)).toBe(600n);
  });

  it('excludes spent UTXOs from both counts', async () => {
    const promise = checkBalance('addr2', 'ws://fake');
    await new Promise((r) => setImmediate(r));
    const ws = socketRef.current!;
    ack(ws);

    sendNext(ws, tx({
      id: 1,
      created: [
        { value: '100', registered: true, key: 'a' },
        { value: '200', registered: false, key: 'b' },
      ],
    }));
    sendNext(ws, tx({ id: 2, spent: [{ key: 'a' }] }));
    sendNext(ws, progress(2));

    const result = await promise;
    expect(result.registeredUtxos).toBe(0);
    expect(result.unregisteredUtxos).toBe(1);
  });

  it('does not count non-native token UTXOs as registered/unregistered', async () => {
    const promise = checkBalance('addr3', 'ws://fake');
    await new Promise((r) => setImmediate(r));
    const ws = socketRef.current!;
    ack(ws);

    sendNext(ws, tx({
      id: 1,
      created: [
        { value: '500', tokenType: OTHER_TOKEN, registered: false, key: 'a' },
        { value: '100', registered: true, key: 'b' },
      ],
    }));
    sendNext(ws, progress(1));

    const result = await promise;
    expect(result.registeredUtxos).toBe(1);
    expect(result.unregisteredUtxos).toBe(0);
    expect(result.utxoCount).toBe(2);
  });

  it('returns zero counts for empty address', async () => {
    const promise = checkBalance('addr4', 'ws://fake');
    await new Promise((r) => setImmediate(r));
    const ws = socketRef.current!;
    ack(ws);

    sendNext(ws, progress(0));

    const result = await promise;
    expect(result.registeredUtxos).toBe(0);
    expect(result.unregisteredUtxos).toBe(0);
    expect(result.utxoCount).toBe(0);
  });
});
