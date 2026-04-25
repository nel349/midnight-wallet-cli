# Token Budget Plan for Agent MCP Surface

## Status: All phases shipped 2026-04-24. Plan can be archived.

## Goal

Reduce tokens consumed when an AI agent uses `midnight-wallet-cli` through
MCP by ~50%, without changing any byte humans see — whether they run
`mn <cmd>` (formatted) or `mn <cmd> --json` (structured). Agents get
small payloads by default, opt into full shape via an explicit arg.

## Hard principles

1. **Zero change to human output.** `mn wallet list`, `mn balance`, etc.
   are byte-for-byte identical to today. Enforced by diff tests in CI.
2. **`--json` contract is preserved.** Any script piping `mn <cmd> --json`
   keeps working. The agent-slim path is reached through
   `captureCommand` (MCP only), not through `--json`.
3. **No new flags humans need to learn.** If a human ever needs the
   agent-slim shape, that's a v2 conversation.
4. **Agents can always escape to full.** When an agent needs the full
   payload, it passes `full: true` — documented in the tool schema.

## Where tokens live (audit)

| Layer | Who sees it | Humans affected by a trim? |
|---|---|---|
| A. MCP protocol surface (`tools/list` descriptions, `resources/read` skill) | Only MCP clients | No — humans never see this |
| B. Tool response payloads | Humans via `--json` + agents | Yes if we trim by default → trim via agent-only path |
| C. Error prose | Humans + agents | Yes if we default to codes → add codes alongside, keep prose |

## Locked decisions

**D1 — where to inject agent-mode trim: Option X.**
`captureCommand` (src/lib/run-command.ts) injects `_minimal: true` into
`args.flags` before invoking the command handler. Handlers check for it
and emit a slim JSON shape. Human `--json` path never sees `_minimal`,
so its output is unchanged. Single source of truth (one handler per
command); no duplicated response-shaping logic at the MCP layer.

**D2 — skill resource: split into core + full.**
- `midnight-wallet://skill/core` — intent routing table + safety rules.
  Target ~1.5k tokens. Agents fetch this by default on session start.
- `midnight-wallet://skill/full` — canonical flows, error recovery,
  deeper concepts. Agents fetch on demand when they hit something the
  core doesn't cover.
- `midnight-wallet://skill` (current single URI) stays as a deprecated
  alias pointing at `/full` so existing MCP clients don't break.

**D3 — `wallet_list` agent-default: active-network only.**
Default agent response per wallet is `{ name, active, network, address, shieldedAddress }`
where address + shieldedAddress are the ones for the currently-resolved
network. Agents passing `full: true` get the full 3-network
`addresses` + `shieldedAddresses` maps exactly as today. Human
`mn wallet list --json` is unchanged.

## Phased rollout

Each phase ships independently, with a measurement re-run in its PR.

| Phase | Scope | Human-visible risk | Est. token delta |
|---|---|---|---|
| **0** | Commit `scripts/measure-mcp-tokens.sh` + `docs/TOKEN-BUDGET.md` baseline. No code change. | None | 0 |
| **1** | Trim `tools/list` descriptions (Layer A). Move verbose prose to the full skill doc. | None | −1,400 tokens/session |
| **2** | Skill split per D2. Old URI stays as alias. | None | −1,400 tokens/session |
| **3** | Pilot D1 + D3. `captureCommand` injects `_minimal: true`; `midnight_wallet_list` respects it. Add `full: true` arg to its schema. Byte-for-byte diff test for `mn wallet list --json` before/after. | None if D1 holds | −4,000 tokens per list call |
| **4** | Roll `_minimal` to `wallet_info`, `balance`, `dust_status`. Same `full: true` escape hatch. Same diff tests. | None | −700 tokens/call |
| **5** | Structured error codes **alongside** prose (not replacing). Agents index on the code; humans still see the sentence. | None | −60 tokens/error |

## Measurement framework

**Every phase's PR must include:**
1. Re-run of `scripts/measure-mcp-tokens.sh` with old → new bytes/tokens.
2. `docs/TOKEN-BUDGET.md` updated with the new baseline row.
3. Byte-for-byte diff test: human `--json` output compared before/after
   the change. Regression fails CI.
4. One paragraph in the PR describing any agent-behavior change (e.g.
   "agents now need to pass `full: true` to get per-network breakdown").

## Open uncertainties (can't fully answer before shipping)

1. **`--json` consumers outside our own code.** Assumption: none.
   Validate by `rg -g '!node_modules' 'midnight.*--json|mn.*--json'`
   across all sibling projects before Phase 3.
2. **Agent behavior with slim responses.** If agents call `wallet_list`
   then re-call `wallet_info` to get data the slim response omitted, we
   may negate the savings. Watch real MCP session traces after Phase 3
   lands. Have `full: true` be the escape valve.
3. **Skill trim correctness.** Core-only skill might leave agents less
   accurate on edge cases. Phase 2 keeps the old URI as an alias so
   reverting is one-line if we see regressions.
4. **Tool-description trim boundary.** Too terse → agent picks wrong
   tool. Err on the side of keeping intent-discriminating words; drop
   only redundant "this tool does X" prose when the tool name already
   says X.

## Explicitly out of scope

- Universal field trimming (breaks `--json` contract).
- Default error-code-only responses (hurts human onboarding).
- Deprecating the full skill file (agents need it for correctness edge cases).
- New human-facing flags.

## Cross-references

| Artifact | Path |
|---|---|
| This plan | `docs/tasks/token-budget-plan.md` |
| Token baseline (to be created in Phase 0) | `docs/TOKEN-BUDGET.md` |
| Agent Protocol Spec | `docs/AGENT-PROTOCOL.md` |
| MCP skill file | `docs/SKILL.md` |
| MCP wrapper | `src/lib/run-command.ts` |
| MCP server | `src/mcp-server.ts` |
| CLI dev-ux plan (shipped) | `docs/tasks/archived/cli-dev-ux-plan.md` |
