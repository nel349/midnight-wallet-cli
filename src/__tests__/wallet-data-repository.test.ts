// Boundary tests for WalletDataRepository.
// Uses the four constructor seams (now, fetchTip, fetchUnshielded, fetchDust)
// to exercise cache + tip + invalidation logic without touching the network,
// the SDK, or the proof server. cacheDir points at a per-test tmp directory.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import * as ledger from '@midnight-ntwrk/ledger-v8';

import { WalletDataRepository, type DustView, type UnshieldedView, type RepoDeps } from '../lib/wallet-data-repository.ts';
import type { NetworkConfig } from '../lib/network.ts';
import type { BalanceSummary } from '../lib/balance-subscription.ts';
import type { DustDirectResult } from '../lib/dust-direct.ts';

// ── Test fixtures ─────────────────────────────────────────

const NETWORK: NetworkConfig = {
  indexer: 'http://test/indexer',
  indexerWS: 'ws://test/indexer/ws',
  node: 'ws://test/node',
  proofServer: 'http://test/proof',
  networkId: 'Undeployed',
};

const SEED = Buffer.from('11'.repeat(32), 'hex');

function fakeBalanceSummary(extra: Partial<BalanceSummary> = {}): BalanceSummary {
  return {
    balances: new Map(),
    utxoCount: 0,
    txCount: 0,
    highestTxId: 0,
    registeredUtxos: 0,
    unregisteredUtxos: 0,
    ...extra,
  };
}

function fakeDustResult(overrides: Partial<DustDirectResult> = {}): DustDirectResult {
  // Build a minimal real DustLocalState — repo doesn't introspect it, just
  // holds a reference and serializes it via saveDustCache.
  const params = new ledger.DustParameters(5_000_000_000n, 8_267n, 10_800n);
  const state = new ledger.DustLocalState(params);
  return {
    balance: 0n,
    availableCoins: 0,
    eventCount: 0,
    ownedUtxoCount: 0,
    syncTime: state.syncTime,
    state,
    retention: { ownedGenerationIndices: [], generationFrontier: 0 },
    lastAppliedEventId: 5,
    partial: false,
    ...overrides,
  };
}

let TMP: string;
beforeEach(() => { TMP = mkdtempSync(join(tmpdir(), 'mn-repo-test-')); });
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

// ── Tests ─────────────────────────────────────────────────

describe('WalletDataRepository — unshielded reads', () => {
  it('serves a memo hit when the chain tip has not changed', async () => {
    let tipCalls = 0, fetchCalls = 0;
    const repo = new WalletDataRepository({
      now: () => 1_000_000,
      fetchTip: async () => { tipCalls++; return 'tip-A'; },
      fetchUnshielded: async () => { fetchCalls++; return fakeBalanceSummary({ utxoCount: 3 }); },
      fetchDust: async () => fakeDustResult(),
      cacheDir: TMP,
    });

    const first = await repo.unshielded('addr-1', NETWORK);
    expect(first.fromCache).toBe(false);
    expect(first.utxoCount).toBe(3);

    const second = await repo.unshielded('addr-1', NETWORK);
    expect(second.fromCache).toBe(true);
    expect(fetchCalls).toBe(1);              // fetcher NOT called twice
    expect(tipCalls).toBeLessThanOrEqual(1); // tip memo'd inside its TTL
  });

  it('refetches when the chain tip changes between calls', async () => {
    let tip = 'tip-A', fetchCalls = 0;
    let nowMs = 1_000_000;
    const repo = new WalletDataRepository({
      now: () => nowMs,
      fetchTip: async () => tip,
      fetchUnshielded: async () => { fetchCalls++; return fakeBalanceSummary({ utxoCount: fetchCalls }); },
      fetchDust: async () => fakeDustResult(),
      cacheDir: TMP,
    });

    await repo.unshielded('addr-1', NETWORK);

    tip = 'tip-B';
    nowMs += 60_000; // step past tip-probe TTL so we re-fetch the tip

    const refresh = await repo.unshielded('addr-1', NETWORK);
    expect(refresh.fromCache).toBe(false);
    expect(fetchCalls).toBe(2);
  });

  it('forceFresh bypasses the memo even when the tip is unchanged', async () => {
    let fetchCalls = 0;
    const repo = new WalletDataRepository({
      now: () => 1_000_000,
      fetchTip: async () => 'tip-A',
      fetchUnshielded: async () => { fetchCalls++; return fakeBalanceSummary(); },
      fetchDust: async () => fakeDustResult(),
      cacheDir: TMP,
    });

    await repo.unshielded('addr-1', NETWORK);
    const fresh = await repo.unshielded('addr-1', NETWORK, { forceFresh: true });
    expect(fresh.fromCache).toBe(false);
    expect(fetchCalls).toBe(2);
  });

  it('serves cached value when the tip-check itself fails (network down)', async () => {
    let fetchCalls = 0;
    let tipShouldFail = false;
    const repo = new WalletDataRepository({
      now: () => 1_000_000,
      fetchTip: async () => {
        if (tipShouldFail) throw new Error('ECONNREFUSED');
        return 'tip-A';
      },
      fetchUnshielded: async () => { fetchCalls++; return fakeBalanceSummary({ utxoCount: 7 }); },
      fetchDust: async () => fakeDustResult(),
      cacheDir: TMP,
    });

    // Prime the memo, then break the tip and step past the TTL.
    await repo.unshielded('addr-1', NETWORK);
    tipShouldFail = true;
    repo.resetTipMemo();

    const offline = await repo.unshielded('addr-1', NETWORK);
    expect(offline.utxoCount).toBe(7);
    expect(fetchCalls).toBe(1); // still no second network fetch
  });
});

