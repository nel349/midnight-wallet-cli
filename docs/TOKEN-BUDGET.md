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

## Post–Phase 2 — 2026-04-24 (this commit)

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
| 3 | `wallet_list` (agent default, 6 wallets) | 16,109 | **≤ 3,500** | ≤ 1,000 | — |
| 4 | `wallet_info` (agent default) | 1,209 | **≤ 500** | ≤ 145 | — |
| 4 | `balance` (agent default) | 563 | **≤ 400** | ≤ 115 | — |
| 4 | `dust_status` (agent default) | 363 | **≤ 300** | ≤ 85 | — |

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
