// Collapse the foreign portion of the dust generation Merkle tree, keeping the
// wallet's own generation leaves. This shrinks the persisted dust state and its
// restore time without changing balances or spendability — the client-side form
// of the optimization in `midnight-wallet` issue #639.
//
// Pure logic only: no I/O, no console. Callers decide when to collapse and how
// to source the owned index set (owner-match during event replay). See
// tasks/dust-collapse-plan.md.

import * as ledger from '@midnight-ntwrk/ledger-v8';

export interface CollapseOutcome {
  /** The collapsed state, or the original state if collapse was skipped/rejected. */
  state: ledger.DustLocalState;
  /** True iff a verified collapse was applied. */
  collapsed: boolean;
  /** Number of foreign ranges collapsed. */
  rangesCollapsed: number;
  /** Why collapse was skipped or rolled back (diagnostics; undefined on success). */
  reason?: string;
}

/**
 * Compute the contiguous foreign index ranges of the generation tree: every gap
 * in `[0, frontier)` not occupied by an owned generation index. Indices outside
 * `[0, frontier)` and duplicates are ignored. Pure.
 */
export function computeForeignRanges(
  ownedIndices: Iterable<bigint>,
  frontier: bigint,
): Array<[bigint, bigint]> {
  if (frontier <= 0n) return [];
  const owned = [...new Set(ownedIndices)]
    .filter((i) => i >= 0n && i < frontier)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const ranges: Array<[bigint, bigint]> = [];
  let prev = -1n; // highest index already accounted for
  for (const idx of owned) {
    if (idx > prev + 1n) ranges.push([prev + 1n, idx - 1n]);
    prev = idx;
  }
  if (frontier - 1n > prev) ranges.push([prev + 1n, frontier - 1n]);
  return ranges;
}

/**
 * Collapse the foreign ranges of the dust generation tree while keeping the
 * wallet's own generation leaves (`ownedIndices`) intact.
 *
 * Safety guard: after collapsing, the state must still report the same
 * `walletBalance` and generation-tree root as the input. If it doesn't — e.g. an
 * owned index was misclassified and collapsed — the original, uncollapsed state
 * is returned instead. A logic error can therefore only cost the size
 * optimization, never balance correctness or spendability.
 */
export function collapseForeignGenerations(
  state: ledger.DustLocalState,
  ownedIndices: Iterable<bigint>,
  frontier: bigint,
): CollapseOutcome {
  const ranges = computeForeignRanges(ownedIndices, frontier);
  if (ranges.length === 0) {
    return { state, collapsed: false, rangesCollapsed: 0, reason: 'nothing-foreign' };
  }

  // Reference values the collapsed state must still reproduce. Use the state's
  // own sync time so the balance comparison is time-invariant.
  const when = state.syncTime instanceof Date ? state.syncTime : new Date(String(state.syncTime));
  let refBalance: bigint;
  let refRoot: bigint | undefined;
  try {
    refBalance = state.walletBalance(when);
    refRoot = state.generatingTreeRoot();
  } catch (err) {
    return { state, collapsed: false, rangesCollapsed: 0, reason: `no-reference: ${(err as Error).message}` };
  }

  let collapsed = state;
  try {
    for (const [start, end] of ranges) {
      collapsed = collapsed.collapseGenerationTree(start, end);
    }
  } catch (err) {
    return { state, collapsed: false, rangesCollapsed: 0, reason: `collapse-threw: ${(err as Error).message}` };
  }

  // Safety guard — a mis-collapse of an owned leaf must roll back. `walletBalance`
  // is the primary check; the tree root is a cheap sanity check (a collapse
  // preserves the root by construction, so this only catches a deeper bug, not a
  // mis-collapse). The load-bearing extra check is that every owned UTXO still
  // resolves its generation info: a pruned owned leaf breaks this even when the
  // balance happens to be unaffected (e.g. a leaf contributing 0 dust at syncTime).
  try {
    if (collapsed.walletBalance(when) !== refBalance || collapsed.generatingTreeRoot() !== refRoot) {
      return { state, collapsed: false, rangesCollapsed: 0, reason: 'guard-mismatch' };
    }
    for (const utxo of collapsed.utxos) {
      if (collapsed.generationInfo(utxo) === undefined) {
        return { state, collapsed: false, rangesCollapsed: 0, reason: 'guard-utxo-generation-missing' };
      }
    }
  } catch (err) {
    return { state, collapsed: false, rangesCollapsed: 0, reason: `guard-threw: ${(err as Error).message}` };
  }

  return { state: collapsed, collapsed: true, rangesCollapsed: ranges.length };
}
