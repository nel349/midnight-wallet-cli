# Plan: `midnight status` & `midnight doctor`

Two new commands that address the most common developer pain points
from weeks 1-5 of dev-chat reports, powered by automated canary monitoring.

---

## `midnight status` — Is Midnight working right now?

**Scope:** Global. Works from anywhere, no project context needed.

**Goal:** Answer the question developers keep asking in Discord:
"is it me or is preprod down?"

### What it shows

1. **Infrastructure health table** (from dashboard `status.json`)
   - Per-service status (UP / DOWN / DEGRADED) with latency and last-checked time
   - Services: indexer, RPC, faucet, explorer, dust generation, chain liveness
   - Higher-tier data when available: wallet ops health, DApp flow health
   - Network-aware: uses wallet's configured network by default

2. **Known issues** (from dashboard `issues.json`)
   - Filter to current network
   - Show ID, summary, affected component
   - Only show open/unresolved issues

3. **SDK versions** (from dashboard `status.json`)
   - Stable and experimental bundle versions

4. **Dashboard link**
   - Direct URL to the web dashboard, deep-linked to current network

### Flags

- `--network <name>` — override network (default: wallet's configured network if wallet exists, otherwise `preprod`)
- `--all` — show all networks side by side
- `--json` — structured JSON output (consistent with all other commands)
- `--watch` — refresh every 30s: re-fetches `status.json` + runs quick live latency probes to overlay real-time responsiveness on canary data

### Data sources

- **Dashboard `status.json` (primary):** Single fetch to a hardcoded dashboard URL constant. Contains canary-verified infrastructure health, SDK versions, and last-checked timestamps. This is the source of truth for network health.
- **Dashboard `issues.json`:** Known issues, fetched alongside status.
- **Fallback:** If dashboard is unreachable, error out. Do not show stale or guessed data.

### Exit codes

- `0` — all services UP
- `1` — some services DEGRADED (warning)
- `2` — some services DOWN (error)
- `3` — dashboard unreachable (cannot determine status)

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
   - Check configured proof server URL (from `mn config get proof-server`, defaults to `http://localhost:6300`)
   - Check Docker memory allocation (warn if < 4GB — the 2GB crash issue)
   - Detect WSL2 and suggest `bricktowers/midnight-proof-server` if official image is problematic

4. **Localnet health** (always runs — checks local Docker setup)
   - Check Docker containers running (node, indexer, proof server)
   - Quick GraphQL probe of local indexer
   - Local RPC node connectivity

5. **Remote network reachability** (always runs — checks preprod/preview/mainnet endpoints)
   - Quick probe of remote network endpoints (indexer, RPC, faucet)
   - Check for WAF/VPN blocking (the recurring 403 issue)

6. **Compact compiler**
   - Check if `compactc` is available and which version
   - Flag if compiler version mismatches language version in dependencies

7. **Node.js version**
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

### Data sources

- **Dashboard `compatibility.json`:** SDK version matrix, known compatible bundles. Served as a static file from the dashboard (alongside `status.json`) so the CLI can fetch it at runtime.
- **Local environment:** Docker, Node.js, compactc, proof server, file system
- **Network probes:** Quick HTTP/GraphQL pings to target network endpoints

### Exit codes

- `0` — all checks pass
- `1` — warnings only (non-blocking issues)
- `2` — failures found (blocking issues)

---

## Canary Test Suite — Automated Network Health Monitoring

**Goal:** Detect infrastructure problems (like the preprod dust outage on 2026-03-11) *before* developers hit them. Tiered canary probes run at different frequencies — fast infrastructure checks every hour, deeper wallet and DApp flow checks less often.

"Canary" — like canary in a coal mine. An early warning system. Standard monitoring terminology (canary deploys, canary tests).

### Tiered probe architecture

Different probes have different costs, runtimes, and frequencies. Split into tiers so fast checks run often and expensive checks run less frequently — but everything gets covered.

#### Tier 1 — Infrastructure reachability (every 1 hour, ~10s total)

Pure HTTP pings. No wallet, no keys, no state.

| # | Probe | Method | UP | DOWN | DEGRADED |
|---|-------|--------|------|------|----------|
| 1.1 | Indexer HTTP | POST simple GraphQL query to indexer, check for `data` field | Valid response <5s | No response / error | Response >5s or partial error |
| 1.2 | RPC node | HTTP POST `system_health` JSON-RPC call (Substrate nodes accept HTTP POST — confirmed working on preprod, returns `{peers, isSyncing, shouldHavePeers}`) | Responds + `shouldHavePeers: true` + `peers > 0` | No response / error | Responds but `isSyncing: true` or `peers: 0` |
| 1.3 | Faucet | GET, check HTTP 200 (liveness only — functional test is Tier 3) | 200 | Non-200 or connection failure | 200 but very slow (>10s) |
| 1.4 | Explorer | GET, check 200 + non-empty body | 200 <5s | Non-200 / unreachable | 200 but slow or partial content |

**Note:** Proof server is NOT included in canary — it's always local infrastructure. Checked by `mn doctor` instead.

#### Tier 2 — Chain & service health (every 1 hour, runs with Tier 1, ~15s total)

GraphQL data queries that verify services are *functioning*, not just reachable. No wallet needed — just needs reference data (known stake addresses, previous block height).

| # | Probe | Method | UP | DOWN | DEGRADED |
|---|-------|--------|------|------|----------|
| 2.1 | Chain liveness | `{ block { height } }` via indexer — compare to previous run's height | Height advanced since last check | Height hasn't advanced in 2+ consecutive runs (2 hours) | Height advancing but slowly (>5min gaps) |
| 2.2 | Dust generation | `{ dustGenerationStatus(stakeAddress: "...") }` for known reference addresses | `registered: true`, non-zero `dustGenerated` | `registered: false` or all-zero fields for ALL reference addresses | Some addresses OK, some broken |

**Reference data needed:**
- Previous block height (persisted between runs in local `canary-state.json`)
- Master wallet stake addresses for dust probe — derived from master wallet public key, always registered. Pure GraphQL read, no dust consumed, no write events.

**Proven:** Probe 2.2 caught the 2026-03-11 preprod dust outage — all known addresses returned `registered: false` with zeroed fields.

#### Tier 3 — Wallet operations (every 4 hours, ~60-120s per network)

Uses `mn` CLI commands with `--json`. Runs against a dedicated canary wallet on each network.

| # | Probe | Command | UP | DOWN | DEGRADED |
|---|-------|---------|----|------|----------|
| 3.1 | Wallet sync | `mn balance --json --wallet {canary} --network {net}` | Syncs + returns balance within timeout | Sync fails or times out | Sync succeeds but very slow (>2min) |
| 3.2 | Dust status | `mn dust status --json --wallet {canary} --network {net}` | Shows registered + non-zero dust | Shows 0 dust or unregistered | Registered but dust balance declining toward 0 |
| 3.3 | Transfer (self-send) | `mn transfer --wallet {canary} --to {self} --amount 0.1 --json` | Tx submits + confirms | Tx fails at any stage (build, prove, submit) | Tx submits but slow proof (>3min) |
| 3.4 | Faucet functional | Playwright automation: fill faucet web form, request tokens, verify receipt | Tokens received | Form errors, timeout, or "No dust tokens" | Very slow or partial success |

**Mainnet:** Read-only only (probes 3.1 + 3.2, no transfers, no faucet)

**Faucet probe (3.4):** The web faucet can return HTTP 200 but be broken internally (as seen with "No dust tokens found in the wallet state" on 2026-03-11). Tier 1.3 only checks liveness. This probe does a real Playwright-driven interaction: fills in an address, submits, checks for success/error messages. Catches functional failures that HTTP 200 misses.

**Note:** Playwright adds a heavyweight dependency (~200MB browser binaries). Consider running the faucet probe in a separate process or making it optional (skip if Playwright not installed).

**Faucet double-duty:** When probe 3.4 succeeds, the requested tokens go to the canary wallet — effectively a free top-up. When the faucet works, this keeps the canary funded automatically. The master wallet is backup for when the faucet is down.

**Requirements:**
- Canary wallet per network — funded with tNIGHT + registered for dust
- Master wallet per network — large tNIGHT reserve for topping up canary wallets (see "Wallet funding strategy" below)
- Wallet seeds in `.env` file (not committed)

#### Tier 4 — DApp flow via `mn serve` (every 6 hours, ~5-10min per network)

Full contract deploy + interact cycle through the DApp connector. Tests the complete developer experience end-to-end: `mn serve` runs the wallet server, a test client script connects via WebSocket and drives the flow.

| # | Probe | Method | UP | DOWN | DEGRADED |
|---|-------|--------|----|------|----------|
| 4.1 | Contract deploy | Test client deploys a fresh contract through `mn serve` DApp connector | Deploys + gets contract address | Deploy fails at any stage | Deploys but very slow (>5min) |
| 4.2 | Contract interact | Test client calls a circuit on the freshly deployed contract | Call succeeds + returns result | Call fails | Succeeds but slow proof |

**Fresh deploy every run** — deploy is the most failure-prone part of the developer experience. Every Tier 4 run deploys a new contract and interacts with it. No state tracking between runs. Tests the full flow end-to-end.

**Requirements:**
- Pre-compiled contract artifacts (small test contract, e.g. counter)
- Test client script that connects to `mn serve` via WebSocket JSON-RPC
- Canary wallet (same as Tier 3) — deploy costs tNIGHT + dust
- Local proof server running (Docker) — `mn serve` does ZK proving locally
- **Preprod + preview only** — no Tier 4 on mainnet

**Orchestration:** The canary starts `mn serve --wallet {canary} --network {net}` as a background process, runs the test client against it, then kills the server when done (or on timeout).

### Network matrix

| Network | Tier 1+2 | Tier 3 | Tier 4 | Notes |
|---------|----------|--------|--------|-------|
| **preprod** | Yes | Yes (full) | Yes | Primary developer network |
| **preview** | Yes | Yes (full) | Yes | Secondary network |
| **mainnet** | Yes | Read-only (3.1 + 3.2) | No | Real money — no transfers or deploys |
| **undeployed** | No | No | No | Localhost only — `mn doctor` handles it |

**When mainnet launches:** Add to Tier 1+2 immediately. Add read-only Tier 3 once a canary wallet is funded.

### Wallet funding strategy

**Problem:** Canary wallets need tNIGHT and dust to run Tier 3+4 probes. Self-transfers (3.3) only cost dust (net zero tNIGHT), but Tier 4 deploys cost actual tNIGHT. Dust regenerates automatically when registered, but if dust generation breaks network-wide (like 2026-03-11), dust depletes with no recovery until the network is fixed. Preprod/preview faucets are web UIs (likely with CAPTCHA) — can't be automated.

**Solution: Master wallet as private faucet**

Each testnet gets two wallets:

| Wallet | Purpose | Funding |
|--------|---------|---------|
| **Master** | Large tNIGHT reserve. Tops up canary wallet. Never used for probes. | Manually funded once via web faucet with a large amount (e.g. 1000 tNIGHT). Topped up manually when low. |
| **Canary** | Runs all Tier 3+4 probes. Gets topped up by master. | Receives tNIGHT from master wallet via `mn transfer`. |

**Auto top-up flow (runs before each Tier 3 cycle):**

1. Check canary wallet balance via `mn balance --json --wallet {canary} --network {net}`
2. If below threshold (e.g. 10 tNIGHT) → master sends top-up (e.g. 50 tNIGHT)
3. If master balance is also low → alert (log warning, set `funding` status to DEGRADED in status.json)
4. If top-up transfer fails → alert but continue probes with remaining balance

**Cost estimates (per network):**
- Self-transfer (Tier 3.3): ~0 tNIGHT (sends to self), costs ~0.5 dust per tx = ~3 dust/day
- Faucet test (Tier 3.4): ~0 tNIGHT (receives tokens, Playwright automation)
- Contract deploy (Tier 4.1): ~1-5 tNIGHT per deploy × 4 deploys/day (every 6h) = ~4-20 tNIGHT/day
- Contract interact (Tier 4.2): ~0.5-1 tNIGHT per call × 4/day = ~2-4 tNIGHT/day
- **Total tNIGHT burn: ~6-24 tNIGHT/day per network**
- With 1000 tNIGHT in master: lasts ~40-160 days before manual top-up needed
- These are estimates — actual costs depend on contract size and chain fee parameters. Will be validated during implementation.

**Dust sustainability:**
- Dust regenerates automatically while registered (~10+ dust/day depending on chain activity)
- Tier 3.3 costs ~3 dust/day — sustainable under normal conditions
- If dust generation breaks network-wide: Tier 3.3 and 4.x fail, canary correctly reports dust/wallet as DOWN
- No action needed — the failure IS the signal

**Mainnet:** No master wallet. Canary wallet funded once with a minimal amount for read-only checks (balance + dust status cost zero tNIGHT — they're just sync + read operations).

**Wallet seeds:** All seeds stored in `.env` file per repo (not committed). Format:
```
CANARY_SEED_PREPROD=...
CANARY_SEED_PREVIEW=...
MASTER_SEED_PREPROD=...
MASTER_SEED_PREVIEW=...
```

### Frequency summary

| Tier | Frequency | Runtime (all networks) | Needs wallet? |
|------|-----------|------------------------|---------------|
| 1+2 | Every 1 hour | ~30s | No |
| 3 | Every 4 hours | ~3-5 min (+ Playwright faucet test) | Yes |
| 4 | Every 6 hours | ~10-20 min | Yes |

### Cron orchestration

Claude Code cron runs from Norman's laptop. The canary script persists a state file (`canary-state.json`) that tracks when each tier last ran — so a single hourly cron entry handles all scheduling:

```
Hourly cron fires →
  Always: Tier 1+2 (preprod + preview + mainnet)
  If 4+ hours since last Tier 3: + auto top-up check + Tier 3 (wallet ops)
  If 6+ hours since last Tier 4: + Tier 4 (DApp flow, preprod + preview only)
→ aggregate results into status.json
→ commit + push → Vercel auto-deploys
```

`canary-state.json` persists between runs (local only, `.gitignore`'d):
- Last block height per network (for chain liveness comparison)
- Last Tier 3 run timestamp
- Last Tier 4 run timestamp
- Master/canary wallet balances from last check

### Data storage

Two categories — committed (deployed) vs local-only:

**Committed to git (deployed to Vercel):**
- `public/status.json` — current state, consumed by `mn status` and dashboard UI
- `public/compatibility.json` — SDK version matrix, consumed by `mn doctor`

**Local only (`.gitignore`'d):**
- `canary-state.json` — operational state between runs (block heights, tier timestamps, wallet balances). Only needed by the canary script on Norman's laptop.
- `canary-history/` — date-stamped JSON files for trend analysis and debugging. Retention: 30 days, auto-purged.

**Always commit with freshness timestamp:** Every canary run updates `lastUpdated` in `status.json` and commits + pushes. This proves the canary is alive — the CLI can show "last checked 12 minutes ago" vs detecting a stale/dead canary. Vercel deploys on every push but it's fast (static site, <30s build) and well within plan limits.

### Status endpoint for CLI

The CLI fetches canary data via a clean URL: `GET {dashboard}/api/status`

Under the hood this is a static file (`public/status.json`) served via Vercel rewrite:
```json
// vercel.json
{ "rewrites": [
  { "source": "/api/status", "destination": "/status.json" },
  { "source": "/api/compatibility", "destination": "/compatibility.json" },
  { "source": "/api/issues", "destination": "/issues.json" }
]}
```

The dashboard UI also consumes canary data — it already renders the `infrastructure` section from `compatibility.json` at build time. The canary keeps that data fresh by updating the source file before each build/deploy.

Contract between canary → dashboard → CLI:

```json
{
  "lastUpdated": "2026-03-11T14:00:00Z",
  "sdkVersions": {
    "stable": { "name": "midnight-sdk-1.0-stable", "version": "1.0.0" },
    "experimental": { "name": "midnight-sdk-1.1-experimental", "version": "1.1.0-rc.1" }
  },
  "networks": {
    "preprod": {
      "indexer": { "status": "up", "latencyMs": 120, "lastChecked": "..." },
      "rpc": { "status": "up", "latencyMs": 85, "peers": 10, "lastChecked": "..." },
      "faucet": { "status": "down", "notes": "HTTP 200 but functional test failed", "lastChecked": "..." },
      "explorer": { "status": "degraded", "notes": "...", "lastChecked": "..." },
      "dust": { "status": "down", "notes": "...", "lastChecked": "..." },
      "chain": { "status": "up", "blockHeight": 588871, "lastChecked": "..." },
      "wallet": { "status": "up", "lastChecked": "..." },
      "dapp": { "status": "up", "lastChecked": "..." }
    }
  }
}
```

`mn status` fetches this single file. If unreachable → exit code 3, error message, no guessing.

**Missing services:** On first run (or before Tier 3/4 have executed), `wallet` and `dapp` entries may not exist in `status.json`. The CLI handles this gracefully — shows "not yet checked" for services with no data. Each service entry only appears after its tier has run at least once.

---

## Implementation order

1. **Canary Tier 1+2** — infrastructure probes, status.json generation, cron setup
2. **`mn status`** — fetches status.json, renders health table + issues + SDK versions
3. **Canary wallet setup** — generate master + canary wallets per network, fund via faucet, register dust, store seeds in `.env`
4. **Canary Tier 3** — wallet probes with auto top-up from master wallet
5. **`mn doctor`** — local checks (proof server, Docker, packages, localnet, version compat)
6. **Canary Tier 4** — DApp flow probes, test contract + client script via `mn serve`
7. Wire both commands into CLI dispatcher, help, MCP tools

---

## Pain points addressed

| Report pain point | Solved by |
|---|---|
| "Is preprod down?" — no status page | `status` shows canary-verified health + dashboard link |
| Faucet broken, devs don't know | `status` shows faucet health + workaround tip |
| Dust generation broken silently | Canary Tier 2 detects via `dustGenerationStatus` probe |
| No one knows network is down until devs complain | Canary catches it within 1 hour |
| Dashboard infrastructure data is manually updated | Canary auto-updates hourly |
| Version compatibility chaos | `doctor` scans package.json, flags mismatches |
| Proof server Docker crashes (2GB) | `doctor` checks Docker memory + local proof server |
| WSL2 proof server broken | `doctor` detects WSL2, suggests workaround |
| AWS WAF blocks VPN users | `status`/`doctor` detect 403 on endpoints |
| Abandoned packages on npm | `doctor` warns about wallet v5 |
| No version compatibility matrix | `doctor` uses dashboard compatibility data |
| Devs ask each other in Discord | `status` gives self-service answers |
| Localnet broken but dev doesn't know why | `doctor` checks Docker containers, local ports, memory |
