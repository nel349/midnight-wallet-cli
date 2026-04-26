# Architecture Deepening — TODO

Per the `/improve-codebase-architecture` review, we're deepening five clusters to
make the codebase more testable, more AI-navigable, and to consolidate the cache /
network / retry patterns that today are scattered across every command.

Friction signal that triggered this: ad-hoc dust-cache invalidation forces every
write path to re-implement the load → validate → fetch → save dance. New features
inherit the tax. The Phase-5 dust TTL discussion surfaced that a band-aid fix
just adds another inconsistency — what we need is a centralized pattern.

Working branch: `arch/wallet-data-repository`.

## Phasing

**Now** — commit to #1. Do not block on the rest.
**Next** — #3 follows naturally after #1 stabilises (~1 week of soak).
**Later** — #2 and #5 land when there's a concrete trigger (new WS client / new MCP tool).

---

## #1 — Wallet Data Repository (now)

Single owner of "what's the freshest dust state / facade state / chainId for this
wallet on this network". Every command stops calling `loadDustCache`, `saveDustCache`,
`primeDustCache`, `loadWalletCache`, `validateNetworkCaches` directly. They call
the repo. Repo decides: in-memory hit? on-disk + tip unchanged? else fetch.

### Invariants

1. No silent staleness — reads either return tip-current values or carry an explicit `freshAsOf` the caller can reason about.
2. Writes invalidate — successful chain writes tell the repo "I changed X" so the next read bypasses the cache for that scope.
3. Force-fresh always works — one explicit option bypasses every layer.
4. No persisted secrets — derived state only, keyed by pubkey hashes.
5. Process-safe — atomic-rename writes preserved; concurrent `mn` invocations don't corrupt cache files.
6. Network-down tolerant — reads return on-disk value with `lastSyncedAt`, not an error.
7. Two-layer cache — in-memory layer for the long-lived MCP server process, disk layer shared across `mn` shell invocations.

### Chosen design — Option Z (ergonomic surface, two constructor seams)

After a stress-test of the hybrid (3+4) against CLAUDE.md's "minimal impact" rule, we
went lighter. Same user-facing wins, much smaller blast radius, easier to evolve
to full ports & adapters later if a concrete trigger appears.

**Public surface** (Design 3, locked):

```
repo.dust(seed, network, opts?)            → DustView
repo.unshielded(identity, network, opts?)  → UnshieldedView   // identity = address | seed
repo.withFacade(seed, network, fn, opts?)  → T                // borrow; auto-stop, auto-invalidate
repo.invalidate(scope)                     → void
```

**Internals — minimal seam version:** the repo is one new file (`src/lib/wallet-data-repository.ts`) that orchestrates existing functions (`loadDustCache`, `loadWalletCache`, `primeDustCache`, `buildFacade`, `startAndSyncFacade`, `stopFacade`, etc). It adds:

- An in-memory `Map<key, { value, fetchedAt, tipAtFetch }>` layer (lives for the process lifetime — important for the long-lived MCP server).
- A `getCurrentTip()` helper that asks the substrate node for its current head (cheap, ~50ms; uses existing `node-rpc.ts`).
- An `invalidate()` method that clears the in-memory map and marks disk entries stale.

**Four constructor seams for testability** (no full P&A):

```
new WalletDataRepository(deps: {
  now?:             () => number;
  fetchTip?:        (n: NetworkConfig) => Promise<TipFingerprint>;
  fetchUnshielded?: (address, network, onProgress?) => Promise<BalanceSummary>;
  fetchDust?:       (seed, network, opts) => Promise<DustDirectResult>;
  cacheDir?:        string;   // tests use a tmp dir
})
```

Initial sketch said "two seams"; the honest count to make cache logic genuinely unit-testable (without touching network) is four. Production defaults wire to the existing `chain_getBlockHash` / `checkBalance` / `readDustBalanceDirect` paths.

**Why Option Z over the hybrid:** the hybrid's 5 ports + 5 production adapters + 5 test adapters (~16 files) was over-engineering. Option Z gets the same user-facing wins (tip-aware invalidation, in-memory layer, write-invalidation, force-fresh, ergonomic call sites) and keeps cache-policy logic unit-testable, with one new file and ~150 lines.

If we later need pluggable storage backends, alternative RPC transports, or finer-grained ports, we refactor. By then we'll know what we actually need vs. what we're guessing about today.

**Defaults locked in:**
- `freshness = 'tip-aware'` — cache hit valid iff chain tip unchanged. Cheap RPC tip-check beats arbitrary TTL.
- `forceFresh = false` — opt-in.
- `withFacade` defaults to `syncMode: 'full'` and `requireStrictSync: true` — matches the dominant write path; readers opt out.
- `withFacade` auto-invalidates on resolve — write callers were doing this manually anyway.
- In-memory layer wins over disk; disk wins over network. Repeat reads in the same MCP-process tip cost zero.

