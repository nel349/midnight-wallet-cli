# Plan: `midnight status` & `midnight doctor`

Two new commands that address the most common developer pain points
from weeks 1-5 of dev-chat reports.

---

## `midnight status` — Is Midnight working right now?

**Scope:** Global. Works from anywhere, no project context needed.

**Goal:** Answer the question developers keep asking in Discord:
"is it me or is preprod down?"

### What it shows

1. **Infrastructure health table**
   - Live-probe RPC, indexer, faucet, explorer, proof server endpoints
   - Show status (UP / DOWN / DEGRADED) with response latency
   - Network-aware: uses wallet's configured network by default

2. **Wallet summary** (if wallet exists)
   - Address, network, balance (lightweight GraphQL check)
   - Dust status (registered or not)

3. **Known issues** (from dashboard `issues.json`)
   - Filter to current network
   - Show ID, summary, affected component
   - Only show open/unresolved issues

4. **SDK versions**
   - Stable and experimental bundle versions from dashboard `compatibility.json`

5. **Dashboard link**
   - Direct URL to the web dashboard, deep-linked to current network

### Flags

- `--network <name>` — override network (default: wallet's network or config default)
- `--all` — show all networks side by side
- `--json` — structured JSON output (consistent with all other commands)
- `--watch` — refresh every 30s, update in-place

### Data sources

- **Live probes:** HTTP/WS requests to known endpoints from `network.ts` config
- **Dashboard data:** Fetch `compatibility.json` and `issues.json` from dashboard URL (or bundled fallback)
- **Local state:** Wallet config, CLI config

### Architecture

- `src/commands/status.ts` — command handler, renders output
- `src/lib/probe.ts` — endpoint health checking (ping with timeout, latency measurement)
- `src/lib/dashboard-data.ts` — fetch and parse dashboard JSON files

---

## `midnight doctor` — Is my project set up correctly?

**Scope:** Project-level. Reads current directory for project context.

**Goal:** Answer "why isn't my project working?" — the question that
costs new developers 1-2 days according to reports.

### What it checks

1. **Package version compatibility**
   - Read `package.json` in current directory
   - Find all `@midnight-ntwrk/*` dependencies
   - Check against known compatibility matrix (from dashboard `compatibility.json`)
   - Flag mismatched versions (e.g., compiler 0.28.0 with language 0.21.0)
   - Warn about abandoned packages (`@midnight-ntwrk/wallet` v5 still on npm as "latest")

2. **SDK channel alignment**
   - Detect if mixing stable and experimental packages
   - Suggest which bundle to align to

3. **Proof server availability**
   - Check if proof server is running (local or remote)
   - Validate Docker container health if using localnet
   - Check Docker memory allocation (warn if < 4GB — the 2GB crash issue)
   - Detect WSL2 and suggest `bricktowers/midnight-proof-server` if official image is problematic

4. **Network reachability**
   - Quick probe of the project's target network endpoints
   - Check for WAF/VPN blocking (the recurring 403 issue)

5. **Compact compiler**
   - Check if `compactc` is available and which version
   - Flag if compiler version mismatches language version in dependencies

6. **Node.js version**
   - Verify Node.js >= 20 (required by SDK)

### Output format

Each check outputs a line:
```
  ✓ Node.js v22.4.0 (>= 20 required)
  ✓ @midnight-ntwrk/compact-compiler 0.28.0
  ✗ @midnight-ntwrk/ledger-v7 7.0.2 ↔ compiler 0.28.0 — mismatch, expected 7.0.0
  ! Docker memory: 2GB allocated — recommend 4GB+ for proof server
  ✓ Proof server: localhost:6300 (UP, 180ms)
  ✗ Faucet: preprod — DOWN (use `midnight airdrop` on undeployed as workaround)
```

Symbols: `✓` pass, `✗` fail, `!` warning, `—` skipped (not applicable)

### Flags

- `--path <dir>` — check a specific project directory (default: cwd)
- `--json` — structured JSON output
- `--fix` — auto-fix what it can (update package.json versions, suggest commands)

### Architecture

- `src/commands/doctor.ts` — command handler, runs checks, renders output
- `src/lib/compat.ts` — version compatibility logic, matrix lookup
- `src/lib/probe.ts` — shared with `status` (endpoint health checks)
- `src/lib/doctor-checks.ts` — individual check functions (node version, docker, compiler, etc.)

---

## Shared infrastructure

Both commands share:
- `src/lib/probe.ts` — HTTP/WS endpoint probing with timeout + latency
- `src/lib/dashboard-data.ts` — fetch dashboard compatibility + issues data
- `--json` output pattern (already established across all commands)
- Network resolution logic (already in `src/lib/resolve-network.ts`)

---

## Implementation order

1. `probe.ts` + `dashboard-data.ts` (shared libs)
2. `midnight status` (higher daily usage, simpler)
3. `midnight doctor` (builds on probe, adds project-level checks)
4. Wire both into CLI dispatcher, help, MCP tools

---

## Pain points addressed

| Report pain point | Solved by |
|---|---|
| "Is preprod down?" — no status page | `status` live probes + dashboard link |
| Faucet broken, devs don't know | `status` shows faucet health + workaround tip |
| Version compatibility chaos | `doctor` scans package.json, flags mismatches |
| Proof server Docker crashes (2GB) | `doctor` checks Docker memory |
| WSL2 proof server broken | `doctor` detects WSL2, suggests workaround |
| AWS WAF blocks VPN users | `status`/`doctor` detect 403 on endpoints |
| Abandoned packages on npm | `doctor` warns about wallet v5 |
| No version compatibility matrix | `doctor` uses dashboard data as source of truth |
| Devs ask each other in Discord | `status` gives self-service answers |
