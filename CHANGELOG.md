# Changelog

All notable changes to midnight-wallet-cli will be documented in this file.

## [Unreleased]

### Added

- **`mn cache clear` command** — Clear wallet sync state cache. Supports `--network` to clear a specific network and `--wallet` to clear a specific wallet. Available as MCP tool (`midnight_cache_clear`). Also wipes the new dust-direct cache (see below).
- **`mn config unset` command** — Reset a config key to its default value (e.g. `mn config unset proof-server`).
- **`mn status` command** — Network health check showing indexer, node, and proof server connectivity with latency. Available as MCP tool (`midnight_status`).
- **Preview network support** — Connect to the Midnight preview testnet with `--network preview`.
- **Phase-based progress logging in `mn serve`** — Long operations (sync, prove, balance, submit) now show timed phases in the terminal (e.g. `▸ Proving [2.3s]`). DApp clients receive structured progress notifications.
- **Spinner for long-running SDK calls** — Terminal feedback during wallet sync and proof generation.
- **Indexer-direct dust status** — `mn dust status` bypasses the dust-wallet SDK entirely: fast pre-check for registration via the indexer's unshielded-UTXO stream, then (if registered) replays `dustLedgerEvents` directly into a `DustLocalState` to compute balance. ~2–4s on a cached wallet, ~97s on a first-time preprod run (one-time full replay).
- **Dust-direct cache** — Serialized `DustLocalState` + last-applied event id persisted per `(network, dust pubkey)`. Subsequent runs delta-sync from the last applied event id.
- **Auto-prime for write commands** — Before each `transfer`, `airdrop`, `dust register`, or `serve` start, the dust-direct cache is brought up to chain tip and overlaid into the facade cache. Writes then resume sync from a near-tip checkpoint instead of slowly catching up from scratch. Shows live event-count progress in the terminal.
- **`no-dust` sync mode** — `mn balance` now syncs shielded + unshielded and skips dust entirely (dust isn't needed to read NIGHT balances). Eliminates the preprod balance hang.
- **`requireStrictSync` option** — Write commands opt in so ZK proofs are built against a current commitment tree. Read commands skip this for a cached-restore grace-period speedup.
- **Cached-restore grace period** — After 10s, if the facade was restored from cache and non-dust wallets are strictly complete, sync resolves even if the dust-wallet SDK's `isConnected` flag never flips (see Fixed below).

### Changed

- **SDK upgraded to stable 2.0.0** — wallet-sdk packages moved from RC to stable releases (wallet-sdk 2.0.0, wallet-sdk-hd 3.0.1, wallet-sdk-address-format 3.0.1). Imports updated from `wallet-sdk-dust-wallet` to `wallet-sdk-dust-wallet/v1`.
- **`--no-cache` removed from write commands** — `transfer`, `airdrop`, `dust register`, and `serve` no longer accept `--no-cache`. The SDK's fresh-sync path is too slow on hosted networks to be viable, so the flag was a footgun. Passing it now errors with a pointer to `mn cache clear`. Still accepted on `balance` and `dust status`, where a fresh read is cheap and sometimes useful for debugging.

### Fixed

- **Preprod dust-sync hang** — `mn balance`, `mn dust status`, and `mn transfer` on preprod would hang indefinitely on "waiting on: dust". Root cause: the dust-wallet SDK's `isStrictlyComplete()` predicate requires `isConnected=true`, which only flips when a non-empty `DustLedgerEvents` batch arrives — on idle streams it never flips. Now addressed via (a) indexer-direct reads for status, (b) the `no-dust` sync mode for balance, and (c) cache bridging + grace period for transfer/other writes.
- **Dust spend proofs rejected on preprod** — Transfers submitted with a stale commitment tree were rejected by the chain as `MalformedError::InvalidDustSpendProof` (error code 170). Writes now strictly sync before proving, using the pre-primed dust-direct cache to make that fast.
- **Instant dust recovery after transaction rejection** — Rejecting a `submitTransaction` in `mn serve` no longer breaks the dust wallet. Previously, the SDK's internal revert mechanism (`CoreWallet.applyFailed`) called `processTtls()` which destroyed the dust UTXO entirely, leaving the wallet unable to balance any further write operations until new dust was generated on-chain (2+ minutes on preprod, requiring a cache clear and restart in the worst case). We now snapshot the WASM `DustLocalState` before each dust spend and restore it on revert, giving the coin back instantly. Operators can reject and re-approve transactions as many times as needed without any interruption.
- **Cache corruption on Ctrl+C** — Shutting down `mn serve` while a transaction was pending (balanced but not yet submitted) would serialize the dust wallet's corrupted state to the cache file, causing subsequent commands like `mn dust status` to report zero dust. The shutdown path now skips the cache save when transactions are still in-flight, preserving the last known-good cache.
- **Abandoned transaction cleanup** — Pending transactions that are never submitted (DApp disconnects or goes silent) are now automatically reverted after 2 minutes, releasing locked dust coins back to available.

## [0.2.0] - 2026-03-11

### Added

- **Multi-wallet support** — Named wallet management via `mn wallet generate|list|use|info|remove`. Wallets stored as `~/.midnight/wallets/<name>.json` with active wallet tracked in config. The `--wallet` flag accepts a wallet name (e.g. `--wallet alice`) in addition to file paths. Old `~/.midnight/wallet.json` auto-migrates to `wallets/default.json` on first run. `mn generate` is deprecated in favor of `mn wallet generate <name>`.
- **Preprod network support** — Connect to the Midnight pre-production testnet with `--network preprod`. Includes built-in endpoint URLs for indexer, node, and proof server.
- **Endpoint override flags** — `--proof-server`, `--node`, `--indexer-ws` flags on transaction commands. Persist overrides with `mn config set proof-server <url>`. Priority: flag > config > network default.
- **Wallet state cache** — Persistent cache of serialized wallet state. Subsequent runs restore from checkpoint and only sync new transactions. Reduces repeat sync from 1–5 min to 5–30 seconds. Use `--no-cache` to bypass.
- **Wallet name validation** — Shared `isValidWalletName()` validator rejects path traversal, `.json` suffix, control characters, and other unsafe names across all wallet operations.
- **Testcontainer auto-detection** — On `undeployed` network, automatically detects Docker-mapped ports for node, indexer, and proof server.

### Improved

- **DApp Connector Server (`mn serve`)**
  - Connection IDs (`conn_1`, `conn_2`) in approval prompts and logs
  - Transaction payload size shown in approval prompts
  - Per-connection request counter for log correlation
  - Response timing in server log (e.g. `← submitTransaction (2.3s)`)
  - Transaction hash logged after successful submit
  - Combined balance + submit approval — prep steps auto-approved, only the final `submitTransaction` prompts

## [0.1.11] - 2026-03-04

### Added
- DApp Connector Server (`mn serve`) — WebSocket JSON-RPC server implementing all 18 ConnectedAPI methods
- Terminal approval prompts for write operations with auto-approve modes
- Connector client package (`midnight-wallet-connector`)
- MCP server (`midnight-wallet-mcp`) for Claude Code and other MCP clients
- `--json` output flag for AI agent integration
- `midnight status` and `midnight doctor` commands for infrastructure health and diagnostics

### Changed
- SDK v2.0.0-rc upgrade (WalletFacade, dust wallet, shielded/unshielded)
- Minified build output
- Centralized package metadata via `src/lib/pkg.ts`
- Workspace configuration for connector package

## [0.1.10] - 2026-03-03

### Fixed
- Dust wallet sync detection and transfer pre-flight check
- RPC noise suppression scoped once per outer operation

## [0.1.9] - 2026-03-03

### Fixed
- Transfer error handling for dust capacity and transaction rejection

## [0.1.8] - 2026-03-03

### Added
- Minified build output for smaller package size

### Fixed
- Dust registration retry for fresh localnets (error 138)

## [0.1.7] - 2026-03-03

### Changed
- Centralized package metadata and removed createRequire usage
- Removed demo files

## [0.1.6] - 2026-03-01

### Fixed
- Wordmark animation frame alignment and materialize flash effect

## [0.1.5] - 2026-03-01

### Added
- Animated logo and wordmark on startup
- `--agent` flag for comprehensive AI reference manual
- Localnet management (`mn localnet up/stop/down/status/clean`)

## [0.1.4] - 2026-03-01

### Added
- MCP server for wallet management
- CI workflow

## [0.1.3] - 2026-03-01

### Added
- `--json` output for AI agent integration
- DApp connector server and HTTP payment flow support

## [0.1.2] - 2026-03-01

### Added
- Transfer and airdrop commands

### Fixed
- Suppress transient SDK errors and improve sync warning UX

## [0.1.1] - 2026-03-01

### Changed
- Migrated to ledger-v7
- Renamed `send` command to `transfer`

## [0.1.0] - 2026-03-01

### Added
- Initial release
- Wallet generation (`mn generate`) with BIP-39 mnemonic
- Address derivation (`mn address`)
- Balance checking (`mn balance`)
- Token transfer (`mn transfer`)
- Airdrop from genesis wallet (`mn airdrop`)
- Dust registration (`mn dust register/status`)
- Network configuration (`mn config`)
- Wallet info (`mn info`)
