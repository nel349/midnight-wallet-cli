# Canary Suite + `mn status` + `mn doctor` — TODO

Full plan: `tasks/status-and-doctor-plan.md`

---

## Step 1: Canary Tier 1+2 — Infrastructure Probes

- [ ] Set up canary script in dashboard repo
- [ ] Probe 1.1: Indexer HTTP — POST GraphQL query, check for `data` field
- [ ] Probe 1.2: RPC node — HTTP POST `system_health` JSON-RPC call
- [ ] Probe 1.3: Faucet — GET, check HTTP 200 (liveness only)
- [ ] Probe 1.4: Explorer — GET, check 200 + non-empty body
- [ ] Probe 2.1: Chain liveness — `{ block { height } }`, compare to previous run
- [ ] Probe 2.2: Dust generation — `dustGenerationStatus` for master wallet stake addresses
- [ ] Generate `public/status.json` from probe results
- [ ] Persist `canary-state.json` locally (block heights, timestamps)
- [ ] Multi-network support (preprod, preview, mainnet when ready)
- [ ] Run networks in parallel
- [ ] Auto-purge `canary-history/` files older than 30 days
- [ ] Add Vercel rewrites for `/api/status`, `/api/compatibility`, `/api/issues`
- [ ] Set up Claude Code hourly cron

## Step 2: `mn status` command

- [ ] Add `status` to CLI dispatcher (`wallet.ts`)
- [ ] Fetch `status.json` from dashboard URL (hardcoded constant)
- [ ] Fetch `issues.json` from dashboard URL
- [ ] Render infrastructure health table (UP/DOWN/DEGRADED with latency + last-checked)
- [ ] Render known issues filtered by network
- [ ] Render SDK versions (stable + experimental)
- [ ] Render dashboard link
- [ ] `--network` flag (default: wallet's network or `preprod`)
- [ ] `--all` flag (all networks side by side)
- [ ] `--json` flag
- [ ] `--watch` flag (re-fetch every 30s + live latency probes)
- [ ] Handle missing services gracefully ("not yet checked")
- [ ] Exit codes: 0 (all UP), 1 (DEGRADED), 2 (DOWN), 3 (dashboard unreachable)
- [ ] Add to help command
- [ ] Tests

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
