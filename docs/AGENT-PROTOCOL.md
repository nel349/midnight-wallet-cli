# Agent Protocol for Privacy-Chain Wallets — Draft v0

> Status: working draft, v0. Reflects what `midnight-wallet-cli` ships today
> as of `1ceafac` + follow-ups. Not yet a standards proposal — this document
> exists so other wallets / tools can align on the same primitives.

## Motivation

Privacy-chain wallets face a specific tension: AI agents want to automate
on-chain actions, but the chain's core value is that transactions aren't
observable to third parties. An agent protocol for a privacy chain must:

1. **Let agents act on the user's behalf** for read + write operations.
2. **Keep agent safety as a protocol-level feature** — not a per-tool hack or
   per-agent trust decision. The wallet surface should tell the agent which
   operations are safe and which require explicit user consent.
3. **Never leak transaction-graph privacy to the agent layer** — the same
   privacy guarantees the chain provides to end users must hold against
   agents, MCP hosts, or tools in the stack.

MCP (Model Context Protocol) already gives us the transport. This document
specifies the three wallet-level primitives that make MCP safe for
privacy-chain agents: **tool annotations**, **a skill resource**, and a
**two-step confirmation flow for destructive tools**.

## Primitive 1 — Tool Annotations

Every tool exposed by the wallet MUST declare applicable hints from the
MCP annotation schema. Agents consume these to apply safety policy
uniformly, without hardcoding per-tool rules.

```jsonc
// Example from midnight-wallet-cli's tools/list response:
{
  "name": "midnight_balance",
  "annotations": { "readOnlyHint": true, "openWorldHint": true }
}
{
  "name": "midnight_transfer",
  "annotations": { "destructiveHint": true, "openWorldHint": true }
}
{
  "name": "midnight_wallet_list",
  "annotations": { "readOnlyHint": true, "idempotentHint": true }
}
```

**Required annotations** (when applicable):

| Annotation | Meaning for agents |
|---|---|
| `readOnlyHint: true` | Safe to call without user consent. Balance checks, listings, address derivations. |
| `destructiveHint: true` | Moves funds, deletes files, tears down infra. MUST be gated by user consent. |
| `idempotentHint: true` | Repeated calls with the same args yield the same result — safe to retry. |
| `openWorldHint: true` | Touches the chain / network / Docker / external services. May fail non-deterministically. |

**Reference mapping** for midnight-wallet-cli's 25 tools is enumerated in
`mn help --agent` under `AVAILABLE MCP TOOLS`. Any wallet implementing this
protocol SHOULD publish an equivalent mapping in its own documentation.

## Primitive 2 — Skill Resource

The wallet MUST expose an MCP Resource at a stable URI containing a
conversational guide for agents. This is how agents ground responses in
current wallet behavior rather than in stale training data.

```jsonc
// resources/list response:
{
  "uri": "midnight-wallet://skill",
  "name": "midnight-wallet skill",
  "mimeType": "text/markdown"
}
```

**Required sections** (all must be present in the document):

- **Core concepts** — chain-specific vocabulary (NIGHT, DUST, shielded vs.
  unshielded, networks). Correct as of the shipped version, not as of
  when someone last trained a model.
- **Intent routing** — natural-language phrase → tool call mapping.
  ("Send 100 NIGHT to alice" → `midnight_transfer({...})`)
- **Canonical flows** — onboarding, safe transfers, contract deploy.
- **Safety rules** — what the annotations mean in practice; required
  consent rituals; never-do rules (e.g. never invent a mnemonic).
- **Error recovery** — common SDK errors with the exact recipe to fix.
  Keyed by error text / code the agent will actually see.

**Non-requirements:**

