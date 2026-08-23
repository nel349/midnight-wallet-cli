# CLI follow-ups: `mn balance` MN_SEED + native-path dust collapse

Handoff for a dedicated midnight-wallet-cli session. Both items were found while
validating the 0.5.1 release with a cold-start test on preprod (new wallet funded
from `alice`, full cold dust sync). **Both are pre-existing 0.5.0-era behavior, not
0.5.1 regressions, and neither blocks the 0.5.1 publish.** They are DevX/perf gaps,
not correctness bugs.

## Measured baselines (preprod, this session)

- Cold dust sync (new wallet, `fromCache:false`, 1,419,958 events), native sidecar:
  **~272 s (~4.5 min)**, `partial:false` (completes to tip — the 0.5.1 export fix).
- Same class of sync on WASM (no sidecar, i.e. a plain `npm install`): ~22 min.
- Warm delta on an already-synced wallet: ~7–9 s.
- Cold snapshot size for a **0-owned** wallet: **~1.46 MB** (native). A collapsed
  equivalent is **~23 KB** (alice's WASM-collapsed cache at the same offset proves the
  bulk is the uncollapsed *generation* tree, not the commitment tree).

---

## ① `mn balance` ignores `MN_SEED`

**What.** `mn address`, `mn wallet generate`, and `mn dust export` all resolve a seed
from `MN_SEED` (env, kept off argv). `mn balance` does not — it resolves only a wallet
name / file / active wallet. So a seed-only caller (a dApp operator with no named
wallet) can read a *dust snapshot* for a seed but cannot read its *balance* the same
way. In the cold-start test, `MN_SEED=… mn balance` silently reported the **active**
wallet's balance instead of the seed's.

**Where.** `src/commands/balance.ts`, seed/wallet resolution via
`src/lib/wallet-config.ts` (`loadWalletConfig` / `resolveWalletPath`). No `MN_SEED`
reference in that path.

**Direction.** Give `balance` the same seed-resolution precedence the other commands
use (`--seed` → `MN_SEED` → `--wallet <name>` → active), with one shared resolver so
the four commands can't drift again. Small, safe, consistency-only.

---

## ② Native dust-sync path skips generation-tree collapse

**What.** The generation-tree collapse (the 0.5.0 feature that bounds dust cache size
and restart cost) runs **only on the WASM reader path**. When the native sidecar is
used — the default whenever the binary resolves — the produced state is **never
collapsed**, so a cold native sync persists/exports an unbounded state (the 1.46 MB
above). The optimization is therefore bypassed on the fast/default path exactly when
it matters most: a **cold** sync of a **large** state. `npm install`ed `mn` (WASM only)
still collapses; local sidecar builds (anonboard operators, benchmarking) do not.

**Correctness is unaffected** — an uncollapsed state is the ground truth; collapse is
purely size/perf, and it already fails safe to uncollapsed. So this never corrupts a
wallet or a spend; it only inflates cache/restore size and per-reboot cost. anonboard's
operator prime still works, just with a heavier restore snapshot than intended.

**Where.**
- Collapse is invoked only in the WASM reader: `src/lib/dust-direct.ts` (call to
  `collapseForeignGenerations` from `src/lib/dust-collapse.ts`).
- The native result returns uncollapsed: `src/lib/dust-sync-native.ts`
  (`runDustSyncNative`), selected by `nativeOrWasmDustFetcher` in
  `src/lib/wallet-data-repository.ts`.
- The Rust sidecar does not collapse: `sidecar/dust-sync/src/main.rs` (no collapse/prune).

**Direction (decide in the CLI session).** Two places the collapse could live so the
native path gets it too:
- Apply the existing TS collapse to the native result after the sync, reusing the same
  owned-indices + frontier retention the native checkpoint already carries. Keeps one
  collapse implementation; costs a WASM deserialize/collapse/serialize once per sync.
- Collapse inside the Rust sidecar. Fastest at scale, but duplicates the collapse logic
  and its safety guard in Rust and must stay in lockstep with the ledger crate.

Either way, preserve the invariants already proven for collapse: never collapse an owned
leaf, keep the balance+root safety guard with uncollapsed fallback, and stay idempotent
so re-collapsing on every run is safe. Goal: the native path should be **both**
fast-cold **and** lean-restart.

**Note.** This is distinct from the pending "collapsed fast-sync" work (fast-forward
foreign trees via indexer range queries → O(our events), the real cold-start-time win).
② is about bounding size/restart on the native path; it does not change cold-sync time.
