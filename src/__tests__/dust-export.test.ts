import { describe, it, expect } from 'vitest';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { overlayDustDirectSnapshot } from '../lib/facade.ts';
import type { DustCacheEntry } from '../lib/dust-direct-cache.ts';
import { DUST_STATE_OWNED_HEX } from './fixtures/dust-state-owned.ts';

// overlayDustDirectSnapshot is the seam behind `dust export` (and the write-command
// bridge): it swaps a facade dust snapshot's state+offset for a dust-direct checkpoint
// while preserving publicKey/protocolVersion/networkId. These are the invariants a
// restore on another wallet depends on.

function entry(state: ledger.DustLocalState, lastAppliedEventId: number): DustCacheEntry {
  return { state, lastAppliedEventId, retention: { ownedGenerationIndices: [], generationFrontier: 0 } };
}

function baseSnapshot(offset?: string): string {
  const snap: Record<string, unknown> = {
    publicKey: { publicKey: '42' },
    state: '00',
    protocolVersion: '0',
    networkId: 'preview',
  };
  if (offset !== undefined) snap.offset = offset;
  return JSON.stringify(snap);
}

describe('overlayDustDirectSnapshot', () => {
  const ownedState = ledger.DustLocalState.deserialize(Buffer.from(DUST_STATE_OWNED_HEX, 'hex'));
  const ownedHex = Buffer.from(ownedState.serialize()).toString('hex');

  it('overlays the dust-direct state + offset, preserving base metadata', () => {
    const out = JSON.parse(overlayDustDirectSnapshot(baseSnapshot('5'), entry(ownedState, 100)));
    expect(out.state).toBe(ownedHex);
    expect(out.offset).toBe('100');
    expect(out.publicKey).toEqual({ publicKey: '42' });
    expect(out.protocolVersion).toBe('0');
    expect(out.networkId).toBe('preview');
  });

  it('overlays unconditionally — even when the base offset is already higher (the freshness guard lives in the caller)', () => {
    const out = JSON.parse(overlayDustDirectSnapshot(baseSnapshot('200'), entry(ownedState, 100)));
    expect(out.offset).toBe('100');
    expect(out.state).toBe(ownedHex);
  });

  it('overlays a checkpoint whose last event id is exactly 0 (regression: base offset "0" must not skip it)', () => {
    // A fresh base facade snapshot always carries offset "0". A genuine checkpoint at
    // event id 0 must still apply — otherwise an empty snapshot ships with a non-zero balance.
    const out = JSON.parse(overlayDustDirectSnapshot(baseSnapshot('0'), entry(ownedState, 0)));
    expect(out.offset).toBe('0');
    expect(out.state).toBe(ownedHex);
    expect(ledger.DustLocalState.deserialize(Buffer.from(out.state, 'hex')).walletBalance(new Date()))
      .toBe(ownedState.walletBalance(new Date()));
  });

  it('overlays with a missing base offset', () => {
    const out = JSON.parse(overlayDustDirectSnapshot(baseSnapshot(), entry(ownedState, 0)));
    expect(out.offset).toBe('0');
    expect(out.state).toBe(ownedHex);
  });

  it('overlays a fresh (empty) dust state', () => {
    const fresh = new ledger.DustLocalState(new ledger.DustParameters(5_000_000_000n, 8_267n, 3n * 60n * 60n));
    const out = JSON.parse(overlayDustDirectSnapshot(baseSnapshot('0'), entry(fresh, 7)));
    expect(out.offset).toBe('7');
    expect(out.state).toBe(Buffer.from(fresh.serialize()).toString('hex'));
  });

  it('produces a snapshot whose state deserializes back to the same dust balance', () => {
    const out = JSON.parse(overlayDustDirectSnapshot(baseSnapshot('1'), entry(ownedState, 50)));
    const restored = ledger.DustLocalState.deserialize(Buffer.from(out.state, 'hex'));
    const now = new Date();
    expect(restored.walletBalance(now)).toBe(ownedState.walletBalance(now));
  });
});