- The skill file MUST NOT reference external skills / MCP servers by name
  (they may not exist in the consumer's setup).
- The skill file MUST NOT cite specific timing numbers (sync duration,
  transfer latency) unless they are reproducible from a controlled
  benchmark and documented as such. "Takes N minutes" sourced from anec-
  dotal frustration belongs nowhere near agent-consumed docs.

Reference implementation: `docs/SKILL.md` in this repo, exposed by
`src/mcp-server.ts` via `ReadResourceRequestSchema`.

## Primitive 3 — Two-Step Confirmation for Destructive Tools

Any tool annotated `destructiveHint: true` whose effects the user would
not want silently executed MUST implement the two-step pending-token flow.

**Step 1** — Agent calls the tool. Instead of executing, the wallet returns:

```jsonc
{
  "pending": true,
  "token": "uuid-v4",
  "description": "Send 100 NIGHT from alice to mn_addr_preprod1... on preprod",
  "tool": "midnight_transfer",
  "expiresAt": "2026-04-22T19:09:15.483Z",
  "nextStep": "Show the description to the user, get explicit consent, then call midnight_confirm_operation with this token."
}
```

**Step 2** — Agent shows `description` to the user verbatim (the protocol
explicitly forbids paraphrasing amounts or recipients), gets explicit
consent, and calls:

```jsonc
{
  "tool": "midnight_confirm_operation",
  "arguments": { "token": "uuid-v4" }
}
```

The wallet MUST validate the token, execute the original operation with
the stored args, and return the result. Tokens are:

- **Single-use** — redemption removes the pending entry.
- **Time-bounded** — expire after N minutes (reference implementation
  uses 5). Expired tokens MUST produce a clear error, not silently
  succeed with stale args.
- **Per-process** — not persisted across wallet restarts.

**Scope guidance.** At minimum, fund-moving operations (`transfer` and
equivalents) MUST use this flow. Other destructive tools (wallet
removal, cache clearing, localnet teardown) MAY either use the flow
or rely on clients to apply `destructiveHint` at their layer — the
reference CLI uses the latter for localnet operations because the
blast radius is bounded to the dev's own machine.

Reference implementation: `src/lib/mcp/confirmation.ts` +
`CallToolRequestSchema` handler in `src/mcp-server.ts`.

## Non-normative reference

The complete shipped surface — 25 MCP tools, the skill resource, the
confirmation flow — lives in `midnight-wallet-cli`. Agents interacting
with it see exactly what this spec describes.

| Primitive | Spec section | CLI source |
|---|---|---|
| Annotations | 1 | `src/mcp-server.ts` TOOLS array |
| Skill resource | 2 | `docs/SKILL.md` + `src/mcp-server.ts` ListResources/ReadResource handlers |
| Confirmation tokens | 3 | `src/lib/mcp/confirmation.ts` + CallTool wrapper |

A CLI user can exercise the full agent surface without a real AI client:

```bash
# List tools with annotations:
echo -e '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | midnight-wallet-mcp

# Read the skill resource:
echo -e '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"midnight-wallet://skill"}}' | midnight-wallet-mcp
```

## Explicitly out of scope (v0)

These are open questions the v0 spec deliberately does not answer. Later
versions may address them once there's shipped evidence.

- **Policy engine** — per-agent spending limits, method allowlists, TTLs.
  Today the protocol only distinguishes read vs. destructive; a richer
  policy model needs real-world data on how agents actually misbehave.
- **Agent identity / registration** — how an MCP client authenticates
  itself to the wallet. Today the wallet trusts whichever client connects
  via stdio; remote transports (HTTP, WebSocket) will need identity.
- **Intent format** — declarative user goals that a solver can plan
  against. Charles's CAKE direction is the obvious destination; the
  protocol isn't ready to commit to a format.
- **Privacy-preserving fast sync** — PIR or view-tag filtering to
  eliminate Day-0 sync wait. Tracked as Kuira PLAN.md Phase 9;
  ecosystem-level infra work, not a wallet-side protocol concern.

## Changelog

- v0 (2026-04-22) — initial working draft. Captures what
  midnight-wallet-cli ships: 25 annotated tools, `midnight-wallet://skill`
  resource, `midnight_confirm_operation` flow for `midnight_transfer`.
