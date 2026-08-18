import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import {
  resumeDecision,
  adaptResult,
  resolveSidecarBinary,
  nativeDustSyncAvailable,
  type SidecarCheckpoint,
} from '../lib/dust-sync-native.ts';
import { DUST_STATE_OWNED_HEX } from './fixtures/dust-state-owned.ts';

describe('resumeDecision (kill-safe resume)', () => {
  it('resumes from an existing checkpoint that already reaches the cursor', () => {
    // A prior run was killed at event 500000; the repo wants to resume at 300000.
    expect(resumeDecision(500_000, 300_000, true)).toBe('existing');
    expect(resumeDecision(500_000, 300_000, false)).toBe('existing');
  });

  it('resumes from an existing checkpoint exactly at the boundary', () => {
    // cursor 41 means "applied through 41"; startFromId 42 is the next event.
    expect(resumeDecision(41, 42, false)).toBe('existing');
  });

  it('seeds from repo state when no usable checkpoint but cache exists', () => {
    expect(resumeDecision(-2, 0, true)).toBe('seed'); // no file, fresh cursor, has cache
    expect(resumeDecision(100, 500, true)).toBe('seed'); // stale file behind cursor
  });

  it('starts fresh when there is nothing to resume from', () => {
    expect(resumeDecision(-2, 0, false)).toBe('fresh');
    expect(resumeDecision(50, 500, false)).toBe('fresh'); // stale file, no cache
  });
});

describe('adaptResult (sidecar checkpoint → DustDirectResult)', () => {
  const cpFor = (dustStateHex: string, over: Partial<SidecarCheckpoint> = {}): SidecarCheckpoint => ({
    dust_state: dustStateHex,
    last_applied_event_id: 42,
    owned_generation_indices: [3, 7],
    generation_frontier: 100,
    balance: '0',
    available_coins: 0,
    events_applied: 12345,
    partial: false,
    ...over,
  });

  it('maps a real funded dust state to the correct balance, coins, and retention', () => {
    const r = adaptResult(cpFor(DUST_STATE_OWNED_HEX));
    // Real fixture: one capped dust UTXO worth 500 (5e17 atomic).
    expect(r.balance).toBe(500_000_000_000_000_000n);
    expect(r.availableCoins).toBe(1);
    expect(r.ownedUtxoCount).toBe(1);
    // Metadata passes through unchanged.
    expect(r.lastAppliedEventId).toBe(42);
    expect(r.eventCount).toBe(12345);
    expect(r.partial).toBe(false);
    expect(r.retention.ownedGenerationIndices).toEqual([3, 7]);
    expect(r.retention.generationFrontier).toBe(100);
    // State is a usable ledger object carrying the same UTXO the balance came from.
    expect(r.state).toBeInstanceOf(ledger.DustLocalState);
    expect(r.state.utxos.length).toBe(r.ownedUtxoCount);
  });

  it('maps an empty state to a zero balance', () => {
    const empty = new ledger.DustLocalState(new ledger.DustParameters(5_000_000_000n, 8_267n, 10_800n));
    const hex = Buffer.from(empty.serialize()).toString('hex');
    const r = adaptResult(cpFor(hex, { partial: true, last_applied_event_id: -1 }));
    expect(r.balance).toBe(0n);
    expect(r.availableCoins).toBe(0);
    expect(r.partial).toBe(true);
    expect(r.lastAppliedEventId).toBe(-1);
  });
});

describe('binary resolution + gating', () => {
  const saved = { ...process.env };
  afterEach(() => {
    // restore only the vars we touch
    for (const k of ['MN_DUST_SYNC_BIN', 'MN_DISABLE_NATIVE_DUST']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it('honours the MN_DUST_SYNC_BIN override when the file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-dustbin-'));
    try {
      const bin = join(dir, 'dust-sync');
      writeFileSync(bin, '#!/bin/sh\n');
      process.env.MN_DUST_SYNC_BIN = bin;
      expect(resolveSidecarBinary()).toBe(bin);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('ignores a non-existent override path', () => {
    process.env.MN_DUST_SYNC_BIN = '/no/such/dust-sync-binary';
    // Falls through to the dev build or null — never returns the bad override.
    expect(resolveSidecarBinary()).not.toBe('/no/such/dust-sync-binary');
  });

  it('disables native sync when MN_DISABLE_NATIVE_DUST=1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-dustbin-'));
    try {
      const bin = join(dir, 'dust-sync');
      writeFileSync(bin, '#!/bin/sh\n');
      process.env.MN_DUST_SYNC_BIN = bin;
      process.env.MN_DISABLE_NATIVE_DUST = '1';
      expect(nativeDustSyncAvailable()).toBe(false); // gated off despite a resolvable binary
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
