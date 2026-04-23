# CLI Developer Experience Plan

## Status: All 8 items shipped 2026-04-22. See Shipped section below.

## Positioning

`midnight-wallet-cli` aims at two audiences, first-class for both:

1. **Beginners to Midnight** — `mn` is the tool you use on day one, before you've learned what dust or shielded even is. Localnet + funded wallets + contract deploy in under 5 minutes.
2. **AI agents (Cursor, Claude Code, custom MCP clients)** — same primitives via the built-in MCP server. The skill file + tool annotations + confirmation tokens turn any MCP client into a Midnight expert on the user's behalf.

Same primitives, two surfaces. The MCP server exposes the same commands the human calls directly. Nothing an agent can do is something a human cannot do from the terminal.

## Why this plan exists now

From five weeks of dev-chat + unanswered-questions reports (`/Users/norman/Development/tech-moderator/reports`):

- Devs rage-quit Hello World at ~72h in. Version mismatches, outdated Academy content, 30+ min preprod cold sync.
- Iteration cycle on preprod is 30+ min per contract change. Most devs don't know they should be on localnet.
- `mn serve` + MCP + connector already exist but aren't being promoted as "the agent CLI."
- **1AM shipped viewing-key "FastSync" 2026-04-20.** Proves demand, took the privacy-violating path. Leaves the principled lane open.

## Relationship to existing plans

This plan **complements**, does not replace:

- **`tasks/agent-wallet-vision.md`** — agent-protocol-axis. Still open. Items 1–4 (MCP annotations, skill file, confirmation tokens, protocol spec) are coding tasks and are folded into the sequence below. Items 5 (team presentation) and 6 (repo decision) are meta/strategic — tracked in agent-wallet-vision.md, not duplicated here.
- **`tasks/shielded-implementation.md`**, **`docs/tasks/todo.md`**, **`docs/tasks/enhancements.md`** — historical, shipped.
- **`kuira-android-wallet/docs/PLAN.md` Phase 9** — PIR-based `midnight-spendability-indexer`. Ecosystem initiative, scoped at Kuira, queued post-v1.1. When it lands, this CLI becomes an early consumer. This plan does not duplicate it.

## Strategic principles

1. **Localnet by default for dev.** Preprod cold sync is a real problem. Instead of trying to solve it everywhere, route 90% of dev time onto localnet where it doesn't exist.
2. **Don't trade privacy for speed.** No viewing-key sync, no opt-in shortcut that hands transaction history to a server. Day-0 preprod stays slow until PIR (or upstream view-tag filtering) lands.
3. **Make the slow parts feel progressing, not broken.** ETA + resumability is cheap and removes most of the rage-quit pressure.
4. **Reuse what's already there.** `mn localnet`, multi-wallet, airdrop, dust register, `mn contract deploy/call/state`, `mn serve`, MCP — all primitives exist. New work is orchestration, not duplication.
5. **Scaffold via `create-mn-app`, don't invent templates.** Let `mn dev` detect and work against projects that template produces.

## Proposed sequence

| # | Item | Status | Commit |
|---|---|---|---|
| 1 | MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) on all 24 tools | ✅ | `dde2fa3` |
| 2 | `midnight-wallet` MCP skill file exposed via `midnight-wallet://skill` Resource | ✅ | `c51a9b3` + `c26ac40` |
| 3 | `mn dev` M1 + M1.5 — project detection, localnet auto-up, dev wallet provisioning, compile-on-save | ✅ | `4940792` + `9b2251c` |
| 4 | Confirmation token flow for `midnight_transfer` (+ `midnight_confirm_operation`) | ✅ | `b00c717` |
| 5 | `mn dev` M2 — `d` deploys, `q` quits via raw-mode keystrokes | ✅ | `d08a108` |
| 6 | Day-0 sync UX — ETA + rate on `mn balance` shielded sync | ✅ (first pass) | `feee98c` |
| 7 | `mn dev` M3 — `t` runs `npm run test:dev` / `test` with streaming output | ✅ | `1ceafac` + `a21929e` |
| 8 | Agent Protocol Spec doc (annotations, skill resource, confirmation tokens) | ✅ | this commit |

All 8 items shipped. Follow-ups scoped out of the original plan are listed below.

## Open decisions

Before starting each item, resolve:

