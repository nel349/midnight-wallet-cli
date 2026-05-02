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
Use `midnight_contract_*` MCP tools (or `mn contract` CLI). Flow: `compact compile` in the project → `midnight_contract_inspect({ path })` to verify artifacts → `midnight_contract_deploy({ path, wallet, network })` → returns address → `midnight_contract_call({ address, circuit, args, ... })` to exercise it. State reads via `midnight_contract_state({ address, ... })`.

**Project layouts handled.** The scan looks for `managed/<name>/compiler/contract-info.json` under: project root, `contract/`, `contract/src/`, `contracts/`, `contracts/src/`, `src/`. If none match, pass `managed: "<full path to managed/<name>/>"` directly.

**Multi-contract projects.** Inspect returns a `siblings: string[]` field listing other contracts under the same `managed/`. Pick one with `name: "<contract>"` on inspect/deploy/call/state.

**Arg encoding for circuits.** The MCP `args` param is a JSON string. The bridge auto-coerces:
- `number` → `BigInt` (any Compact `Uint<N>` arg)
- array of 0–255 ints → `Uint8Array` (any Compact `Bytes<N>` arg, e.g. `[1,2,3,...,32]`)
Pass strings as JSON strings; arrays of larger values stay as arrays. No hex-string detection — `"1234"` stays a string.

**Compatibility caveat — runtime version skew.** Contracts compiled with an older `compactc` may fail at deploy/call with a message like `Version mismatch: compiled code expects <X>, runtime is <Y>`. The CLI bundles one specific `@midnight-ntwrk/compact-runtime` version; if the user's contract was compiled against a different one, recompile the contract with a matching `compactc` rather than asking the user to downgrade `mn`. `midnight_contract_inspect` shows the compiled `runtimeVersion` so you can flag the mismatch before attempting deploy.

**Stale MCP server.** Every MCP response carries `_serverVersion`. If the user upgraded `midnight-wallet-cli` but `_serverVersion` lags `mn --version`, the MCP client is talking to a long-lived stale process. Tell them to disconnect and re-add the MCP server (a /mcp reconnect alone will not respawn it).

## Safety rules (non-negotiable)

- **Read tools** (`readOnlyHint: true`) — safe to call without user consent. Examples: balance, info, list, status, address derivation.
- **Destructive tools** (`destructiveHint: true`) — require explicit user consent before calling. Examples: transfer, airdrop, dust register, wallet generate, wallet remove, cache clear, localnet down.
- **Open-world tools** (`openWorldHint: true`) — touch the network/chain/Docker. Can fail non-deterministically; retry is usually safe for reads, risky for writes.
- **Never** auto-execute a fund-moving operation. Always describe amount + recipient + network first.
- **Never** invent a mnemonic, seed, or private key. If the user needs one, call `midnight_wallet_generate`.

## Error recovery recipes

Every MCP tool error returns `{ error: true, code: <ERROR_CODE>, message: <human prose> }`. **Index on the `code`** — the message is human-targeted and may change. Stable codes:

| Code | Meaning | Recovery |
|---|---|---|
| `INSUFFICIENT_BALANCE` | Wallet doesn't have enough NIGHT to cover the requested amount. | Show the user. On localnet: `midnight_airdrop({ amount: "..." })`. On hosted networks: tell user to fund the address. |
| `DUST_REQUIRED` | Wallet has NIGHT but no DUST to pay fees (or insufficient DUST). | Run `midnight_dust_register()` then wait for dust to regenerate (passive, on-chain — check `midnight_dust_status()` until `dustAvailable: true`). |
| `INVALID_DUST_PROOF` | Chain rejected the dust spend proof as malformed (substrate "Custom error 170"). Stale commitment tree. | `midnight_cache_clear({ wallet: "<name>" })` then retry. |
| `STALE_CACHE` | Local wallet cache disagrees with chain (e.g. localnet reset, remote testnet re-indexed). | `midnight_cache_clear({ wallet: "<name>" })` then retry. |
| `STALE_UTXO` | UTXO was already spent on-chain (substrate "error code 115"). | Re-sync (the next call will refresh state) and retry. |
| `PROOF_FAILURE` | Proof server rejected or failed to generate the ZK proof. Often a stale commitment tree or unreachable proof server. | Check `midnight_status()`; if proof server healthy, `midnight_cache_clear({ wallet: "<name>" })` then retry. |
| `PROOF_TIMEOUT` | ZK proof generation didn't finish within the deadline. | Retry — proofs can be slow under load. |
| `SYNC_TIMEOUT` | Long-running wallet sync hit its deadline. Common on a hosted-network first-cold-sync. | Retry; the cache resumes from the last applied event so progress is preserved. |
| `NETWORK_ERROR` | Indexer/node/proof-server connection refused or DNS failure. | Check `midnight_status()`; if localnet, `midnight_localnet_up()`. |
| `WALLET_NOT_FOUND` | Named wallet doesn't exist on disk. | `midnight_wallet_list()` — user may have removed it. |
| `INVALID_ARGS` | Missing/invalid argument. | Show the message to the user verbatim — it names the missing field. |
| `TX_REJECTED` | Chain rejected the submitted transaction (catch-all when no more specific code applies). | Read the message; usually a state mismatch resolved by re-sync + retry. |
| `CANCELLED` | Operation was aborted (SIGINT). | Don't retry without confirming with the user. |
| `UNKNOWN` | Error didn't match any known classifier. | Surface the message to the user. If reproducible, a new code may be warranted. |

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
