# Agent Wallet Vision — Thinking Document

## Status: Exploring

## The Intuition

There's a convergence happening:
- **OWS** (Open Wallet Standard) — policy-gated agent signing, local key custody, multi-chain
- **Giza Hub** — three-layer agent DeFi (SDK → MCP → Skills), confirmation tokens, tool annotations
- **Charles's vision** — "language of agents is proofs," AI agents as first-class citizens, intent solvers
- **What we already built** — CLI wallet + DApp connector + MCP server + connector npm package + reference game

We're sitting at the intersection. Nobody has built a **privacy-first agent wallet** yet. OWS does multi-chain but no privacy. Giza does agent DeFi but custodial. Lace does Midnight but no agent story. We have the pieces.

## What We Have (CLI + Kuira + Connector)

```
midnight-wallet-cli (developer tool)
├── Local key custody (BIP-39, HD derivation, shielded keys)
├── Full wallet operations (balance, transfer, airdrop, dust, shielded)
├── DApp Connector (mn serve — WebSocket JSON-RPC, ConnectedAPI)
├── MCP Server (24 tools, structured JSON, AI-friendly)
├── Wallet Connector npm package (browser DApps connect to mn serve)
└── midnight-starship (reference game proving the full stack)

kuira-android-wallet (consumer + agent)
├── Native Android, Rust FFI for crypto
├── Unshielded transactions working
├── Dust management working
├── Shielded + DApp connector planned (Phases 3-7)
└── Agent runtime + Game SDK planned (Phases 8-10)

The gap: no policy engine, no agent identity, no confirmation tokens, no intent system
```

## What's Missing (From OWS + Giza)

### 1. Agent Identity & Scoped Access

OWS pattern: agents get API keys with policies. Not full wallet access — scoped tokens.

Applied to Midnight:
- An AI agent registers with `mn serve` and gets a session token
- The token has policies: allowed methods, spending limits, network restrictions, TTL
- Read operations auto-approved. Write operations check policies.
- If within policy → auto-execute. If exceeding → prompt operator for approval.

This replaces the current binary: `--approve-all` (everything) or interactive (approve each one).

### 2. Confirmation Tokens for Destructive MCP Ops

Giza pattern: destructive tools return a pending operation + description. The AI must show it to the user, get consent, then call `confirm_operation` with the token.

Applied to our MCP server:
- `midnight_transfer` returns `{ pending: true, token: "uuid", description: "Send 100 NIGHT to alice", expiresAt: "..." }`
- AI shows this to user, gets "yes"
- AI calls `midnight_confirm_operation({ token: "uuid" })`
- Actual transfer executes

This is safer than the current MCP which auto-executes everything.

### 3. Tool Annotations

MCP standard feature — annotate each tool:
```json
{
  "readOnlyHint": true,    // safe to call without confirmation
  "destructiveHint": true, // changes state, needs confirmation
  "openWorldHint": true    // makes network requests
}
```

We have 24 MCP tools. Some are reads (balance, info, list), some are writes (transfer, airdrop, dust register). Annotating them helps AI clients make safety decisions automatically.

### 4. Skills Plugin (Claude Code / Cursor)

Giza ships a SKILL.md that teaches AI assistants how to use the tools conversationally:
- Intent routing: "send tokens" → `midnight_transfer`
- Multi-step flows: onboarding → generate wallet → set network → airdrop → dust → ready
- Error recovery: "dust insufficient" → suggest `midnight dust register`
- Education: what is dust? what is shielded? why ZK?

We have `/midnight-sdk` skill but it's a reference, not a conversational guide. A proper `midnight-wallet` skill would make any AI assistant a Midnight power user.

### 5. Intent System (Future — Aligns with Charles's CAKE)

The CLI builds transactions explicitly. The intent model is:
- User says: "I want to send 100 NIGHT privately to alice"
- Intent: `{ action: "transfer", amount: 100, recipient: "alice", privacy: "shielded" }`
- Solver (CLI or AI agent) figures out: need dust → check balance → pick shielded path → build tx → prove → submit

This is what `executeTransfer` already does — but it's hardcoded. An intent system would make it declarative and composable.

## The Product Idea

### "The Agent Wallet Standard for Privacy Chains"

Not just a wallet — a **platform for AI agents to interact with privacy-preserving blockchains**.

Three layers (like Giza, but privacy-native):

**Layer 1 — Wallet SDK (npm package)**
- Key management, transaction building, shielded operations
- Midnight-specific: dust, ZK proofs, selective disclosure
- Can be embedded in any Node.js/browser/Android app

**Layer 2 — Agent Protocol (MCP + WebSocket)**
- Policy-gated access (OWS pattern)
- Confirmation tokens for writes (Giza pattern)
- Tool annotations (MCP standard)
- Works with Claude, Cursor, any MCP client, custom agents

**Layer 3 — Skills & Intent Layer**
- Conversational AI workflows (Giza skill pattern)
- Intent declaration and solving
- Multi-step operation orchestration
- Natural language → on-chain operations

