import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ledger from '@midnightntwrk/ledger-v9';
import {
  resumeDecision,
  adaptResult,
  resolveSidecarBinary,
  nativeDustSyncAvailable,
  runDustSyncNative,
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

  it('never selects the ledger-8 sidecar on this ledger-9 build, even with a resolvable binary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mn-dustbin-'));
    try {
      const bin = join(dir, 'dust-sync');
      writeFileSync(bin, '#!/bin/sh\n');
      process.env.MN_DUST_SYNC_BIN = bin;
      delete process.env.MN_DISABLE_NATIVE_DUST;
      expect(resolveSidecarBinary()).toBe(bin);
      expect(nativeDustSyncAvailable()).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
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

describe('runDustSyncNative exit handling (fake sidecar binary)', () => {
  // The sidecar is an external process: a shell script stands in for it,
  // writing a valid checkpoint to --out and exiting with a chosen code.
  const saved = { ...process.env };
  let dir: string;
  afterEach(() => {
    for (const k of ['MN_DUST_SYNC_BIN', 'HOME']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeSidecar(exitCode: number): void {
    dir = mkdtempSync(join(tmpdir(), 'mn-fake-sidecar-'));
    const cp = JSON.stringify({
      dust_state: DUST_STATE_OWNED_HEX, last_applied_event_id: 7, owned_generation_indices: [],
      generation_frontier: 0, balance: '0', available_coins: 0, events_applied: 7, partial: false,
    });
    const bin = join(dir, 'dust-sync');
    writeFileSync(bin, [
      '#!/bin/sh',
      'cat > /dev/null',
      'while [ $# -gt 0 ]; do if [ "$1" = "--out" ]; then OUT="$2"; fi; shift; done',
      `printf '%s' '${cp}' > "$OUT"`,
      `exit ${exitCode}`,
    ].join('\n'), { mode: 0o755 });
    process.env.MN_DUST_SYNC_BIN = bin;
    process.env.HOME = dir;
  }

  const network = { indexer: 'http://x', indexerWS: 'ws://x', node: 'ws://x', proofServer: 'http://x', networkId: 'Undeployed' };
  const seed = Buffer.alloc(32, 7);

  it('accepts the checkpoint from a clean exit (control: the fake binary works)', async () => {
    fakeSidecar(0);
    const r = await runDustSyncNative(seed, network, { startFromId: 0 });
    expect(r.lastAppliedEventId).toBe(7);
  });

  it('rejects a failed run even though a checkpoint file exists, so the caller falls back', async () => {
    // A ledger-8 sidecar on a ledger-9 chain dies like this (exit 2) after a
    // checkpoint already sits at --out; parsing it as success froze dust.
    fakeSidecar(2);
    await expect(runDustSyncNative(seed, network, { startFromId: 0 })).rejects.toThrow('dust-sync exited 2');
  });
});

describe('adaptResult — native-path generation-tree collapse', () => {
  // The Rust sidecar returns an UNcollapsed state; adaptResult applies the same TS
  // collapse the WASM reader uses so the fast/default path is also lean-restart.
  // The size win (~1.46 MB → ~23 KB) only shows at ~1.4M generations on real synced
  // state, so it's verified live, not here (and collapseForeignGenerations itself is
  // covered by dust-collapse.test.ts). This locks the invariants on the new branch:
  // both collapse-on and collapse-off run without error and preserve balance, owned
  // retention, and the generation-tree root.
  function stateWithForeignLeaves(n: number, ownedIdx: number): ledger.DustLocalState {
    const owner = ledger.sampleDustSecretKey().publicKey;
    const intent = ledger.sampleIntentHash();
    let s = new ledger.DustLocalState(new ledger.DustParameters(5_000_000_000n, 8_267n, 10_800n));
    for (let i = 0; i < n; i++) {
      s = s.insertGenerationInfo(BigInt(i), {
        value: 1_000_000n + BigInt(i),
        owner,
        nonce: ledger.dustInitialNonce(BigInt(i), intent),
        dtime: undefined,
      } as unknown as ledger.DustGenerationInfo);
    }
    return s;
  }

  const cpFor = (dustStateHex: string, over: Partial<SidecarCheckpoint> = {}): SidecarCheckpoint => ({
    dust_state: dustStateHex, last_applied_event_id: 100, owned_generation_indices: [3],
    generation_frontier: 8, balance: '0', available_coins: 0, events_applied: 8, partial: false, ...over,
  });

  it('collapse-on and collapse-off preserve balance, retention, and the tree root', () => {
    // owned index 3; foreign ranges [0,2] and [4,7] → collapseForeignGenerations runs.
    const hex = Buffer.from(stateWithForeignLeaves(8, 3).serialize()).toString('hex');
    const cp = cpFor(hex, { owned_generation_indices: [3], generation_frontier: 8 });

    const on = adaptResult(cp);
    process.env.MN_DISABLE_DUST_COLLAPSE = '1';
    let off: ReturnType<typeof adaptResult>;
    try { off = adaptResult(cp); } finally { delete process.env.MN_DISABLE_DUST_COLLAPSE; }

    expect(on.balance).toBe(off.balance);                                   // collapse never moves the balance
    expect(on.retention.ownedGenerationIndices).toEqual([3]);              // owned indices pass through
    expect(on.state.generatingTreeRoot()).toBe(off.state.generatingTreeRoot()); // root invariant held
  });
});
