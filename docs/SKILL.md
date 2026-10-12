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
  - `preprod` — public testnet. Its indexer and node are served by Blockfrost and need the user's own project id (see "Preprod needs a Blockfrost project id" below). The first call that needs the wallet's Dust reads the chain's whole Dust history: about 5 minutes, once per wallet (see "First sync on a hosted network" below).
  - `preview` — public preview testnet. No project id needed. Same first sync, about 30 seconds.
- **Proof server** — local HTTP service that generates ZK proofs for transactions. Default port 6300. Version must match the network's ledger version or writes fail with "Custom error 170".

### Preprod needs a Blockfrost project id

Midnight shut its own preprod indexer down on 2026-10-09. Blockfrost serves preprod's indexer and node now, and every request needs the user's own project id (created at https://blockfrost.io, one project per network; preprod ids start with `nightpreprod`; requests count against the user's Blockfrost plan). The user sets it once with `midnight config set blockfrost-project-id <project id>` in their own terminal, or `BLOCKFROST_PROJECT_ID` (or `MN_BLOCKFROST_PROJECT_ID`) in the MCP server's environment. It is a secret: `midnight_config_get` shows it masked, no tool result contains it, and you should never ask for it in chat or echo it. Preview and the local network need none.

### First sync on a hosted network

The first call that needs a wallet's Dust on `preprod` or `preview` (`midnight_dust_register`, `midnight_dust_status` of a registered wallet, `midnight_transfer`, any contract deploy or call, `mn serve`, `mn dust export`) reads the chain's whole Dust event history before it does anything else. It happens once per wallet and network; later calls resume from a cache and take seconds. A balance of an empty wallet does not trigger it.

| Network | Dust events (2026-10-11) | First sync, native reader | First sync, WASM reader | Later calls |
|---|---|---|---|---|
| `preprod` | 1.6M | about 5 min | about 27 min (estimated) | about 6 s |
| `preview` | 144k | about 30 s | about 2 min | about 10 s |

- **Tell the user before the first such call** how long it will take, and allow the tool call that long. Don't cancel and retry: an interrupted sync resumes from its last checkpoint, so nothing is lost, but nothing is gained either.
- **The native reader** is the `dust-sync` sidecar: an optional npm package for the platform (`@nel349/dust-sync-<os>-<arch>`; macOS arm64/x64, Linux x64/arm64 on glibc, Windows x64) that installs with the CLI and needs no setup. Without it the CLI reads with its built-in WASM reader: same result, several times slower.
- **How to tell which reader ran** (CLI): add `--verbose`. Each sync logs `dust: native sidecar: <path>`, or `dust: native sidecar <reason>, using WASM`. On a long sync the CLI also prints one line on stderr without `--verbose`: `Native Dust reader <reason>: reading with the built-in one, several times slower on a long sync.`
- **If the native reader is not in use**, the reason is one of: `not installed` (npm ran with `--omit=optional`, or the platform has no build), `can't start on this system` (Alpine or another musl Linux: the Linux builds need glibc), `disabled by MN_DISABLE_NATIVE_DUST=1`, or `failed` (a run error; the CLI carries on in WASM). Fixes for the user to run: reinstall without omitting optional dependencies (`npm install -g midnight-wallet-cli`), or use a glibc container image (`node:22-slim`, not `node:22-alpine`). Don't set `MN_DISABLE_NATIVE_DUST` yourself.

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
| "Fund this address …" (localnet only) | `midnight_airdrop({ amount: "1000", wallet: "mn_addr_undeployed1…" })` — `wallet` accepts a name, path, or raw bech32m address |
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

**Arg encoding for circuits.** The MCP `args` param is a JSON string. The bridge auto-coerces, recursing into objects and arrays:
- `number` (integer, within `Number.MAX_SAFE_INTEGER`) → `BigInt`
- `"123n"` (BigInt-literal syntax) → `BigInt(123)` — required for values beyond safe-integer range, e.g. 256-bit field elements in elliptic-curve points like `{x: "3577…n", y: "5455…n"}`
- array of `[0–255]` ints → `Uint8Array` (any Compact `Bytes<N>` arg, e.g. `[1,2,3,…,32]`)
- objects: each value coerced under the same rules → `Struct` args
- arrays (non-byte): each element coerced

Plain strings, booleans, fractional numbers, and `null` pass through unchanged. No hex-string detection — `"1234"` stays a string.

**Compatibility caveat — runtime version skew.** Contracts must be compiled with the current Compact toolchain. The CLI bundles `@midnight-ntwrk/compact-runtime` `^0.16.0`, so contracts have to target runtime `0.16.0`. Pre-compiled artifacts built for an older runtime (e.g. `0.15.0`) are rejected at deploy/call with a clear message like `CompactError: Version mismatch: compiled code expects 0.15.0`. The fix is to recompile against the current runtime — run `compact compile` (or `mn dev`, which auto-compiles on save) rather than asking the user to downgrade `mn`. `midnight_contract_inspect` shows the compiled `runtimeVersion` so you can flag the mismatch before attempting deploy.

**Stale MCP server.** Every MCP response carries `_serverVersion`. If the user upgraded `midnight-wallet-cli` but `_serverVersion` lags `mn --version`, the MCP client is talking to a long-lived stale process. Tell them to disconnect and re-add the MCP server (a /mcp reconnect alone will not respawn it).

### User wants to scaffold tests for a contract
Use `midnight_test_create({ path, strategy })`. Strategies:
- `"cli"` (default) — emits `dapp.test.json` + `tests/suites/cli-default/{suite,actions,assertions}.json` with deploy → state → one call per impure circuit → state. Placeholder args; user reviews and edits before `mn test run`.
- `"browser"` — additionally needs `port` and `build-cmd`; emits `prompt.md` instead of `actions.json`. Claude drives the UI per `prompt.md`.

Running a suite is a CLI command, not an MCP tool: `mn test run --suite <name>` (exit code 0 on PASS, 1 on FAIL; `--json` prints the result, `mn test results` shows the last one). Its prep steps start the localnet if it is down, fund the active wallet, register Dust and wait until there is enough of it to pay for a transaction (about a minute and a half on a new chain), then start `mn serve`. Browser strategy supports `browserMode: "vision"` (screenshots — default), `"dom"` (accessibility tree, faster, requires `chrome-devtools-mcp`), `"script"` (direct JS, fastest, requires `chrome-devtools-mcp`). Pre-flight detects missing `chrome-devtools-mcp` and orphan automation Chromes from prior crashes.

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
| `PROOF_FAILURE` | Proof server rejected or failed to generate the ZK proof. Often a stale commitment tree or unreachable proof server. | Check that the proof server is running (on localnet: `midnight_localnet_status()`); if it is, `midnight_cache_clear({ wallet: "<name>" })` then retry. |
| `PROOF_TIMEOUT` | ZK proof generation didn't finish within the deadline. | Retry — proofs can be slow under load. |
| `SYNC_TIMEOUT` | Long-running wallet sync hit its deadline. Common on a hosted-network first-cold-sync. | Retry; the cache resumes from the last applied event so progress is preserved. If first syncs take far longer than the times in "First sync on a hosted network", the native Dust reader is not in use: see that section. |
| `NETWORK_ERROR` | Indexer/node/proof-server connection refused or DNS failure. | On localnet: `midnight_localnet_status()`, then `midnight_localnet_up()` if it is down. On a hosted network: retry once, then show the message to the user. |
| `BLOCKFROST_PROJECT_ID_REQUIRED` | The network (preprod) is served by Blockfrost and no project id is set. | Ask the user to create a Midnight preprod project at https://blockfrost.io and run `midnight config set blockfrost-project-id <project id>` themselves. Never ask them to paste the id into the chat. Don't retry until they have. |
| `BLOCKFROST_PROJECT_ID_REJECTED` | Blockfrost refused the project id (HTTP 403): mistyped, revoked, or for another network. | Ask the user to check it at blockfrost.io and set it again. Don't retry blindly. |
| `BLOCKFROST_LIMIT_REACHED` | Blockfrost's plan limit or rate limit. | Wait and retry once; if it persists, tell the user it is their Blockfrost plan. |
| `ENDPOINT_SHUT_DOWN` | An endpoint set by flag or config was shut down by its operator (the old preprod indexer). | `midnight_config_unset({ key: "indexer-ws" })` (and `node` if set), then retry. |
| `WALLET_NOT_FOUND` | Named wallet doesn't exist on disk. | `midnight_wallet_list()` — user may have removed it. |
| `INVALID_ARGS` | Missing/invalid argument. | Show the message to the user verbatim — it names the missing field. |
| `TX_REJECTED` | Chain rejected the submitted transaction (catch-all when no more specific code applies). | Read the message; usually a state mismatch resolved by re-sync + retry. |
| `CANCELLED` | Operation was aborted (SIGINT). | Don't retry without confirming with the user. |
| `UNKNOWN` | Error didn't match any known classifier. | Surface the message to the user. If reproducible, a new code may be warranted. |

## When to use which network

- **Developing a contract?** → `undeployed` (localnet). No first-sync cost; everything is local.
- **Integration testing against a hosted chain?** → `preprod` (needs a Blockfrost project id; first Dust sync about 5 minutes) or `preview` (no project id; about 30 seconds). Later syncs restore from cache and take seconds.
- **Demoing to users?** → `preview` (if the dApp is deployed there) or `undeployed` (if self-contained).
- **Mainnet?** → not on this CLI yet. Don't claim it is.

## What this CLI is NOT

- Not a custody service. Keys are on the user's disk (`~/.midnight/wallets/<name>.json`).
- Not an instant-sync tool for a first-time wallet on a hosted network. The first call that needs the wallet's Dust reads the chain's Dust history (about 5 minutes on preprod, 30 seconds on preview, with the native reader that installs with the CLI); the CLI caches state after that so later calls take seconds. See "First sync on a hosted network".
- Not a contract compiler. The project's `package.json` should expose a `compact` script (Midnight convention, e.g. `"compact": "compact compile src/foo.compact src/managed/foo"`) or a `compile` script as a generic fallback. `mn dev` detects whichever is present; create-mn-app and midnight-starship templates ship with the `compact` script already wired.

## Authoritative references

- `mn help <command>` — per-command usage and flags.
- `mn help --agent` — structured reference manual for AI clients.
- `mn status` — live network health (indexer, node, proof server).
