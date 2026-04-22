# CLI Developer Experience Plan

## Status: Drafted 2026-04-21 — pending decisions on sequencing

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

| # | Item | Source | Effort | Rationale |
|---|---|---|---|---|
| 1 | MCP tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) | agent-vision #1 | ~2h | Cheapest agent-safety win. Unblocks 3. |
| 2 | `midnight-wallet` MCP skill file (Claude Code / Cursor / any MCP client) — conversational guide, intent routing, multi-step flows | agent-vision #2 | ~1 day | Makes any MCP client a Midnight power user. Sells the agent story. |
| 3 | `mn dev` M1 — detects create-mn-app project, spins localnet + funded/dust-registered wallets, watches `*.compact`, compile-on-save via `compact compile` | new | ~1–2 days | The visible "start a new Midnight project" demo. Headline feature. |
| 4 | Confirmation token flow for `midnight_transfer` MCP tool (Giza pattern) | agent-vision #3 | ~1 day | Safer agent writes. Required for serious agent use. |
| 5 | `mn dev` M2 — `d` keypress deploys via existing `runDeploy`, `r` resets wallets, `q` quits | new | ~0.5 day | Completes the iteration loop. |
| 6 | Day-0 sync UX — accurate progress (events applied / highest, ETA), resumable-on-Ctrl+C, "safe to interrupt" messaging | new ("Play 1") | ~1–2 days | Makes preprod first-sync tolerable. Aligns with Kuira Phase 9 "cheaper optimization #2". |
| 7 | `mn dev` M3 — test runner (user-defined `npm run test:dev` script; baked scenarios later if demand) | new | ~1 day | Closes the dev loop. |
| 8 | Agent Protocol Spec doc (policy, confirmation tokens, annotations, intent format) | agent-vision #4 | ~1–2 days | Turns the shipped behavior into an ecosystem proposal. |

Order is not fixed — items 1, 2, 3 are the first-ship core. 4–7 close the obvious gaps. 8 is the narrative layer once there's working evidence. Effort numbers are rough; assume 1.5× for anything novel.

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

## What's explicitly out of scope here

- **Viewing-key sync** — regardless of demand pressure. Privacy defaults.
- **PIR client implementation** — tracked in Kuira `PLAN.md` Phase 9. CLI consumes it when it ships; does not build it.
- **Inventing our own templates** — defer to `create-mn-app` upstream. Fine for `mn dev init` to delegate (spawn `npx create-mn-app`) as a convenience; not fine to hand-roll templates in this repo.
- **Web UI / dashboard** — CLI stays CLI.

## Cross-references

| Artifact | Path |
|---|---|
| This plan | `docs/tasks/cli-dev-ux-plan.md` |
| Agent wallet vision | `tasks/agent-wallet-vision.md` |
| Kuira PIR plan (Phase 9) | `/Users/norman/Development/android/projects/kuira-android-wallet/docs/PLAN.md` |
| Contract runner (reusable for `mn dev`) | `src/lib/contract/runner.ts` |
| Contract command dispatch | `src/commands/contract.ts` |
| Wallet cache (already does serializeState/restore) | `src/lib/wallet-cache.ts` |
| create-mn-app | https://github.com/midnightntwrk/create-mn-app |
| Dev-chat pain points | `/Users/norman/Development/tech-moderator/reports/week11/` |
| 1AM FastSync (reference for what not to do) | social post 2026-04-20 |
