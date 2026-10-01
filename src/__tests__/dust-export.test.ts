import { describe, it, expect } from 'vitest';
import * as ledger from '@midnightntwrk/ledger-v9';
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

// ── exportDustSnapshot orchestration ──────────────────────────────────────
// The command-facing entry point. It must route the sync through the repository
// (inheriting the native sidecar + partial-resume loop), surface `partial`, and
// take the snapshot state/offset from the returned view — not a cache re-read.
// buildFacade opens the node relay, so the base-dust build is stubbed to stay
// offline; the repository's fetchDust is faked to control the sync outcome, and
// a per-test temp cacheDir keeps disk state isolated.
import { beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportDustSnapshot } from '../lib/dust-export.ts';
import { WalletDataRepository } from '../lib/wallet-data-repository.ts';
import type { NetworkConfig } from '../lib/network.ts';
import type { DustDirectResult } from '../lib/dust-direct.ts';

const EXPORT_NETWORK: NetworkConfig = {
  indexer: 'http://test/indexer', indexerWS: 'ws://test/indexer/ws',
  node: 'ws://test/node', proofServer: 'http://test/proof', networkId: 'Undeployed',
};
const EXPORT_SEED = Buffer.from('11'.repeat(32), 'hex');
/** The chain answers as a ledger-9 localnet (keeps the ledger guard off the network). */
const LEDGER9_PROTOCOL = async () => 2001000n;

let EXPORT_TMP: string;
beforeEach(() => { EXPORT_TMP = mkdtempSync(join(tmpdir(), 'mn-export-test-')); });
afterEach(() => { rmSync(EXPORT_TMP, { recursive: true, force: true }); });

function fakeDust(state: ledger.DustLocalState, over: Partial<DustDirectResult> = {}): DustDirectResult {
  return {
    balance: 0n, availableCoins: 0, eventCount: 0, ownedUtxoCount: 0,
    syncTime: state.syncTime, state,
    retention: { ownedGenerationIndices: [], generationFrontier: 0 },
    lastAppliedEventId: 0, partial: false, ...over,
  };
}

function fakeRepo(result: DustDirectResult): WalletDataRepository {
  return new WalletDataRepository({ fetchProtocolVersion: LEDGER9_PROTOCOL,
    now: () => 1_000_000,
    fetchTip: async () => 'tip-A',
    fetchChainId: async () => null,           // skip the node RPC (offline)
    fetchUnshielded: async () => ({ balances: new Map(), utxoCount: 0, txCount: 0, highestTxId: 0, registeredUtxos: 0, unregisteredUtxos: 0 }),
    fetchDust: async () => result,
    cacheDir: EXPORT_TMP,
  });
}

describe('exportDustSnapshot', () => {
  const ownedState = ledger.DustLocalState.deserialize(Buffer.from(DUST_STATE_OWNED_HEX, 'hex'));

  it('routes through the repository, surfaces partial, and overlays the synced state', async () => {
    // partial:true drives the repo's bounded resume loop, so the export reports
    // the incomplete result rather than a false "warm" snapshot.
    const repo = fakeRepo(fakeDust(ownedState, { lastAppliedEventId: 42, balance: 500n, partial: true }));
    const res = await exportDustSnapshot(EXPORT_SEED, 'undeployed', EXPORT_NETWORK, {
      repository: repo,
      buildBaseDust: async () => baseSnapshot('0'),
    });
    expect(res.partial).toBe(true);          // the incomplete sync is reported
    expect(res.offset).toBe(42);             // offset comes from the view
    expect(res.balance).toBe(500n);
    expect(res.fromCache).toBe(false);
    // Snapshot was overlaid with the view's state + offset (not the empty base).
    const snap = JSON.parse(res.snapshot);
    expect(snap.offset).toBe('42');
    expect(snap.state).toBe(Buffer.from(ownedState.serialize()).toString('hex'));
    expect(snap.networkId).toBe('preview');  // base metadata preserved
  });

  it('reports partial: false for a completed sync', async () => {
    const repo = fakeRepo(fakeDust(ownedState, { lastAppliedEventId: 100, eventCount: 100, partial: false }));
    const res = await exportDustSnapshot(EXPORT_SEED, 'undeployed', EXPORT_NETWORK, {
      repository: repo,
      buildBaseDust: async () => baseSnapshot('0'),
    });
    expect(res.partial).toBe(false);
    expect(res.offset).toBe(100);
    expect(res.eventCount).toBe(100);
  });

  it('leaves the base snapshot untouched for a wallet with no dust events (offset -1)', async () => {
    const fresh = new ledger.DustLocalState(new ledger.DustParameters(5_000_000_000n, 8_267n, 10_800n));
    const repo = fakeRepo(fakeDust(fresh, { lastAppliedEventId: -1, eventCount: 0, partial: false }));
    const base = baseSnapshot('0');
    const res = await exportDustSnapshot(EXPORT_SEED, 'undeployed', EXPORT_NETWORK, {
      repository: repo,
      buildBaseDust: async () => base,
    });
    expect(res.offset).toBe(-1);
    expect(res.snapshot).toBe(base);         // no overlay applied
  });
});
