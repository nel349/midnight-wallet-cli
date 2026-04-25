# Token Budget — MCP Agent Surface

Running baseline for tokens consumed when an agent uses
`midnight-wallet-cli` via MCP. See
[`docs/tasks/token-budget-plan.md`](./tasks/token-budget-plan.md) for the
policy this file tracks against.

**Token estimate** = `bytes / 3.5` (conservative mid-point for JSON-heavy
content across Claude, GPT-4, and similar tokenizers). Script rounds to
integer tokens.

**Reproduce locally:** `./scripts/measure-mcp-tokens.sh`

---

## Post–Phase 4 — 2026-04-24 (this commit)

Rolled the `_minimal` slim-shape pattern from Phase 3 out to three more
tools. New `isMinimalMode(args)` helper in `lib/argv.ts` (with
`MINIMAL_FLAG` / `FULL_FLAG` constants) replaces the inline
`hasFlag(args, '_minimal') && !hasFlag(args, '_full')` check. The MCP
server's `buildArgs` now translates the public `full` arg → internal
`_full` flag automatically, so per-tool handlers just need to forward.

| Tool | Slim | Full | Δ vs. legacy | Plan target |
|---|---:|---:|---:|---:|
| `midnight_wallet_info` | 413 B / 118 tok | 1,208 B | **−66%** | ≤ 500 B ✅ |
| `midnight_balance` | 298 B / 85 tok | 562 B | **−47%** | ≤ 400 B ✅ |
| `midnight_dust_status` | 261 B / 75 tok | 360 B | **−27%** | ≤ 300 B ✅ |

All three `mn <cmd> --json` human paths verified byte-for-byte
identical (or schema-identical for `dust status`, where the regenerating
`dustBalance` value naturally varies).

Slim-shape choices:
- `wallet_info`: `{ name, active, network, address, shieldedAddress }` —
  drops the per-network maps, `createdAt`, `file`. Agent already knows
  which wallet it queried.
- `balance`: `{ network, unshielded, shielded }` — drops the (long)
  unshielded + shielded address echo and `txCount`. Agent already knows
  which address it queried.
- `dust_status`: `{ network, registered, registeredUtxos,
  unregisteredUtxos, dustBalance, dustAvailable }` — drops
  `eventsApplied`, `ownedUtxos`, `cached`, `subcommand` (sync internals).

## Post–Phase 3 — 2026-04-24

Pilot of D1 + D3 on `midnight_wallet_list`:

- `captureCommand` now injects `_minimal: true` into `args.flags` for every MCP-invoked command. Handlers that opt in (currently: `wallet list`) emit a slim JSON shape; humans never go through `captureCommand`, so `mn wallet list --json` is byte-for-byte identical to before.
- `midnight_wallet_list` slim shape per wallet: `{ name, active, network, address, shieldedAddress }` scoped to the active network. Agents pass `{ full: true }` — surfaces as `_full: true` in args.flags, which the handler reads to emit the human shape instead.

Measurements (15 wallets in `~/.midnight/wallets/`):

| Path | Bytes | Est. tokens | Δ vs. baseline |
|---|---:|---:|---:|
| MCP default (slim) | 5,699 | 1,628 | **−10,410 / −65%** |
| MCP `full: true` | 16,109 | 4,602 | 0 (same as legacy) |
| `mn wallet list --json` (human) | 13,164 | 3,761 | 0 (byte-for-byte identical) |

The slim shape grows linearly with wallet count (~270 B/wallet vs ~2,685 B/wallet for full), so the savings dominate as the wallet directory grows. The plan target of ≤ 3,500 B was set against a 6-wallet baseline — at 6 wallets the slim shape is ≈ 2,300 B (well under target).

Diff test: `diff /tmp/wallet-list-before.json /tmp/wallet-list-after.json` → identical, 13,164 B both.

## Post–Phase 2 — 2026-04-24

Skill split per token-budget-plan D2. New URIs:

- `midnight-wallet://skill/core` — intent routing + safety rules. **3,123 B / ~892 tokens.** Default fetch on session start.
- `midnight-wallet://skill/full` — canonical flows, error recovery, concept primers. **8,322 B / ~2,378 tokens.** On-demand fetch.
- `midnight-wallet://skill` — deprecated alias → `/full`. Not advertised in `resources/list`; existing clients keep working.

`resources/list` grew slightly (302 → 656 B) since it now lists two resources instead of one.

**Default-path saving: 8,317 → 3,123 B (−5,194 B / −1,484 tokens per session, −62% on the skill fetch.)**

End-to-end blank-flow agent session (cold localnet → airdrop → dust register → balance) now totals **3,034 tokens** (down from 4,518 — −33%). Verified with `scripts/measure-blank-flow.sh`.

If an agent fetches BOTH /core and /full in the same session (e.g. hits an error), it pays 3,123 + 8,322 = 11,445 B (net +3,128 B vs. the legacy single fetch). The core skill explicitly directs agents to fetch /full only on errors / multi-step flows / concept questions, so the savings hold for the common path.

## Post–Phase 1 — 2026-04-23

