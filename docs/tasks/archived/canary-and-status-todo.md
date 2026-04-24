# Canary Suite + `mn status` + `mn doctor` — TODO

Full plan: `tasks/status-and-doctor-plan.md`

---

## Step 1: Canary Tier 1+2 — Infrastructure Probes ✅

- [x] Set up canary script in dashboard repo (`dashboard/canary/run.ts`)
- [x] Probe 1.1: Indexer HTTP — POST GraphQL query, check for `data` field
- [x] Probe 1.2: RPC node — HTTP POST `system_health` JSON-RPC call
- [x] Probe 1.3: Faucet — GET, check HTTP 200 (liveness only)
- [x] Probe 1.4: Explorer — GET, check 200 + non-empty body
- [x] Probe 2.1: Chain liveness — `{ block { height } }`, compare to previous run
- [x] Probe 2.2: Dust generation — `dustGenerationStatus` (env-var driven, graceful when not configured)
- [x] Generate `public/status.json` from probe results
- [x] Persist `canary-state.json` locally (block heights, timestamps)
- [x] Multi-network support (preprod + preview, mainnet placeholder)
- [x] Run networks in parallel (`Promise.all`)
- [x] Auto-purge `canary-history/` files older than 30 days
- [x] Add Vercel rewrites for `/api/status`, `/api/compatibility`, `/api/issues`
- [x] Set up GitHub Actions hourly cron (`.github/workflows/canary.yml`)
- [x] HTTP 403 WAF handling (reports DEGRADED instead of DOWN)
- [x] Typecheck script (`npm run typecheck`) covering both `src/` and `canary/`

## Step 2: `mn status` command ✅

- [x] Add `status` to CLI dispatcher (`wallet.ts`)
- [x] Fetch `status.json` from dashboard URL (`DASHBOARD_BASE_URL` constant)
- [x] Fetch `issues.json` from dashboard URL
- [x] Local Tier 1 probes (indexer, RPC, faucet, explorer) — real-time from user's network
- [x] Canary data overlay — shows hourly monitoring alongside live probes
- [x] Render infrastructure health table (UP/DOWN/DEGRADED with latency + last-checked)
- [x] Render known issues filtered by network
- [x] Render SDK versions (stable + experimental)
- [x] Render dashboard link
- [x] `--network` flag (default: wallet's network or `preprod`)
- [x] `--all` flag (all networks side by side)
- [x] `--json` flag
- [x] `--watch` flag (re-fetch + re-probe every 30s)
- [x] Handle missing services gracefully (canary-only services show age, unconfigured show `—`)
- [x] Exit codes: 0 (all UP), 1 (DEGRADED), 2 (DOWN), 3 (dashboard unreachable)
- [x] Add to help command
- [x] Add to COMMAND_BRIEFS in art.ts
- [x] Proper response types (IndexerBlockResponse, SystemHealthResponse)
- [x] Tests (12 tests — health table, issues, SDK versions, --all, --json, exit codes, probe failures, defaults)
- [x] Add to MCP server (`midnight_status` tool with network/all params)

## Step 3: Canary Wallet Setup

- [ ] Generate master wallet per testnet (preprod, preview)
- [ ] Generate canary wallet per testnet
- [ ] Fund master wallets via web faucet (manual, large amount)
- [ ] Transfer initial tNIGHT from master → canary
- [ ] Register canary wallets for dust generation
- [ ] Register master wallets for dust generation
- [ ] Store seeds in `.env` (not committed)
- [ ] Derive master wallet stake addresses for Tier 2 dust probes

## Step 4: Canary Tier 3 — Wallet Probes

- [ ] Auto top-up: check canary balance, transfer from master if below threshold
- [ ] Alert if master balance is low (set `funding` status to DEGRADED)
- [ ] Probe 3.1: Wallet sync — `mn balance --json --wallet {canary} --network {net}`
- [ ] Probe 3.2: Dust status — `mn dust status --json --wallet {canary} --network {net}`
- [ ] Probe 3.3: Transfer — `mn transfer --wallet {canary} --to {self} --amount 0.1 --json`
- [ ] Probe 3.4: Faucet functional test (TBD: Playwright vs direct API — investigate once faucet is back up)
- [ ] Mainnet: read-only only (3.1 + 3.2)
- [ ] Update cron: run Tier 3 every 4 hours

## Step 5: `mn doctor` command

- [ ] Add `doctor` to CLI dispatcher (`wallet.ts`)
- [ ] Fetch `compatibility.json` from dashboard URL
- [ ] Check 1: Package version compatibility (scan `package.json` for `@midnight-ntwrk/*`)
- [ ] Check 2: SDK channel alignment (stable vs experimental mixing)
- [ ] Check 3: Proof server availability (configured URL, Docker memory, WSL2 detection)
- [ ] Check 4: Localnet health (Docker containers, local indexer, local RPC)
- [ ] Check 5: Remote network reachability (preprod/preview/mainnet endpoints, WAF/VPN detection)
- [ ] Check 6: Compact compiler (version, compatibility with deps)
- [ ] Check 7: Node.js version (>= 20)
- [ ] Output format: ✓/✗/!/— symbols
- [ ] `--path` flag
- [ ] `--json` flag
- [ ] `--fix` flag
- [ ] Exit codes: 0 (all pass), 1 (warnings), 2 (failures)
- [ ] Add to help command
- [ ] Tests

## Step 6: Canary Tier 4 — DApp Flow Probes

- [ ] Pre-compile test contract artifacts (counter or similar)
- [ ] Build test client script (WebSocket JSON-RPC to `mn serve`)
- [ ] Probe 4.1: Contract deploy — fresh deploy through DApp connector
- [ ] Probe 4.2: Contract interact — call circuit on freshly deployed contract
- [ ] Orchestration: start `mn serve` background → test client → kill server
- [ ] Requires local proof server (Docker)
- [ ] Preprod + preview only (no mainnet)
- [ ] Update cron: run Tier 4 every 6 hours

## Step 7: Wire Up

- [ ] Add `status` and `doctor` to help command output
- [ ] Add `status` and `doctor` to MCP server tools
- [ ] Update `art.ts` if needed (command count in animation)
- [ ] Update README

---

## Open Questions

- [ ] Faucet functional test: Playwright vs direct API? (investigate once faucet is back up)
- [ ] Verify tNIGHT cost estimates for contract deploy/interact during implementation
- [ ] Dashboard UI: how to display canary-updated infrastructure data (currently build-time import)
- [ ] Exit code reconciliation with existing `exit-codes.ts` (codes 0-7 already defined)
