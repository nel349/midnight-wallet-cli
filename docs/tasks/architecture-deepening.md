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

- [ ] Frame the problem space + invariants (skill step 4)
- [ ] Design 3+ candidate interfaces in parallel (skill step 5)
- [ ] Pick a design (skill step 6)
- [ ] File RFC as GitHub issue (skill step 7)
- [ ] Implement repository surface
- [ ] Migrate one read path (`dust status`) end-to-end as the canonical example
- [ ] Migrate the rest of the read paths (`balance`, `wallet info`, `dust register` pre-check)
- [ ] Migrate the write paths (`transfer`, `airdrop`, `dust register`, `serve`, `contract`)
- [ ] Boundary tests on the repo interface; delete shallow cache unit tests
- [ ] Measure preprod dust-status latency before/after on a warm session

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