describe('WalletDataRepository — dust reads', () => {
  it('hits the in-memory memo on the second call within the same tip', async () => {
    let fetchCalls = 0;
    const repo = new WalletDataRepository({
      now: () => 1_000_000,
      fetchTip: async () => 'tip-A',
      fetchUnshielded: async () => fakeBalanceSummary(),
      fetchDust: async () => { fetchCalls++; return fakeDustResult(); },
      cacheDir: TMP,
    });

    await repo.dust(SEED, NETWORK);
    const second = await repo.dust(SEED, NETWORK);
    expect(second.fromCache).toBe(true);
    expect(fetchCalls).toBe(1);
  });

  it('auto-resumes when fetchDust returns partial: true (cold preprod path)', async () => {
    // Simulate: indexer streams 250 events per call, returns partial: true
    // until we've consumed 1000 events worth (4 calls). Each returns the
    // fakeDustResult with lastAppliedEventId advancing by 250 each time.
    const startIds: number[] = [];
    let nextLastEventId = 249;
    const repo = new WalletDataRepository({
      now: () => 1_000_000,
      fetchTip: async () => 'tip-A',
      fetchUnshielded: async () => fakeBalanceSummary(),
      fetchDust: async (_seed, _net, opts) => {
        startIds.push(opts.startFromId);
        const result = fakeDustResult({
          lastAppliedEventId: nextLastEventId,
          eventCount: 250,
          partial: nextLastEventId < 999, // catch up after id 999
        });
        // Persist via the checkpoint callback the repo wires in.
        opts.onCheckpoint?.(result.state, result.lastAppliedEventId, result.retention);
        nextLastEventId += 250;
        return result;
      },
      cacheDir: TMP,
    });

    const view = await repo.dust(SEED, NETWORK);
    expect(startIds).toEqual([0, 250, 500, 750]); // each call resumed from prior checkpoint
    expect(view.eventsApplied).toBe(1000);         // sum across 4 calls
    expect(view.fromCache).toBe(false);            // we started cold
  });

  it('forceFresh on dust bypasses both memos and disk cache', async () => {
    let fetchCalls = 0;
    let lastStartFromId = -999;
    const repo = new WalletDataRepository({
      now: () => 1_000_000,
      fetchTip: async () => 'tip-A',
      fetchUnshielded: async () => fakeBalanceSummary(),
      fetchDust: async (_seed, _net, opts) => {
        fetchCalls++;
        lastStartFromId = opts.startFromId;
        return fakeDustResult();
      },
      cacheDir: TMP,
    });

    await repo.dust(SEED, NETWORK);                       // 1st: starts at 0
    expect(lastStartFromId).toBe(0);
    await repo.dust(SEED, NETWORK, { forceFresh: true }); // forceFresh: start back at 0, ignore disk
    expect(fetchCalls).toBe(2);
    expect(lastStartFromId).toBe(0);
  });
});

