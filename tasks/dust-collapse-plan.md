# Plan: integrate dust generation-tree collapse

## Goal

Make dust-state save/restore cheap and bounded in size regardless of chain age, by
collapsing the *foreign* portion of the dust generation Merkle tree before we persist
it — keeping only the wallet's own generation leaves. Client-side form of the
optimization in `midnight-wallet` issue #639.

## Why (and how it relates to what we already have)

Our dust cache already avoids re-downloading / re-replaying history (resume from
checkpoint). What it doesn't do: the saved blob still grows forever with chain age, so
every restart re-deserializes and re-serializes an ever-larger state (and the facade
restore pays it again). The in-memory memo doesn't survive a restart, so server-side
wallets that reboot constantly pay that growing cost every boot. Collapse caps the blob
to the wallet's own leaves + one fingerprint, making restart cost flat. It stacks on the
existing cache; it does **not** speed up the first sync.

## Proven basis (spike — all on real data; `reports/dust-collapse-spike-findings.md`)

- Collapse APIs exist in `ledger-v8@8.1.0`, unused by the SDK.
- Real preprod cache: collapsing the foreign range preserved the root, shrank state
  ~300x and deserialize ~720x.
- Real owned wallet: collapsing only foreign gaps preserved balance, UTXOs, root, and
  every UTXO's spendability; collapsing an owned leaf corrupts the wallet.
- Resume over a collapsed+restored state (incl. 81 real dtime-updates) reproduced the
  full-replay balance exactly; ledger source confirms why (collapse-tolerant update
  path, replay never indexes foreign leaves, inserts land past the frontier).
- Re-collapse is idempotent → collapsing on every sync is safe.

## Decisions locked

- **Migration:** bump the dust cache version so existing caches are invalidated and
  re-synced once (they lack the owned-leaf data collapse needs). New / mainnet / agent
  wallets start fresh and are unaffected.
- **Scope:** generation tree only. Commitment-tree collapse is a deferred follow-up.

## How it integrates

- **Retention signal — owner match.** As the sync loop deserializes each event
  (`dust-direct.ts`), a `dustInitialUtxo` whose `generation.owner` equals our dust
  public key marks that `generationIndex` as ours. Accumulate the owned set + the
  generation frontier during replay — the events are already decoded there, so this is
  free. This is exactly how the ledger itself classifies leaves.
- **Collapse the gaps.** A new pure helper takes the state + owned indices + frontier,
  collapses each contiguous foreign range between owned indices (and the tail to the
  frontier), and returns the collapsed state. Owned indices are excluded exactly.
- **Safety guard.** The helper verifies the collapsed state still reports the same
  balance and generation-tree root as before collapsing; if not, it returns the original
  uncollapsed state. Correctness always wins — a classification bug costs only the
  speedup.
