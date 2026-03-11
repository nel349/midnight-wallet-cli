# Changelog

All notable changes to midnight-wallet-cli will be documented in this file.

## [Unreleased]

### Wallet State Cache

Persistent cache of serialized wallet state (`serializeState()` / `.restore()`). Subsequent CLI runs restore from cache and only sync new transactions since checkpoint. Reduces repeat sync from 1–5 min to 5–30 seconds. Use `--no-cache` flag to bypass.

### Preprod Network Support

Added preprod network with proof server and endpoint override flags (`--proof-server`, `--node`, `--indexer-ws`).

### Multi-Wallet Support

Named wallet management via `mn wallet generate|list|use|info|remove`. Wallets are stored as `~/.midnight/wallets/<name>.json` with an active wallet tracked in config. The `--wallet` flag now accepts a wallet name (e.g. `--wallet alice`) in addition to file paths. Old `~/.midnight/wallet.json` files are auto-migrated to `wallets/default.json` on first run. `mn generate` is deprecated in favor of `mn wallet generate <name>`.

### DApp Connector Server — Developer Experience

These improvements make `mn serve` more informative and less disruptive for DApp developers.

#### Connection ID in approval prompt
Each WebSocket connection gets a stable ID (`conn_1`, `conn_2`, ...) that appears in the approval dialog. When multiple DApps connect to the same wallet, you can tell which one is asking.

#### Transaction size in approval prompt
Balance and submit approval prompts now show the transaction payload size (e.g. "4.2 KB"), helping developers spot oversized transactions before they hit the chain.

#### Request counter per connection
Every RPC request is numbered per connection, making it easy to correlate activity in the server log:
```
  [00:16:42] conn_1 #3 → balanceUnsealedTransaction
```

#### Request timing in server log
Each response logs how long the handler took, so you can see whether slowness is in proving, balancing, or submitting:
```
  ✓ conn_1 ← balanceUnsealedTransaction (2.3s)
  ✗ conn_1 ← submitTransaction (0.1s) Insufficient dust
```

#### Tx hash in server log after submit
After a successful `submitTransaction`, the transaction hash is logged so you can trace it in the indexer without digging through SDK output.

#### Combined balance + submit approval
Every DApp write operation used to require two separate approvals (balance, then submit) seconds apart. Now, balance operations (prep steps with no on-chain effect) are auto-approved, and only the final `submitTransaction` (the irreversible on-chain write) prompts for approval. One approval per write instead of two, on the step that matters.

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
