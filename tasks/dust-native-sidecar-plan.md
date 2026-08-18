# Plan: native dust-sync sidecar (cold dust sync ~22 min → ~3.7 min)

## Why (measured, not estimated)
Cold dust sync is 96% WASM `DustLocalState.replayEvents` over ~1.44M events (~22 min preprod).
Native `midnight-ledger` 8.1.0 (the crate our WASM `@midnight-ntwrk/ledger-v8` is built from)
replays the SAME events at ~6,489/s vs WASM ~1,300/s — **~5×**, cold sync **~3.7 min** (< the
5-min usability threshold WASM can't reach). See `tasks/dust-cold-sync-native-spike.md`.

## Scope
- **Dust only.** Shielded has the collapsed fast path; unshielded is fast GraphQL. The sidecar
  exists solely to accelerate the dust event replay.
- Accelerates **both** read (`balance`, `dust status`) and write (`transfer`, `dust register`) —
  both consume the cached `DustLocalState`.
- **Optional accelerator, never a hard dependency.** Missing/failed binary → transparent
  fallback to today's WASM `readDustBalanceDirect`. Correct-but-slow stays the floor.

## Verified foundations (gaps closed during the spike — no open design risk)
- **Serialization round-trip PROVEN.** Native `tagged_serialize(DustLocalState)` (24.8 KB from
  49,880 events) deserializes cleanly in WASM ledger-v8 8.1.0 (same `midnight:dust-local-state`
  tag), consistent balance + tree root. → the sidecar hands its result to the existing cache
  verbatim; no data-model reimplementation.
- **crates.io-only build CONFIRMED (no git fork).** Everything is in published crates:
  `midnight-ledger =8.1.0` → `dust::{DustLocalState, DustSecretKey}`,
  `structure::{INITIAL_PARAMETERS, LedgerParameters}`, `DustLocalState::{new, replay_events,
  wallet_balance}`; DB backend `midnight-storage =2.0.1` → `db::InMemoryDB`; tagged serde
  `midnight-serialize`. The fork's `DustWallet`/`DefaultDB` were only convenience wrappers.
- **Params-from-block available.** The indexer `Block` exposes `ledgerParameters` (+
  `dustGenerationEndIndex`/`dustCommitmentEndIndex` for the tip) → the sidecar reads current
  params so a post-`ParamChange` chain stays correct.
- **Binary is small (~3.7 MB).** Packaging is a non-issue.

## Sidecar I/O contract (design, not code)
A standalone native binary that does what `readDustBalanceDirect` does, natively.
- **Inputs:** indexer WS endpoint; dust secret key (or seed to derive) via **stdin** (never
  argv/env; zeroed after use); resume cursor (last applied event id) + optional prior
  serialized state for incremental resume; soft timeout; an out-file path for the state.
- **Outputs (mirror `DustDirectResult` so the repo is unchanged):** the `tagged_serialize`d
  `DustLocalState` written to the out-file; a single **JSON status line to stdout** with
  `lastAppliedEventId`, `balance`, `availableCoins`, `eventsApplied`, `partial`, and the
  **retention data** (`ownedGenerationIndices` + `generationFrontier`) the v2 cache + collapse
  need — computed via the same owner-match rule during replay; **progress to stderr** for the
  spinner. Non-zero exit + stderr → CLI falls back.
- **Checkpointing:** persist state+cursor periodically so a kill mid-cold-sync resumes; the CLI
  passes the last checkpoint back on the next call. Ctrl+C in the CLI kills the child, which
  checkpoints before exit.

## CLI integration point
- **Swap at `src/lib/wallet-data-repository.ts`.** `dust()` calls the injected `fetchDust`
  (today `defaultDustFetcher` → `readDustBalanceDirect`). Add a `fetchDustNative` that spawns
  the sidecar and returns the same `DustDirectResult`. Select native when the binary resolves +
  is enabled (config/env flag; default on if available), else the WASM fetcher.
- **No changes** to `dust.ts`/`balance.ts`/the cache: same result shape → cache load/save
  (`dust-direct-cache.ts` v2 + chainId), collapse, memo, and the partial-retry loop all keep
  working. Cache compatibility is proven.

## Packaging (decision: subprocess sidecar + optional platform packages)
- **Chosen:** subprocess sidecar (ABI-independent, simple fallback) + **optional platform
  packages** (`optionalDependencies`, the esbuild/`@napi-rs` pattern): publish
  `@midnight-wallet-cli/dust-sync-<os>-<arch>`; the CLI resolves the one matching
  `process.platform`/`arch`. No install-time network fetch.
- **Rejected:** napi addon (couples to Node ABI, per-version builds, harder fallback);
  postinstall download (adds an install-time network + checksum step) — keep as a secondary
  option only if optional packages prove awkward.
- **Fallback chain:** resolved native binary → else WASM `readDustBalanceDirect` (current
  behavior). Optional build-from-source only if a toolchain exists.

## Remaining decisions (choices, not blocking gaps)
- Config/enable surface: env var + `mn config` key to force-on/off native; default on when a
  binary resolves.
- Version-lockstep policy: the sidecar's `midnight-ledger` MUST equal the CLI's
  `@midnight-ntwrk/ledger-v8` (serialization depends on it) — add a runtime version assert + a
  CI guard; re-release the sidecar on every ledger-v8 bump.
- CI/release matrix: macOS arm64/x64, Linux x64/arm64, (Windows?) — build (~2.5 min/target) +
  macOS signing/notarization. This is the bulk of the non-code work.

## Implementation checklist
### Phase 0 — confirm build (de-risk in an hour)
- [ ] Minimal crates.io-only crate: `DustLocalState::<InMemoryDB>::new(INITIAL_PARAMETERS.dust)`
      + `replay_events` + `tagged_serialize` — `cargo check`/`build` green (no fork).
- [ ] Confirm native `tagged_serialize` output still deserializes in WASM (repeat the round-trip
      from the crates.io-only build, not the fork build).

### Phase 1 — sidecar binary
- [ ] `dustLedgerEvents` WS subscription client (resume from cursor, chunked replay ~500).
- [ ] Read current `ledgerParameters` from the latest block; use for balance + `process_ttls`.
- [ ] Owner-match retention (`ownedGenerationIndices` + `generationFrontier`) during replay.
- [ ] Periodic checkpoint (state + cursor to the out-file); resume from a passed-in checkpoint.
- [ ] stdin secret handling (zeroed); JSON status to stdout; progress to stderr; clean exit codes.
- [ ] Abort on SIGINT with a final checkpoint.

### Phase 2 — CLI integration
- [ ] `fetchDustNative` in `wallet-data-repository.ts` → spawns sidecar, returns `DustDirectResult`.
- [ ] Native/WASM selection + config/env flag; transparent fallback on missing/failed binary.
- [ ] Binary resolver (optional platform package → path); ledger-version assert vs ledger-v8.
- [ ] Wire progress into the existing spinner; keep partial-retry + cache save/collapse intact.

### Phase 3 — packaging & release
- [ ] Cross-platform build in CI (matrix above); strip/LTO; publish optional platform packages.
- [ ] macOS signing/notarization; checksums.
- [ ] `optionalDependencies` wiring + resolver fallback tested on each platform.

### Phase 4 — verify (acceptance criteria)
- [ ] **Correctness across spends:** native-synced `walletBalance` for a real funded,
      dust-SPENDING wallet (e.g. alice on preprod) EXACTLY matches a full WASM sync (the case the
      generation-only shortcut failed).
- [ ] Incremental resume from a cached cursor applies only the delta and matches from-scratch.
- [ ] Cold preprod dust sync completes in ≤ ~4 min.
- [ ] Missing/failed binary → transparent WASM fallback, no user-visible break.
- [ ] `/security-review` on the seed/stdin handoff; full `vitest` suite green + a round-trip test.