**What makes it different from OWS/Giza:**
- **Privacy-native** — shielded transactions, ZK proofs, selective disclosure are first-class
- **ZK as agent language** — Charles's insight: "the language of agents is proofs"
- **Not custodial** — keys stay local (OWS pattern), unlike Giza's server-side execution
- **Midnight's dual token model** — provider-pay (DUST delegation) enables free-to-use agent interactions

### Where Each Product Fits

```
Midnight Agent Wallet Standard
│
├── midnight-wallet-cli ← Developer reference implementation
│   ├── Proves the protocol works
│   ├── MCP server for AI agents
│   ├── DApp connector for browser apps
│   └── Testing ground for agent patterns
│
├── kuira-android-wallet ← Consumer + agent implementation
│   ├── TEE key storage (phone hardware)
│   ├── Biometric approval (replaces terminal prompts)
│   ├── Background agent service
│   └── Game SDK overlay
│
├── midnight-wallet-connector ← Transport layer
│   ├── WebSocket JSON-RPC (CLI ↔ browser)
│   ├── Android bound service (Kuira ↔ apps)
│   └── Same ConnectedAPI everywhere
│
└── Agent Protocol Spec ← The standard
    ├── Policy engine (scoped agent access)
    ├── Confirmation token flow
    ├── Tool annotations
    ├── Intent declaration format
    └── Privacy-preserving agent identity
```

## Open Questions

1. **Should the agent protocol be its own repo/spec?** Or embedded in the CLI?
2. **Does OWS's Rust core make sense to adopt?** Or build our own in TypeScript since the CLI is TS?
3. **Should we propose this to the Midnight team?** (Q6 from Kuira Vision — "introduce Kuira + ask for alignment")
4. **Is there a grant/builders program** to fund this? (Q10 from Kuira Vision)
5. **How does this relate to x402?** The payment protocol for agents hitting 402-gated resources
6. **Should the agent standard be Midnight-specific or chain-agnostic?** OWS is multi-chain. We could be too, with Midnight as the privacy layer.

## Reference Paths

| Artifact | Path |
|----------|------|
| CLI wallet | `/Users/norman/Development/tech-moderator/midnight-wallet-cli` |
| CLI hub (public) | `/Users/norman/Development/tech-moderator/midnight-wallet-cli/hub` |
| Wallet connector | `/Users/norman/Development/tech-moderator/midnight-wallet-cli/packages/connector` |
| Midnight Starship | `/Users/norman/Development/tech-moderator/midnight-starship` |
| Kuira Android wallet | `/Users/norman/Development/android/projects/kuira-android-wallet` |
| Kuira vision doc | `/Users/norman/Development/android/projects/kuira-android-wallet/docs/planning/KUIRA_VISION_V1.md` |
| Kuira Lace compat | `/Users/norman/Development/android/projects/kuira-android-wallet/docs/LACE_COMPATIBILITY.md` |
| Kuira shielded reference | `/Users/norman/Development/android/projects/kuira-android-wallet/docs/learning/SHIELDED_SDK_CODE_REFERENCE.md` |
| Kuira shielded deep dive | `/Users/norman/Development/android/projects/kuira-android-wallet/docs/learning/SHIELDED_BALANCE_DEEP_DIVE.md` |
| Midnight SDK libraries | `/Users/norman/Development/midnight/midnight-libraries` |
| Midnight wallet SDK | `/Users/norman/Development/midnight/midnight-libraries/midnight-wallet` |
| Midnight ledger | `/Users/norman/Development/midnight/midnight-libraries/midnight-ledger` |
| Tech moderator reports | `/Users/norman/Development/tech-moderator/reports` |
| Presentation script | `/Users/norman/Development/tech-moderator/midnight-wallet-cli/private/presentation-script.md` |
| Awesome dapps (PR) | `/Users/norman/Development/tech-moderator/midnight-awesome-dapps` |
| Comp tracker dashboard | `https://midnight-comp-tracker.vercel.app` |

### External References

| Project | URL |
|---------|-----|
| OWS (Open Wallet Standard) | `https://github.com/open-wallet-standard/core` |
| Giza Hub | `https://github.com/gizatechxyz/giza-hub` |
| CLI on npm | `https://www.npmjs.com/package/midnight-wallet-cli` |
| Connector on npm | `https://www.npmjs.com/package/midnight-wallet-connector` |
| CLI hub on GitHub | `https://github.com/nel349/midnight-wallet-cli-hub` |
| Starship on GitHub | `https://github.com/nel349/midnight-starship` |

## Next Steps (If This Feels Right)

1. ✅ Add tool annotations to the existing MCP server — shipped `dde2fa3`
2. ✅ Build a proper `midnight-wallet` MCP skill (conversational guide) — shipped `c51a9b3` (as an MCP Resource so it works with any MCP client, not Claude-Code-exclusive)
3. ✅ Prototype confirmation token flow for `midnight_transfer` MCP tool — shipped `b00c717`
4. ✅ Write the Agent Protocol Spec as a standalone document — shipped as `docs/AGENT-PROTOCOL.md` v0
5. Present to Midnight team (Nightforce, Charles) — still open
6. Decide if this becomes its own project or stays part of CLI + Kuira — still open

See `docs/tasks/cli-dev-ux-plan.md` for the full shipped/deferred matrix.
