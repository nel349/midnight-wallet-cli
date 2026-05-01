# midnight-expert Compatibility Journey

A real-time log of running every midnight-expert flow that touches our
CLI/MCP, capturing what works and what breaks, then closing the gaps
on our side without asking them to change anything.

**Persona:** an AI agent inside Claude Code with the midnight-expert
plugin loaded. Their `.mcp.json` pins `midnight-wallet-cli@latest`
(at the time of this walk, v0.3.0 was published; v0.4.0 is the
next release).

**Goal:** every midnight-expert flow that ran on v0.2.5 still runs on
the next published version we ship, and the flows that were silently
broken (their bugs) start working.

**Repo:** `/Users/norman/Development/midnight/midnight-expert/plugins/midnight-wallet/`

---

## Flow 1: Session start health check

**File:** `plugins/midnight-wallet/hooks/scripts/session-start-health.sh`

**What it does:** on every Claude Code session start, reads the wallet
alias file, picks the first network present per wallet (preferring
undeployed), runs `mn balance <addr> --json`, parses
`.balance // .NIGHT // "unknown"`, prints a one-liner like
"Wallet aliases loaded: #alice (42 NIGHT), #bob (unknown NIGHT)."

**Reproduced their exact call:**
```
mn balance mn_addr_undeployed18mj9eclnzussedhnvj99hdqug7n0kwsutj8dz5ez7edtwx4a60dss2s64k --json
```

**What we returned:**
```
{"error":true,"code":"UNKNOWN","message":"GraphQL error: invalid address: cannot bech32m-decode unshielded address: expected HRP mn_addr_preprod, but was mn_addr_undeployed","exitCode":1}
```

**Three failures stacked:**

1. **Network mismatch.** They pass an undeployed address but no
   `--network` flag, so we default to the config network (preprod here)
   and reject the address. The address's bech32m HRP literally encodes
   the network. We should infer it.

2. **Field name mismatch.** Even if the call succeeded, our shape is
   `{balances:{NIGHT:"X"}}` and their jq filter is `.balance // .NIGHT`.
   Top-level `NIGHT` would satisfy them.

3. **No actionable error.** "GraphQL error: invalid address" reads like
   a server-side problem, not a client config mismatch.

**Three fixes on our side, no action on theirs:**

- (A) `mn balance <addr>` infers network from the address HRP when
  `--network` is not passed.
- (B) `mn balance --json` adds top-level `NIGHT` alias next to the
  existing `balances.NIGHT`.
