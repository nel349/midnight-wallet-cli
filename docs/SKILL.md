# midnight-wallet-cli — Agent Skill

You have access to the `midnight-wallet-cli` MCP server. This document teaches you how to use it well. Read it once at the start of a session; use it as reference throughout.

## What you can do with this CLI

Manage wallets, check balances, transfer NIGHT tokens, register dust (fee token), run a local Midnight network, and deploy/call/inspect Compact smart contracts — all on behalf of the user. Every CLI command is also an MCP tool.

## Core concepts (teach these accurately)

- **Midnight** — a privacy-first blockchain. Supports both **unshielded** (transparent, like Bitcoin) and **shielded** (ZK-private, like Zcash) transactions in one chain.
- **NIGHT** — the native token. 1 NIGHT = 1,000,000 micro-NIGHT (6 decimals).
- **DUST** — a second token used to pay transaction fees. Not transferable. **Generated passively** by registered NIGHT UTXOs. Every wallet holding NIGHT must register those UTXOs for dust generation before it can send anything. Don't explain dust as "gas" — it's time-phase regenerative, not a fee market.
- **Shielded vs unshielded** — shielded addresses start `mn_shield-addr_*`; unshielded start `mn_addr_*`. A wallet has one of each per network. Sender controls the privacy: `mn transfer --shielded` sends privately.
- **No self-shielding** — a wallet cannot move its own funds from unshielded to shielded. To get shielded NIGHT, receive a shielded transfer from a wallet that already has some (genesis wallet has 250M shielded NIGHT on localnet).
- **Networks**
  - `undeployed` — local Docker network via `mn localnet up`. Use this for dev iteration.
  - `preprod` — public testnet. First-time wallet sync processes the full event history and can take significantly longer than subsequent syncs (which restore from cached wallet state). Exact time depends on wallet age, event density, network, and hardware.
  - `preview` — public preview testnet. Same first-sync trade-off as preprod.
- **Proof server** — local HTTP service that generates ZK proofs for transactions. Default port 6300. Version must match the network's ledger version or writes fail with "Custom error 170".

## Intent routing (natural language → tool)

| User says | Call this tool |
|---|---|
| "Create a new wallet called alice" | `midnight_wallet_generate({ name: "alice" })` |
| "Show my wallets" / "list wallets" | `midnight_wallet_list()` |
| "Switch to bob" / "use wallet bob" | `midnight_wallet_use({ name: "bob" })` |
| "What's my balance?" | `midnight_balance()` |
| "Balance for this address 0x…" | `midnight_balance({ address: "mn_addr_..." })` |
| "Send 100 NIGHT to alice" | `midnight_transfer({ to: "alice", amount: "100" })` — ask consent first |
| "Send shielded" | add `--shielded` (the CLI command) or use shielded address directly |
| "Fund my wallet" (localnet only) | `midnight_airdrop({ amount: "1000" })` |
| "Register dust" / "I need fees" | `midnight_dust_register()` |
| "Am I registered for dust?" | `midnight_dust_status()` |
| "Start localnet" / "start a local network" | `midnight_localnet_up()` |
| "Stop localnet" | `midnight_localnet_stop()` |

## Canonical flows

### New user, first session (localnet)
1. `midnight_localnet_up()` — spin up Docker network.
2. `midnight_wallet_generate({ name: "alice" })` — create wallet, set active.
3. `midnight_airdrop({ amount: "1000" })` — fund from genesis.
4. `midnight_dust_register()` — make wallet able to pay fees.
5. `midnight_balance()` — confirm funds visible.

At step 5 the user is ready to transact.

### User wants to send tokens (safely — two-step confirmation flow)

`midnight_transfer` does **not** execute on the first call. It returns a pending token that you must redeem via `midnight_confirm_operation` after the user confirms.

1. Call `midnight_transfer({ to, amount })` — returns `{ pending: true, token, description, expiresAt }`.
2. Show `description` (e.g. "Send 100 NIGHT from alice to mn_addr_preprod1… on preprod") to the user verbatim. Do not paraphrase amounts or recipients.
3. Wait for the user's explicit consent.
4. If yes: call `midnight_confirm_operation({ token })` — this actually executes the transfer and returns the result (tx hash, etc).
5. If no: do nothing; the token expires in 5 minutes.
6. On success: surface the tx hash. On failure: read the error and suggest recovery (see below).

**Never skip step 2–3.** The whole point of the token flow is that the user sees the exact operation before funds move.

### User wants to deploy a contract
Use `mn contract` commands (not MCP tools yet). Flow: `compact compile` in the project → `mn contract inspect` to verify artifacts → `mn contract deploy --network <n>` → returns address → `mn contract call --address <addr> --circuit <name> --args '<json>'` to exercise it.

## Safety rules (non-negotiable)

- **Read tools** (`readOnlyHint: true`) — safe to call without user consent. Examples: balance, info, list, status, address derivation.
- **Destructive tools** (`destructiveHint: true`) — require explicit user consent before calling. Examples: transfer, airdrop, dust register, wallet generate, wallet remove, cache clear, localnet down.
- **Open-world tools** (`openWorldHint: true`) — touch the network/chain/Docker. Can fail non-deterministically; retry is usually safe for reads, risky for writes.
- **Never** auto-execute a fund-moving operation. Always describe amount + recipient + network first.
- **Never** invent a mnemonic, seed, or private key. If the user needs one, call `midnight_wallet_generate`.

## Error recovery recipes

| Symptom | Recipe |
|---|---|
| "InsufficientFunds" or "could not balance dust" | Run `midnight_dust_register()` then retry once dust has accumulated (dust regenerates passively over time — exact wait depends on network parameters; check `midnight_dust_status()` until balance is non-zero). |
| "Custom error 170" / "InvalidDustSpendProof" | Stale commitment tree (laptop slept between sync and submit). Run `midnight_cache_clear({ wallet: "<name>" })` then retry. |
| "Wallet sync timed out" | On preprod/preview this can happen on Day 0. Retry with `mn balance` — caches progressively. Avoid `--no-cache` on hosted networks. |
| "Unknown network" / invalid network name | Networks are `undeployed`, `preprod`, `preview`. Check `midnight_config_get({ key: "network" })`. |
| "Wallet not found" | Check `midnight_wallet_list()` — user may have removed it. |
| Write command hangs on preprod | Cache may be stale from a previous chain reset. `midnight_cache_clear({ wallet: "<name>" })` then retry once. |

## When to use which network

- **Developing a contract?** → `undeployed` (localnet). No first-sync cost; everything is local.
- **Integration testing against a hosted chain?** → `preprod`. First sync for a new wallet on this network processes full event history; subsequent syncs restore from cache and are much faster.
- **Demoing to users?** → `preview` (if the dApp is deployed there) or `undeployed` (if self-contained).
- **Mainnet?** → not on this CLI yet. Don't claim it is.

## What this CLI is NOT

- Not a custody service. Keys are on the user's disk (`~/.midnight/wallets/<name>.json`).
- Not a fast-sync solution for a first-time wallet on a hosted network. The wallet SDK must process the chain's event history on first run; the CLI caches state after that so repeat runs are fast.
- Not a contract compiler. The project's `package.json` should expose a `compact` script (Midnight convention, e.g. `"compact": "compact compile src/foo.compact src/managed/foo"`) or a `compile` script as a generic fallback. `mn dev` detects whichever is present; create-mn-app and midnight-starship templates ship with the `compact` script already wired.

## Authoritative references

- `mn help <command>` — per-command usage and flags.
- `mn help --agent` — structured reference manual for AI clients.
- `mn status` — live network health (indexer, node, proof server).