describe('WalletDataRepository — invalidation', () => {
  it('invalidate() drops the dust + unshielded memo entries for the given seed/network', async () => {
    let dustCalls = 0, unshieldedCalls = 0;
    const repo = new WalletDataRepository({
      now: () => 1_000_000,
      fetchTip: async () => 'tip-A',
      fetchUnshielded: async () => { unshieldedCalls++; return fakeBalanceSummary(); },
      fetchDust: async () => { dustCalls++; return fakeDustResult(); },
      cacheDir: TMP,
    });

    await repo.dust(SEED, NETWORK);
    await repo.unshielded(SEED, NETWORK);
    expect(dustCalls).toBe(1);
    expect(unshieldedCalls).toBe(1);

    repo.invalidate({ network: NETWORK, seed: SEED });

    await repo.dust(SEED, NETWORK);
    await repo.unshielded(SEED, NETWORK);
    expect(dustCalls).toBe(2);
    expect(unshieldedCalls).toBe(2);
  });

  it('invalidate() with kinds: ["dust"] leaves the unshielded memo intact', async () => {
    let dustCalls = 0, unshieldedCalls = 0;
    const repo = new WalletDataRepository({
      now: () => 1_000_000,
      fetchTip: async () => 'tip-A',
      fetchUnshielded: async () => { unshieldedCalls++; return fakeBalanceSummary(); },
      fetchDust: async () => { dustCalls++; return fakeDustResult(); },
      cacheDir: TMP,
    });

    await repo.dust(SEED, NETWORK);
    await repo.unshielded(SEED, NETWORK);

    repo.invalidate({ network: NETWORK, seed: SEED, kinds: ['dust'] });

    const dustAgain = await repo.dust(SEED, NETWORK);
    const unshieldedAgain = await repo.unshielded(SEED, NETWORK);
    // Network was hit again for dust (memo dropped), but the disk checkpoint
    // from the first call survived → fromCache is true (delta-resume counts).
    expect(dustCalls).toBe(2);                    // network hit, memo was dropped
    expect(dustAgain.fromCache).toBe(true);       // disk-resume from prior save
    expect(dustAgain.eventsApplied).toBe(0);      // fakeDustResult returns 0 new events
    expect(unshieldedAgain.fromCache).toBe(true); // still memo'd
    expect(unshieldedCalls).toBe(1);              // no network hit
  });
});

// ── Cache chain-reset guard (regression: dead genesis-hash guard) ──────────
// Previously the repo called validateDustCacheChainId with args in the wrong
// order (node URL slot got the pubkey) AND always saved chainId=undefined, so
// the guard never wiped anything — a chain reset surfaced a stale balance from
// the old chain's coins. These lock both halves via the fetchChainId seam.

/** Read the single dust-*.json cache file written under TMP, or null. */
function readDustCacheFile(): { chainId?: string; lastAppliedEventId?: number } | null {
  for (const net of readdirSync(TMP)) {
    let files: string[] = [];
    try { files = readdirSync(join(TMP, net)); } catch { continue; }
    const f = files.find((x) => x.startsWith('dust-') && x.endsWith('.json'));
    if (f) return JSON.parse(readFileSync(join(TMP, net, f), 'utf-8'));
  }
  return null;
}

describe('WalletDataRepository — dust cache chain-reset guard', () => {
  const mkRepo = (chainId: string, fetchDust: NonNullable<RepoDeps['fetchDust']>) =>
    new WalletDataRepository({
      fetchTip: async () => 'tip-A',
      fetchUnshielded: async () => fakeBalanceSummary(),
      fetchDust,
      fetchChainId: async () => chainId,
      cacheDir: TMP,
    });

  it('persists the chain genesis hash into the dust cache on save', async () => {
    await mkRepo('0xchainA', async () => fakeDustResult()).dust(SEED, NETWORK);
    expect(readDustCacheFile()?.chainId).toBe('0xchainA');
  });

  it('wipes a cache from a different chain and re-syncs fresh from event 0', async () => {
    await mkRepo('0xchainA', async () => fakeDustResult({ lastAppliedEventId: 5 })).dust(SEED, NETWORK);
    expect(readDustCacheFile()?.chainId).toBe('0xchainA');

    // Chain reset: node now reports genesis hash B. A fresh repo must WIPE the
    // chain-A cache and re-sync from 0, not resume from 6.
    let startFromSeen = -999;
    const view = await mkRepo('0xchainB', async (_s, _n, opts) => {
      startFromSeen = opts.startFromId;
      return fakeDustResult({ lastAppliedEventId: 2 });
    }).dust(SEED, NETWORK);

    expect(startFromSeen).toBe(0);                        // wiped → fresh, not resumed
    expect(view.fromCache).toBe(false);
    expect(readDustCacheFile()?.chainId).toBe('0xchainB'); // re-keyed to the new chain
  });

  it('resumes (does NOT wipe) when the genesis hash is unchanged', async () => {
    await mkRepo('0xchainA', async () => fakeDustResult({ lastAppliedEventId: 5 })).dust(SEED, NETWORK);

    let startFromSeen = -999;
    const view = await mkRepo('0xchainA', async (_s, _n, opts) => {
      startFromSeen = opts.startFromId;
      return fakeDustResult({ lastAppliedEventId: 5 });
    }).dust(SEED, NETWORK);

    expect(startFromSeen).toBe(6);          // resumed from lastAppliedEventId + 1
    expect(view.fromCache).toBe(true);
  });
});
