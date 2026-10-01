// Sync-completion predicates, tested against the SDK's real progress objects
// (its own `isStrictlyComplete` rules), not hand-written booleans. Only the
// FacadeState container is a stand-in: these predicates read nothing else.

import { describe, it, expect } from 'vitest';
import { SyncProgress } from '@midnightntwrk/wallet-sdk';
import { SyncProgress as UnshieldedSyncProgress } from '@midnightntwrk/wallet-sdk/unshielded/v2';
import type { FacadeState } from '@midnightntwrk/wallet-sdk/facade';
import { isFacadeSynced, detectStaleCache } from '../lib/facade.ts';

type IndexProgress = ReturnType<typeof SyncProgress.createSyncProgress>;
type TxProgress = ReturnType<typeof UnshieldedSyncProgress.createSyncProgress>;

/** A shielded/dust wallet that has applied `applied` of `highest` events. */
function indexed(applied: bigint, highest: bigint, isConnected = true): IndexProgress {
  return SyncProgress.createSyncProgress({
    appliedIndex: applied,
    highestRelevantWalletIndex: highest,
    highestIndex: highest,
    highestRelevantIndex: highest,
    isConnected,
  });
}

/** An unshielded wallet that has applied `applied` of `highest` transactions. */
function txs(applied: bigint, highest: bigint, isConnected = true): TxProgress {
  return UnshieldedSyncProgress.createSyncProgress({
    appliedId: applied,
    highestTransactionId: highest,
    isConnected,
  });
}

const SYNCED = indexed(10n, 10n);
const BEHIND = indexed(4n, 10n);

function state(p: { shielded?: IndexProgress; unshielded?: TxProgress; dust?: IndexProgress } = {}): FacadeState {
  return {
    shielded: { progress: p.shielded ?? SYNCED },
    unshielded: { progress: p.unshielded ?? txs(10n, 10n) },
    dust: { progress: p.dust ?? SYNCED },
  } as unknown as FacadeState;
}

describe('isFacadeSynced', () => {
  describe('full mode (default)', () => {
    it('is synced when all three wallets are strictly complete', () => {
      expect(isFacadeSynced(state())).toBe(true);
      expect(isFacadeSynced(state(), 'full')).toBe(true);
    });

    it.each([
      ['shielded', { shielded: BEHIND }],
      ['unshielded', { unshielded: txs(4n, 10n) }],
      ['dust', { dust: BEHIND }],
    ])('is not synced while %s is behind', (_name, p) => {
      expect(isFacadeSynced(state(p))).toBe(false);
    });
  });

  describe('lite mode (unshielded + dust)', () => {
    it('ignores a shielded wallet that is behind', () => {
      expect(isFacadeSynced(state({ shielded: BEHIND }), 'lite')).toBe(true);
    });

    it('is not synced while dust or unshielded is behind', () => {
      expect(isFacadeSynced(state({ dust: BEHIND }), 'lite')).toBe(false);
      expect(isFacadeSynced(state({ unshielded: txs(4n, 10n) }), 'lite')).toBe(false);
    });
  });

  describe('no-dust mode (shielded + unshielded)', () => {
    it('ignores a dust wallet that is behind', () => {
      expect(isFacadeSynced(state({ dust: BEHIND }), 'no-dust')).toBe(true);
    });

    it('is not synced while shielded is behind', () => {
      expect(isFacadeSynced(state({ shielded: BEHIND }), 'no-dust')).toBe(false);
    });
  });

  describe('dust isConnected workaround', () => {
    // The SDK only counts dust as complete once it is connected, and on an idle
    // chain it never connects. The indices are the reliable signal.
    it('reproduces the SDK behaviour being worked around', () => {
      expect(indexed(50n, 50n, false).isStrictlyComplete()).toBe(false);
    });

    it('counts disconnected dust as caught up when its indices are', () => {
      const s = state({ dust: indexed(50n, 50n, false) });
      expect(isFacadeSynced(s, 'full')).toBe(true);
      expect(isFacadeSynced(s, 'lite')).toBe(true);
    });

    it('does not count disconnected dust that is genuinely behind', () => {
      expect(isFacadeSynced(state({ dust: indexed(10n, 50n, false) }), 'lite')).toBe(false);
    });
  });

  describe('wallets with no events yet (0/0)', () => {
    const untouched = indexed(0n, 0n, false);

    it('treats untouched dust as caught up once unshielded is synced (unfunded wallet)', () => {
      expect(isFacadeSynced(state({ dust: untouched }), 'lite')).toBe(true);
    });

    it('does not trust untouched dust before unshielded has synced (could be the initial state)', () => {
      expect(isFacadeSynced(state({ dust: untouched, unshielded: txs(0n, 10n) }), 'lite')).toBe(false);
    });

    it('treats an untouched shielded wallet as caught up once unshielded is synced', () => {
      expect(isFacadeSynced(state({ shielded: untouched }), 'full')).toBe(true);
    });

    it('does not trust an untouched shielded wallet before unshielded has synced', () => {
      expect(isFacadeSynced(state({ shielded: untouched, unshielded: txs(0n, 10n) }), 'no-dust')).toBe(false);
    });
  });
});

describe('detectStaleCache', () => {
  it('flags a cache that has applied transactions the chain does not have', () => {
    expect(detectStaleCache(state({ unshielded: txs(120n, 40n) }))).toBe(
      'unshielded cache applied=120 but chain highest=40.',
    );
  });

  it('accepts a cache that is behind or level with the chain', () => {
    expect(detectStaleCache(state({ unshielded: txs(40n, 120n) }))).toBeUndefined();
    expect(detectStaleCache(state({ unshielded: txs(40n, 40n) }))).toBeUndefined();
  });

  it('makes no judgement before the indexer has reported a highest id', () => {
    expect(detectStaleCache(state({ unshielded: txs(120n, 0n) }))).toBeUndefined();
  });
});