**Acknowledged leak:** `withFacade(fn(lease))` exposes the SDK's `FacadeBundle` so callers can build/sign/submit. Defining an opaque handle would require wrapping the SDK's `transferTransaction` / `signRecipe` / `finalizeRecipe` surface — premature. Accept the leak; tests through `withFacade` are integration tests against localnet.

**Validation lock-in moment:** Step 4 (migrating `executeTransfer` to `withFacade`) is when the write-side semantics get committed. Pause and review after Step 4 before fanning out to other write paths.

### TODO

- [x] Frame the problem space + invariants
- [x] Design 3+ candidate interfaces in parallel
- [x] Pick a design (Option Z — ergonomic surface, four seams)
- [x] **Step 1** — land the repo + tests (commit `21b3de9`, branch `arch/wallet-data-repository`).
      8 boundary tests passing in 66ms; smoke-tested against real localnet
      (cold dust read 241ms → memo hit 3ms; cold unshielded 13ms → memo hit 7ms).
      No callers migrated yet.
- [x] **Step 2** — `dust status` migrated to `repo.dust(...)`. CLI human path
      schema-identical to baseline (only the time-varying `dustBalance` /
      `eventsApplied` / `cached` fields shift, as expected). MCP slim shape
      preserved. In-process back-to-back: cold 3050ms → memo hits 2–4ms (~1000×).
- [x] **Step 2.5** — preprod cold-sync was broken pre-existing (180s timeout
      rejected and lost 184k events of work). Fixed by: bumping
      `readDustBalanceDirect` default timeout to 600s, changing the timeout
      semantic from "reject" to "resolve with `partial: true`", adding an
      `onCheckpoint` callback the repo wires to `saveDustCache` (persists every
      ~500 events), and auto-retrying on partial in `repo.dust()` (bounded to 6
      iterations = ~60min total). Off-by-one in `lastEventId` update order
      (caught by interrupt+resume verification on preprod) fixed in `f86a7dd`.
      Verified end-to-end on preprod:
      - alice (243k events): cold 235s, warm 3.85s.
      - bob (different wallet, 234k events): cold 232s.
      - Mid-sync interrupt at 20s: 26.6KB checkpoint persisted; next call
        resumed from checkpoint and applied the remaining ~213k events,
        balance matches uninterrupted-sync result.
      - `mn transfer bob → alice 1 NIGHT --network preprod`: 28s
        end-to-end (warm cache; 9 delta events to prime); transfer landed
        correctly (alice +1, bob -1).