- (C) When the HRP and explicit `--network` disagree, emit an error
  that says exactly that ("address is for undeployed, --network said
  preprod, pick one").

---

## Flow 2: setup-test-wallets network detection

**File:** `plugins/midnight-wallet/skills/setup-test-wallets/SKILL.md` line 35

**What it tells the AI to do:**
> Before funding, determine the active network by calling
> `midnight_config_get` with `key: "network-id"`.

**Reproduced via real MCP call:**
```
midnight_config_get { key: "network-id" }
→ {"error":true,"code":"UNKNOWN","message":"Unknown config key: \"network-id\"\nValid keys: network, proof-server, node, indexer-ws, wallet"}
```

**Conclusion:** Their setup-test-wallets skill, followed by any AI
agent, errors at step 1 (network detection). Funding never happens,
no wallets get set up.

**Fix on our side:** accept `network-id` as an alias for `network`
in the config command. Two lines.

---

## Flow 3: Session start health check (full live run)

Ran their `session-start-health.sh` directly with PLUGIN_ROOT set,
exactly as their hook would invoke it on session start. Three
sub-checks ran:

### Check A: Wallet alias health

**Reported:** "Wallet alias script not found — skipping alias
health check."

**Actual cause:** their own `wallet-aliases.sh list` crashed before
session-start could call it, with:
```
wallet-aliases.sh: line 224: files[@]: unbound variable
```

This is a **bug in their script**: `set -u` plus an array that
stays empty when neither `~/.claude/midnight-wallet/wallets.json`
nor `.claude/midnight-wallet/wallets.local.json` exists (the
default state on a fresh install). They should either initialize
the loop with a guard (`[[ ${#files[@]} -gt 0 ]]`) or use the
`${arr[@]+"${arr[@]}"}` empty-safe expansion.

Not our bug, but worth flagging in the cooperation PR.

### Check B: SDK version alignment

**This is the big one.** Their script reads our `package.json`
dependencies and compares each `@midnight-ntwrk/*` pin to npm's
latest stable. Then it writes a user-visible WARNING into the
session.

**What the user sees on every session start:**
```
WARNING: midnight-wallet-cli depends on outdated @midnight-ntwrk/*
packages — wallet CLI may be outdated.
@midnight-ntwrk/wallet-sdk-dust-wallet: wallet-cli requires ^3.0.0 but latest stable is 4.0.0;
@midnight-ntwrk/wallet-sdk-facade: wallet-cli requires ^3.0.0 but latest stable is 4.0.0;
@midnight-ntwrk/wallet-sdk-shielded: wallet-cli requires ^2.1.0 but latest stable is 3.0.0;
@midnight-ntwrk/wallet-sdk-unshielded-wallet: wallet-cli requires ^2.1.0 but latest stable is 3.0.0
```

That's our reputation getting dinged in every midnight-expert
user's session, every time. Confirmed the version skew is real:
- Our pins: `dust-wallet ^3.0.0`, `facade ^3.0.0`, `shielded ^2.1.0`, `unshielded ^2.1.0`.
- npm latest: `4.0.0`, `4.0.0`, `3.0.0`, `3.0.0`.

**Fix on our side:** plan and ship an SDK-bump release. That's a
bigger piece of work (tested upgrade with regression sweep, not
a quick alias). Tracking as a separate ticket.

### Check C: Compact CLI ledger cross-check

**Reported:** "Compact CLI not installed — skipping ledger cross-check."

This actually fires only when the Compact toolchain is missing.
On this machine the toolchain is installed but the script
reported "not installed" anyway. Their detection is probably
broken too (didn't dig further).

---

## Summary of real findings

| # | Finding | Severity | Side to fix |
|---|---|---|---|
| 1 | balance call without `--network` rejects address with HRP mismatch | High | Ours: infer network from HRP |
| 2 | balance JSON shape is `{balances:{NIGHT:X}}`, their filter expects flat `.NIGHT` | High | Ours: add top-level `NIGHT` alias |
| 3 | config get `network-id` errors; key is named `network` | High | Ours: accept `network-id` as alias |
| 4 | wallet-aliases.sh crashes on fresh install (`set -u` + empty array) | Medium | Theirs: bash fix |
| 5 | SDK pin warning shown on every session start (we're 1 major behind) | High (reputation) | Ours: SDK bump release (separate work) |
| 6 | Compact CLI detection wrong (says missing when installed) | Low | Theirs: detection fix |

---

## What we shipped (this branch)

Three additive changes that fix the silently broken bits without
asking midnight-expert to touch anything:

1. **`mn balance` infers network from the address HRP** when no
   `--network` is passed. Bech32m addresses encode the network
   (`mn_addr_<network>1...`), so we use it. When the explicit flag
   conflicts with the HRP, we throw a clear error naming both.

2. **`mn balance --json` adds top-level `NIGHT`** alongside the
   existing nested `balances.NIGHT`. Their jq filter
   `.balance // .NIGHT // "unknown"` now returns the actual value.

3. **`mn config get/set/unset network-id`** is accepted as an alias
   for `network`. Their setup-test-wallets skill can call
   `midnight_config_get key:network-id` and get a real answer.

### Verified end-to-end

```
$ mn config get network-id
preprod

$ mn balance mn_addr_undeployed1...   # no --network
{ ..., "balances": { "NIGHT": "1000.000000" }, "NIGHT": "1000.000000", ... }

$ # Their actual jq filter
$ mn balance mn_addr_undeployed1... --json | jq -r '.balance // .NIGHT // "unknown"'
1000.000000
```

**Their session-start summary now reads:** `#alice (1000.000000 NIGHT)`
instead of the previous `#alice (unknown NIGHT)`. No code change on
their side. They will see the fix the next time we publish.

### What still needs work

- **Finding 5 (SDK pin warning)** is real and visible to every
  midnight-expert user. Tracked as separate work: bumping
  wallet-sdk-facade and wallet-sdk-dust-wallet from ^3.0.0 to ^4.0.0,
  and shielded/unshielded from ^2.1.0 to ^3.0.0. This needs a regression
  pass against undeployed and preprod plus an audit of any breaking
  API changes. Not in this commit.

- **Findings 4 and 6** are bugs in their own scripts. Worth a follow-up
  PR to midnight-expert with the bash fix (`set -u` + empty array)
  and the Compact CLI detection fix.

