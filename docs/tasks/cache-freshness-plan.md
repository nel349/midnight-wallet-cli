# Cache Freshness Detection Plan

## Status: S1 shipped 2026-04-23. Residual-race fix shipped 2026-04-23. S2 + S3 deferred.

## Goal

Detect stale wallet caches across every way they can go stale — not just
the local `mn localnet down` case we already handle — and auto-recover
before the user hits a cryptic sync hang or a `Custom error 170` proof
rejection.

## Trigger map (where caches go stale today)

| Trigger | Detection today | Gap |
|---|---|---|
| `mn localnet down` | ✅ `StaleCacheError` + auto-wipe-on-teardown (commit `3da6f43`) | none |
| Remote testnet reset (preprod/preview re-indexed) | ❌ `applied > highest` doesn't fire — chain is bigger than us, just on a different chain | **S1** |
| Event re-numbering (partial chain replay) | ❌ `applied` points at an event that doesn't match what we remember | **S2** |
| Commitment-tree / dust root retention pruning (~1h on preprod) | ❌ No sync-time error; surfaces as `InvalidDustSpendProof` on submit | **S3** |
| Different network pointed at same cache (config error) | ✅ network name in cache vs requested | none |

## S1 — Genesis/chain-ID fingerprint (committing now)

**Mechanism:** every cache file (wallet + dust-direct) gets a top-level
`chainId` field holding the chain's genesis block hash
(`chain_getBlockHash(0)` via substrate JSON-RPC). On cache load, fetch
the chain's current genesis hash and compare. Mismatch → unlink the
cache + treat as cold start.

**Scope:**
- `src/lib/wallet-cache.ts` — add `chainId` to `CacheFile`, populate on save, validate on load.
- `src/lib/dust-direct-cache.ts` — same.
- New shared helper `src/lib/chain-id.ts` fetches + memoises the genesis hash per node URL (1-minute in-memory TTL so repeated calls within a session don't re-fetch).

**Behaviour on mismatch:**
- Silent wipe (same as our existing `localnet down` behaviour) + a single `  Detected chain reset — clearing stale cache` log line to stderr so the user understands the one-time delay.
- Does NOT fail the command; the next sync runs from scratch.

**Failure modes handled:**
- Node RPC unreachable → best-effort: skip the check, proceed with cache. (Offline dev doesn't get false-invalidation.)
- Cache file predates this feature (no `chainId` field) → treat as valid (back-compat). One-time; next save adds the field.

**Cost:** one extra JSON-RPC call per command invocation (memoised).
~50 bytes added per cache file.

## S2 — First-event re-verification (deferred)

**What it catches:** chain re-numbering or gaps where our cached `applied = N` points at an event that no longer exists or has a different tx hash. S1 catches full resets; S2 catches partial invalidations.

**Mechanism:** before trusting a restored cache, query the indexer for the event at our cached `appliedIndex` and diff its hash. Mismatch → wipe.

**Cost:** one indexer query per session. Non-trivial to wire because the "prove the restored state is still valid" check isn't exposed by the facade today — might need a targeted GraphQL query.

**Trigger to implement:** if S1 doesn't catch the majority of reported staleness issues, or if a report comes in that isn't explained by a chain-ID mismatch.

## S3 — Root retention check (deferred)

**What it catches:** proofs built against a commitment/dust root that the chain has since pruned out of its retention window. Surfaces today as `Custom error 170 / InvalidDustSpendProof` at submit time.

**Mechanism:** before any write, query the indexer for the currently-valid root set. If our cache's most-recent root isn't in it, re-sync to pull a currently-anchored root before building the proof.

**Cost:** one query before each write. Effectively one round-trip added to transfer/airdrop/dust register.

**Trigger to implement:** when preprod users report `Custom error 170` despite `requireStrictSync: true` — i.e. the current sync-before-prove strategy isn't tight enough.

## Decisions locked in (S1 scope)

1. **Per-file chainId**, not a shared `_chainid.json`. Simpler; no separate file management; 50 bytes per cache is negligible.
2. **In-memory fetch memo** per node URL (1-minute TTL) so rapid back-to-back commands don't each re-fetch.
3. **Visible one-liner** on mismatch ("Detected chain reset — clearing stale cache") so the user understands why this run is slow.
4. **Best-effort on RPC failure** (skip check, don't block). Offline dev works.
5. **Back-compat:** caches without `chainId` are treated as valid. Next save adds the field.

## Residual race: WalletFacade cold-start vs. localnet_up (fixed 2026-04-23)

**Where it shows up:** a fresh MCP session or shell fires `mn airdrop`
within a second of `mn localnet up` returning. The facade's state
observable emits a snapshot with coins populated (balance reads 5 UTXOs
correctly), but `transferTransaction`'s internal `#balanceSegment` coin
index is still empty → throws `Wallet.InsufficientFunds` at tx-build
time. Direct `mn balance <genesis>` (lightweight GraphQL path) sees the
funds fine; `mn airdrop` after a ~30s settle also works.

**Root cause:** the SDK's `shareReplay` cache on the state observable
lags the internal coin index. Once the index is stale, `quickSync` is a
no-op — it returns the already-cached state. The only recovery is
`stopFacade` → `buildFacade` → `startAndSyncFacade` to get a fresh
subscription, with a small pause so the indexer can stabilise.

**Earlier mitigation (insufficient):** a balance-reads-0 retry after
sync. Didn't trigger in this bug because the state snapshot *did* show
coins — the zero only appeared inside the SDK at tx-build time.

**Fix shipped in `lib/transfer.ts`:**
- New `isSdkInsufficientFundsError` distinguishes the SDK's
  `Wallet.InsufficientFunds` (raised as `_tag` or bare message) from our
  own pre-flight `Insufficient balance:` error.
- `buildAndSubmitTransfer` bubbles that error up instead of looping on
  `quickSync` (which used to spin ~870k iterations over 2 min before
  failing).
- `executeTransfer` wraps `ensureDust + buildAndSubmitTransfer` in a
  bounded outer retry (5 attempts × 5s delay). On `InsufficientFunds`:
  `stopFacade`, wait, rebuild the facade from the cache, re-sync, retry.
- Happy path unaffected — the retry only fires on the specific SDK error.

**Measured:** cold localnet + `mn airdrop --json` succeeds in ~30s (was
120s failure). Warm follow-up succeeds in ~19s with no retry overhead.

**Not mitigated:** the same race could affect other facade-based writes
on a cold localnet. Apply the same bounded-retry pattern if it surfaces.
A real fix still requires the SDK to defer its sync-complete signal
until the coin index is populated.

## Separate but related: `mn localnet up` readiness gap

Surfaced by the blank-start measurement — `localnet_up` returns when
Docker reports containers healthy, but the chain hasn't produced block
1 yet, so immediately-subsequent operations (airdrop) see genesis
with zero UTXOs.

**Fix:** after `waitForHealthy` in `handleUp`, poll substrate
`chain_getHeader` until `result.number >= 0x1` (i.e. block 1 produced).
Bounded retry (~30s), warn but don't fail if exceeded.

Lives in this plan because it shares infrastructure with S1 (both use
substrate JSON-RPC via `ws`).

## Cross-references

| Artifact | Path |
|---|---|
| This plan | `docs/tasks/cache-freshness-plan.md` |
| Token-budget plan | `docs/tasks/token-budget-plan.md` |
| Existing StaleCacheError detector | `src/lib/facade.ts` |
| localnet teardown cache wipe | commit `3da6f43` |