- [x] **Step 3** — `balance` migrated to `repo.unshielded(...)` for both
      paths (positional address + wallet's unshielded portion). Shielded
      portion stays inside the existing facade lifecycle until Step 4
      collapses it into `withFacade`. Both `mn balance --json` outputs
      verified byte-for-byte identical on undeployed (positional + wallet).
      `ReadOptions` gained `onProgress?: (current, highest) => void` so
      callers can wire spinner percentages through the repo.
- [x] `wallet info` — confirmed nothing to migrate (reads only `~/.midnight/wallets/<name>.json`,
      doesn't touch dust/wallet-cache files).
- [x] **Step 4 (lock-in moment)** — `executeTransfer` migrated to
      `repo.withFacade(...)`. Three retry loops collapsed into the repo:
      sync-retry on `StaleCacheError` + timeout, cold-start race retry on
      `Wallet.InsufficientFunds`, plus optional dust pre-prime in write-mode.
      `executeTransfer` body shrank from ~225 lines (orchestration + 3 retry
      loops) to ~70 lines (validate, pre-flight, ensureDust, build/submit).
      SDK error classifiers extracted to `src/lib/sdk-errors.ts` to break
      a circular import. Verified:
      - Cold undeployed `mn airdrop`: 18s end-to-end.
      - Preprod `mn transfer bob → alice 1 NIGHT`: 27s, txHash returned.
      - 893 tests passing.
      **Pause and review before fanning out.**
- [x] **Step 5** — remaining write commands migrated:
      - `shieldedTransfer` (commands/transfer.ts) → `withFacade`
      - `shieldedAirdrop` (commands/airdrop.ts) → `withFacade`. Step 1
        (read user shielded address) skips facade entirely now via the
        new `deriveShieldedAddress` helper — pure key derivation.
      - `dustRegister` (commands/dust.ts) → `withFacade`. Caller
        boilerplate (validateNetworkCaches, primeDustCache, buildFacade,
        signal handling, cleanup) collapsed.
      - `balance --wallet` Phase 2 shielded → `withFacade { readOnly: true,
        syncMode: 'no-dust' }`. JSON output schema-identical to Step 3
        baseline (only data values differ).
      - `contract preflight` → `repo.unshielded` + `repo.dust` directly
        (lighter than facade — pure reads).
      Verified end-to-end on undeployed:
        - airdrop dev-bob: 21s, txHash returned.
        - shielded airdrop dev-alice: 20.5s, txHash returned.
        - shielded transfer alice → bob: 49s, txHash returned.
        - dust register dev-bob: 31s, txHash returned.
        - balance --wallet: schema-identical JSON.
      `mn serve` deferred — long-lived facade is a different lifecycle
      pattern that doesn't fit `withFacade`'s borrow shape.
- [x] Cleanup: dropped `walletAddress` / `networkName` from `TransferParams`
      and all four call sites. They were vestigial cache-key plumbing — the
      repo derives both from the seed.
- [x] **Measurement** — `scripts/measure-preprod-dust.ts`. Real preprod
      numbers against alice (236k dust events):

      | Scenario                       |       Time | Speedup vs cold |
      |--------------------------------|-----------:|----------------:|
      | Cold (no disk, no memo)        | 237,703 ms |             1×  |
      | Disk-warm (new CLI process)    |   1,925 ms |          **123×** |
      | Memo-warm (MCP / same process) |       4 ms |       **59,426×** |

      **Plus correctness:** pre-repo the cold case never completed
      (180s timeout, 0 events saved). The repo's partial-resume +
      checkpoint fix made cold succeed at all.
- [ ] Migrate `serve` (long-lived facade — different pattern)
- [ ] Delete cache utilities + their tests once nothing imports them
      (note: the cache modules `wallet-cache.ts`, `dust-direct-cache.ts`,
      `dust-prime.ts` are still legitimately used — by the repo internally
      and by `mn serve`. Real deletion blocked on the serve migration.)

## #3 — Facade lifecycle (next)

After #1 lands, most facade calls are repo reads. What's left is the proof/submit
half. Extract a `withFacade(seed, network, work)` so write commands stop owning
build/sync/save/stop themselves.

- [ ] Inventory remaining facade lifecycle call sites after #1
- [ ] Design `withFacade` contract
- [ ] Migrate write commands one at a time

## #4 — Retry / recovery (folded into #1)

Don't ship separately. The repo's "fetch + retry on transient failures" helper
is the natural home. Carry the existing retry policies (cold-start race,
dust-poll, stale-cache rebuild) into the repo's contract.

- [ ] As part of #1: classify all current retry sites and pick which collapse into the repo's read/write methods
- [ ] As part of #1: keep a `withRetry(policy, op)` helper for the few that don't fit (e.g. proof generation)

## #2 — RPC / subscription transport (later)

Four WS clients today (`node-rpc.ts`, `balance-subscription.ts`, `dust-direct.ts`,
`chain-id.ts`). Same lifecycle (open → handshake → subscribe → settle → close)
duplicated 4×. JSON-RPC vs `graphql-transport-ws` differ enough that they can't
trivially share, but timeout/abort/idle/error-mapping can.

- [ ] Defer until after #1 — repo will tell us the exact shape we need
- [ ] When ready: design a `Subscription<T>` abstraction with both protocol adapters

## #5 — MCP tool factory (later)

`mcp-server.ts` has 25 tool entries; `buildArgs` covers ~70%, the remaining 30%
(positional extraction, flag deletion) is per-tool boilerplate. Lowest-impact
of the five — defer until adding a new tool starts to hurt.

- [ ] Defer until there's a concrete trigger (new tool that exposes pain)

---

## Out of scope (do not chase)

- Multi-process distributed cache (not needed; single-user CLI).
- Replacing the SDK's facade with our own implementation.
- Anything that breaks the byte-for-byte `mn <cmd> --json` contract.

## Surfaced during Step 2 (file as separate work)

- **`captureCommand` concurrency bug.** `setCaptureTarget(fn)` is module-global
  state. When an MCP client batches three `tools/call` requests and the SDK
  dispatches them concurrently, all three handlers race to overwrite the same
  global; only the last one's caller sees the `writeJsonResult` payload, the
  other two get `{}`. Pre-existing — masked because tool calls used to be slow
  enough they finished before the next started. Memo-hit reads now complete in
  microseconds and surface the race. Fix: associate the captureTarget with each
  invocation (e.g. async-local-storage or pass a captureBuffer through the call
  chain). Out of scope for Step 2; track in a follow-up.