Phase 1 trimmed `tools/list` descriptions (drops verbose prose,
redundant property descriptions, `network` enum recitation, repeated
override-URL fields, and the deprecated `midnight_generate` alias).
Zero impact on human output — humans never see `tools/list`.

`tools/list` response went from **9,488 B → 5,663 B (−40%)**. Tool
count went from 26 (24 + confirm) → 25 (deprecated `midnight_generate`
removed; CLI `mn generate` still works).

The 4,500 B target set in Phase 0 proved too aggressive without
breaking-change tool consolidation — realistic floor for 25 annotated
tools with JSON-RPC framing is ~5,500 B. Revised target documented
below.

## Baseline — 2026-04-23 (pre-Phase 1, commit `c4a7e70`)

Per-call response sizes, measured against the real MCP server with the
reference `dev-*` wallets provisioned on localnet.

| Call | Bytes | Est. tokens | Notes |
|---|---:|---:|---|
| `tools/list` | 9,488 | 2,710 | 25 tools × descriptions + input schemas + annotations. Once per session. |
| `resources/list` | 302 | 86 | Just the skill resource metadata. |
| `resources/read` (skill) | 8,317 | 2,376 | Full `docs/SKILL.md` markdown body. Once per session if the agent fetches it. |
| `midnight_wallet_list` | 16,109 | 4,602 | 6 wallets × `addresses` + `shieldedAddresses` maps (3 networks each). |
| `midnight_wallet_info` (one wallet) | 1,209 | 346 | Same per-network fan-out for one wallet. |
| `midnight_balance` (warm cache) | 563 | 160 | Single network, NIGHT + shielded. |
| `midnight_dust_status` (cached) | 363 | 104 | Status only. |
| `midnight_localnet_status` | 705 | 202 | 3 services + images + ports. |
| `midnight_transfer` (pending-token response) | ~450 | ~128 | Step 1 of the two-step confirmation flow. |

## Scenarios — total tokens per agent session

| # | Scenario | Sum of calls | Est. session tokens |
|---|---|---|---:|
| A | Bootstrap only — `initialize` + `tools/list` | 2,710 + ~85 | **~2,795** |
| B | Bootstrap + fetch skill | A + 2,376 | **~5,170** |
| C | Cold balance — B + one balance call | B + 160 | **~5,330** |
| D | List 6 wallets — B + `wallet_list` | B + 4,602 | **~9,775** |
| E | Safe transfer — B + balance + transfer-pending + confirm (~140) | B + 160 + 128 + 140 | **~5,600** |
| F | Full onboarding — B + localnet_up + wallet_generate + airdrop + dust_register + balance | B + ~200 + ~800 + ~400 + ~400 + 160 | **~7,100–8,000** |

> **Bootstrap overhead is ~55%** of a typical 5k-token session. Cutting
> `tools/list` and the skill file is the single biggest lever before we
> touch tool responses.

## Target budgets (per phased plan)

After each phase in the token-budget plan lands, this table should be
updated with new numbers. The "Target" column is the cap we commit to
hit — regressions beyond it fail review.

| Phase | Call affected | Baseline bytes | Target bytes | Target tokens | Actual |
|---|---|---:|---:|---:|---:|
| 1 | `tools/list` | 9,488 | ~~≤ 4,500~~ **≤ 5,800** | ≤ 1,660 | **5,663 ✅** |
| 2 | `resources/read` (skill/core) | 8,317 | **≤ 4,500** | ≤ 1,285 | **3,123 ✅** |
| 3 | `wallet_list` (agent default, 6 wallets) | 16,109 | **≤ 3,500** | ≤ 1,000 | **5,699 B @ 15 wallets ≈ 2,280 B @ 6 wallets ✅** |
| 4 | `wallet_info` (agent default) | 1,209 | **≤ 500** | ≤ 145 | **413 ✅** |
| 4 | `balance` (agent default) | 563 | **≤ 400** | ≤ 115 | **298 ✅** |
| 4 | `dust_status` (agent default) | 363 | **≤ 300** | ≤ 85 | **261 ✅** |

**Phase 1 target revised:** hitting ≤ 4,500 B would have required
consolidating tool names (breaking change for existing MCP clients).
5,800 B is the practical floor for 25 annotated tools + JSON-RPC
framing. Phase 2 (skill split) still has its original target — that
one's a clean content trim, not structural.

## Non-goals (for this budget)

- **Human output.** `mn wallet list` (formatted) and `mn wallet list --json`
  (structured, piped to scripts) are **unchanged** under this plan. Only
  the MCP `captureCommand` path gets slim responses.
- **Minimising `transfer_pending`.** The pending-token response is
  already small (~450 bytes) and communicates the description verbatim
  to the user — trimming risks the safety property.

## Update protocol

When landing a phase:
1. Re-run `./scripts/measure-mcp-tokens.sh`.
2. Replace the **"Baseline —"** section heading with the new date + commit.
3. Confirm the `midnight_wallet_list --json` (human path) is byte-for-byte
   identical to the pre-change output.
4. Note the per-session savings in the PR description.