- **Hook point.** Collapse the finished dust state where the reader produces it
  (`readDustBalanceDirect`), so the collapsed state flows to all three consumers at once:
  the disk cache, the in-memory memo, and the facade bridge (which re-serializes it into
  the SDK's slow restore). Persisted checkpoints store the collapsed snapshot too, so an
  interrupted long sync resumes from a small checkpoint rather than a growing one. Replay
  continuing over a collapsed state is the already-proven safe path.
- **Persistence.** The dust cache carries the owned generation indices + frontier
  alongside the state, so resume keeps collapsing correctly without re-deriving them.
  Cache version is bumped.
- **Facade / transfer.** No change. The bridge carries the collapsed state into the SDK
  dust wallet; spends still resolve their own backing-night path because owned leaves are
  preserved; the SDK never re-expands the merged ranges.

## Gaps — resolved

- **Which leaves are mine?** Owner-match on `dustInitialUtxo` events (ledger's own rule);
  tracked during the existing replay loop.
- **Owned indices not exposed by the SDK?** Correct — we track them from events and
  persist them; no SDK API needed.
- **Scattered owned leaves?** Collapse each foreign gap between them (multiple disjoint
  collapses); proven to preserve everything.
- **Resume safety (dtime-updates on collapsed leaves)?** Proven safe on real events and
  in source; new inserts land past the frontier.
- **Re-collapsing on every run?** Idempotent; safe.
- **Empty owned set / zero events?** Collapse the whole foreign tree / do nothing —
  both handled; guard covers the balance-zero case.
- **Corruption risk from a bug?** Balance+root guard with uncollapsed fallback — fails
  safe, never persists a bad state.
- **Old caches lack retention data?** Version bump invalidates them → one-time re-sync.
- **`.bin` files?** Not ours; ignored. Our hot path is the JSON dust cache.
- **Escape hatch?** An env opt-out disables collapse entirely (debugging / worst-case
  safety valve), defaulting on.

## Work items

- [x] Track owned generation indices + frontier in the dust sync/replay loop; thread
      them through the reader result and the cache (seed from cache on resume).
- [x] New pure helper: foreign-gap collapse with the balance+root safety guard and
      uncollapsed fallback (`src/lib/dust-collapse.ts`).
- [x] Call the helper where the finished dust state is produced, and when persisting
      checkpoints (`dust-direct.ts` `flushPending`).
- [x] Extend the dust cache format with the retention data; bump the cache version (v2).
- [x] Env opt-out to disable collapse (`MN_DISABLE_DUST_COLLAPSE`).
- [x] Changelog entry; note the one-time re-sync on upgrade.

## Tests

- Unit (deterministic, in `dust-direct-cache.test.ts` style with `freshDustState()` +
  `insertGenerationInfo`):
  - foreign-gap collapse preserves balance / UTXOs / root;
  - owned indices are never collapsed;
  - safety guard returns the uncollapsed state when fed a deliberately-wrong owned set;
  - owner-match extraction picks exactly the owned indices;
  - cache round-trips the retention data; old-version cache is invalidated.
- Localnet integration (per repo convention): resume over a collapsed cache stays
  correct; a transfer spends correctly from a collapsed cache.

## Risks & mitigations

- Misclassifying an owned index (fatal if collapsed) → owner-match is the ledger's rule,
  plus the guard fails safe to uncollapsed.
- Incomplete owned set on resume → version bump forces a complete rebuild once.
- Partial/timed-out syncs → checkpoints persist collapsed snapshots; a partial run just
  resumes.
- Future SDK drift → the guard degrades to uncollapsed rather than corrupting.

## Out of scope

- Commitment-tree collapse (follow-up).
- Indexer-side collapsed dust updates (needs new indexer schema; not our code).
- First-sync speedup (this only helps restarts).
- Facade/SDK persistence format changes.

## Review

Implemented on `feat/dust-collapse`. Files: new `src/lib/dust-collapse.ts` (pure helper);
`dust-direct.ts` (retention tracking + collapse in `flushPending` + `DustRetention` type +
env opt-out); `dust-direct-cache.ts` (v2 format, retention save/load); `wallet-data-repository.ts`
(thread retention through resume/checkpoint/final-save). Tests: `dust-collapse.test.ts` (11) +
retention round-trip / v1-invalidation in `dust-direct-cache.test.ts`. Full suite green (1094).

Verified end-to-end on localnet (kuiraval, undeployed):
- v1 cache invalidated → full re-sync → cache rewritten as **v2** with owned=69 indices
  (matches the independent owner-match analysis), frontier=219; balance correct.
- 2nd run **resumed** from the collapsed v2 cache, 0 events re-applied, balance consistent.
- `MN_DISABLE_DUST_COLLAPSE=1` skipped collapse while still tracking retention.

Notes / deviations:
- Owner-match extraction lives inside the WS replay loop (bound to `ledger.Event`), so it's
  covered by the end-to-end localnet run rather than a pure unit test; the pure helper +
  cache format are unit-tested, and the safety guard makes any extraction error fail safe.
- Localnet shrink is small (few foreign leaves); the ~300x/720x magnitude is the real-preprod
  measurement from the spike.
- The transfer-from-collapsed-cache integration check is not yet run (write path); the guard +
  own-leaf preservation make it safe in principle, but worth a live localnet transfer before merge.