**For `mn dev` (items 3, 5, 7):**
- **Compile strategy** — the toolchain is `compact` (invoked as `compact compile`). Shell out to `compact compile` directly, or delegate to a `package.json` script (`npm run compile`) if present? Leaning: prefer the project's script if defined, fall back to `compact compile`.
- **Project detection** — what signals identify a create-mn-app project? `package.json` + a specific dep, presence of `*.compact` files, existence of `src/managed/`? Pick a minimal reliable heuristic.
- **Test semantics** — user-defined `npm run test:dev` wrapper (3a, ship first) vs. baked per-contract-shape scenarios (3b, later). Confirm 3a as first cut.
- **File watcher scope** — watch `src/**/*.compact` only, or the whole `src/` dir? Debounce window (300ms vs 500ms)?
- **Keystroke UX** — raw-mode single-key dispatch. Reuse exit cleanup patterns from `mn serve`.
- **Wallet namespace** — ephemeral wallets (`dev:alice`, `dev:bob`) or use existing named wallets? Defaulting to ephemeral avoids clobbering the user's real wallets; flag to override.
- **Wallet count + funding** — default 3 wallets on localnet with N NIGHT each. Configurable via flag.

**For Day-0 sync UX (item 6):**
- Progress hook — does `startAndSyncFacade`'s existing `onProgress` callback give us enough signal for ETA, or do we need per-phase event counts?
- Resumability — the wallet-cache already serializes state every save. Confirm whether a Ctrl+C mid-sync currently leaves a usable checkpoint or drops progress.

**For MCP annotations (item 1):**
- Map existing 24 tools to the three hints. Most are obvious; a few (like `localnet_up`) warrant discussion.

## Follow-ups explicitly deferred during implementation

These came up while shipping the 8 items and were consciously not bundled in,
so future sessions don't rediscover them cold.

- **Write-command ETA** — item 6 added ETA to `mn balance` only; `transfer`, `airdrop`, `dust register` still show pct-only. Pattern proven; rolling it out is mechanical.
- **Mid-sync cache snapshots** — interrupted syncs currently lose progress because wallet-cache only persists at end-of-sync. Needed before we can truthfully claim "safe to interrupt" during Day-0. Non-trivial (need to snapshot a live facade without corrupting state).
- **`mn contract deploy` witness generation** — auto-runner still requires a `witnesses.js` module on disk. For witness-less contracts we could auto-generate stubs; pre-flight now produces a clear error instead, which is good enough for now.
- **`mn dev` `r` reset-wallets keystroke** — user can `mn wallet remove dev-alice && mn dev` to re-provision; in-process reset wasn't load-bearing for M2.
- **Spinner migration of the remaining write-command sites** — item 5's cleanup fixed the 8 `spinner.stop(red('✗')+...)` anti-pattern sites; no new ones introduced since.
- **Protocol v1** — `AGENT-PROTOCOL.md` ships as v0. Policy engine, agent identity, and intent format are flagged as out-of-scope for v0 there; v1 waits until there's shipped evidence from real agents using v0.

## What's explicitly out of scope here

- **Viewing-key sync** — regardless of demand pressure. Privacy defaults.
- **PIR client implementation** — tracked in Kuira `PLAN.md` Phase 9. CLI consumes it when it ships; does not build it.
- **Inventing our own templates** — defer to `create-mn-app` upstream. Fine for `mn dev init` to delegate (spawn `npx create-mn-app`) as a convenience; not fine to hand-roll templates in this repo.
- **Web UI / dashboard** — CLI stays CLI.

## Cross-references

| Artifact | Path |
|---|---|
| This plan | `docs/tasks/cli-dev-ux-plan.md` |
| Agent Protocol Spec (v0) | `docs/AGENT-PROTOCOL.md` |
| MCP skill file | `docs/SKILL.md` |
| Agent wallet vision | `tasks/agent-wallet-vision.md` |
| Kuira PIR plan (Phase 9) | `/Users/norman/Development/android/projects/kuira-android-wallet/docs/PLAN.md` |
| Contract runner (reusable for `mn dev`) | `src/lib/contract/runner.ts` |
| Contract command dispatch | `src/commands/contract.ts` |
| Wallet cache (already does serializeState/restore) | `src/lib/wallet-cache.ts` |
| create-mn-app | https://github.com/midnightntwrk/create-mn-app |
| Dev-chat pain points | `/Users/norman/Development/tech-moderator/reports/week11/` |
| 1AM FastSync (reference for what not to do) | social post 2026-04-20 |
