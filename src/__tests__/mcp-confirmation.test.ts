import { describe, it, expect } from 'vitest';
import { createConfirmationStore } from '../lib/mcp/confirmation.ts';

describe('createConfirmationStore', () => {
  it('creates a pending operation with a unique token', () => {
    const store = createConfirmationStore();
    const a = store.create({ tool: 'midnight_transfer', args: { to: 'alice', amount: '10' }, description: 'Send 10' });
    const b = store.create({ tool: 'midnight_transfer', args: { to: 'bob', amount: '5' }, description: 'Send 5' });
    expect(a.token).not.toEqual(b.token);
    expect(store.size()).toBe(2);
  });

  it('redeem() returns the pending op and removes it (single-use)', () => {
    const store = createConfirmationStore();
    const pending = store.create({ tool: 'midnight_transfer', args: { x: 1 }, description: 'test' });
    const redeemed = store.redeem(pending.token);
    expect(redeemed?.tool).toBe('midnight_transfer');
    expect(redeemed?.args).toEqual({ x: 1 });
    expect(store.redeem(pending.token)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('redeem() returns null for unknown tokens', () => {
    const store = createConfirmationStore();
    expect(store.redeem('does-not-exist')).toBeNull();
  });

  it('expires pending ops after the TTL', () => {
    let t = 1_000_000;
    const store = createConfirmationStore({ ttlMs: 1000, now: () => t });
    const pending = store.create({ tool: 'midnight_transfer', args: {}, description: 'test' });
    t += 500;
    expect(store.redeem(pending.token)).not.toBeNull();
    // Recreate because redeem consumed it
    const p2 = store.create({ tool: 'midnight_transfer', args: {}, description: 'test' });
    t += 2000;
    expect(store.redeem(p2.token)).toBeNull();
  });

  it('sweep() removes expired entries without touching live ones', () => {
    let t = 0;
    const store = createConfirmationStore({ ttlMs: 100, now: () => t });
    store.create({ tool: 'a', args: {}, description: '' });
    store.create({ tool: 'b', args: {}, description: '' });
    t += 50;
    const fresh = store.create({ tool: 'c', args: {}, description: '' });
    t += 75; // first two expired (t=125), fresh still alive (expires at t=150)
    expect(store.sweep()).toBe(2);
    expect(store.size()).toBe(1);
    expect(store.redeem(fresh.token)?.tool).toBe('c');
  });

  it('auto-sweeps expired entries on create()', () => {
    let t = 0;
    const store = createConfirmationStore({ ttlMs: 100, now: () => t });
    store.create({ tool: 'a', args: {}, description: '' });
    store.create({ tool: 'b', args: {}, description: '' });
    expect(store.size()).toBe(2);
    t += 200; // both now expired
    store.create({ tool: 'c', args: {}, description: '' });
    // create() should have swept the two expired entries before inserting 'c'
    expect(store.size()).toBe(1);
  });

  it('sets expiresAt based on createdAt + ttl', () => {
    const store = createConfirmationStore({ ttlMs: 5000, now: () => 1000 });
    const pending = store.create({ tool: 'x', args: {}, description: '' });
    expect(pending.createdAt).toBe(1000);
    expect(pending.expiresAt).toBe(6000);
  });
});
