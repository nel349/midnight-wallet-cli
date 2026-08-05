import { describe, it, expect } from 'vitest';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { computeForeignRanges, collapseForeignGenerations } from '../lib/dust-collapse.ts';
import { DUST_STATE_OWNED_HEX } from './fixtures/dust-state-owned.ts';

// Same initial dust params the sync path uses (dust-direct.ts).
function freshDustState(): ledger.DustLocalState {
  return new ledger.DustLocalState(new ledger.DustParameters(5_000_000_000n, 8_267n, 3n * 60n * 60n));
}

// Build a state with `n` generation leaves at indices [0, n) owned by a random
// foreign key. Balance stays 0 (no UTXOs) — enough to exercise the collapse
// mechanics and the root invariant.
function stateWithForeignLeaves(n: number): ledger.DustLocalState {
  const owner = ledger.sampleDustSecretKey().publicKey;
  const intent = ledger.sampleIntentHash();
  let s = freshDustState();
  for (let i = 0; i < n; i++) {
    s = s.insertGenerationInfo(BigInt(i), {
      value: 1_000_000n + BigInt(i),
      owner,
      nonce: ledger.dustInitialNonce(BigInt(i), intent),
      dtime: undefined,
    } as any);
  }
  return s;
}

describe('computeForeignRanges', () => {
  it('returns nothing for a zero/negative frontier', () => {
    expect(computeForeignRanges([], 0n)).toEqual([]);
    expect(computeForeignRanges([1n], -5n)).toEqual([]);
  });

  it('collapses the whole tree when nothing is owned', () => {
    expect(computeForeignRanges([], 8n)).toEqual([[0n, 7n]]);
  });

  it('collapses the gaps between scattered owned indices', () => {
    expect(computeForeignRanges([2n, 5n], 8n)).toEqual([[0n, 1n], [3n, 4n], [6n, 7n]]);
  });

  it('handles owned at the edges', () => {
    expect(computeForeignRanges([0n], 3n)).toEqual([[1n, 2n]]);
    expect(computeForeignRanges([2n], 3n)).toEqual([[0n, 1n]]);
  });

  it('returns no ranges when every index is owned', () => {
    expect(computeForeignRanges([0n, 1n, 2n], 3n)).toEqual([]);
  });

  it('treats adjacent owned indices as one boundary', () => {
    expect(computeForeignRanges([2n, 3n], 6n)).toEqual([[0n, 1n], [4n, 5n]]);
  });

  it('ignores duplicates and out-of-range indices', () => {
    expect(computeForeignRanges([5n, 5n, 2n, 99n, -1n], 8n)).toEqual([[0n, 1n], [3n, 4n], [6n, 7n]]);
  });
});

describe('collapseForeignGenerations', () => {
  it('collapses foreign gaps and preserves the tree root', () => {
    const s = stateWithForeignLeaves(8);
    const rootBefore = s.generatingTreeRoot();
    const out = collapseForeignGenerations(s, [3n], 8n);

    expect(out.collapsed).toBe(true);
    expect(out.rangesCollapsed).toBe(2); // [0,2] and [4,7]
    expect(out.state.generatingTreeRoot()).toBe(rootBefore);
  });

  it('is a no-op when there is nothing foreign to collapse', () => {
    const s = stateWithForeignLeaves(3);
    const out = collapseForeignGenerations(s, [0n, 1n, 2n], 3n);

    expect(out.collapsed).toBe(false);
    expect(out.rangesCollapsed).toBe(0);
    expect(out.reason).toBe('nothing-foreign');
    expect(out.state).toBe(s); // original returned unchanged
  });

  it('is a no-op for an empty tree', () => {
    const s = freshDustState();
    const out = collapseForeignGenerations(s, [], 0n);
    expect(out.collapsed).toBe(false);
    expect(out.state).toBe(s);
  });

  describe('safety guard (real owned state fixture)', () => {
    const load = () =>
      ledger.DustLocalState.deserialize(new Uint8Array(Buffer.from(DUST_STATE_OWNED_HEX, 'hex')));

    it('rolls back to the uncollapsed state when an owned leaf would be collapsed', () => {
      const s = load();
      const when = s.syncTime instanceof Date ? s.syncTime : new Date(String(s.syncTime));
      const balanceBefore = s.walletBalance(when);
      expect(balanceBefore).toBeGreaterThan(0n); // fixture actually holds dust

      // Empty owned set => the whole tree (including the wallet's own generation
      // leaf) is collapsed => walletBalance would break => guard must roll back.
      const out = collapseForeignGenerations(s, [], 1n << 32n);

      expect(out.collapsed).toBe(false);
      expect(out.reason).toMatch(/guard/);
      // The returned state is the original, uncollapsed one — balance intact.
      expect(out.state.walletBalance(when)).toBe(balanceBefore);
    });
  });
});
