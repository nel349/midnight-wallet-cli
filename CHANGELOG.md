# Changelog

All notable changes to midnight-wallet-cli will be documented in this file.

## [Unreleased]

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

## [0.2.0] - 2025-05-01

### Added
- DApp Connector Server (`mn serve`) — WebSocket JSON-RPC server implementing all 18 ConnectedAPI methods
- Terminal approval prompts for write operations with auto-approve modes
- SDK v2.0.0-rc upgrade (WalletFacade, dust wallet, shielded/unshielded)
- Dust registration retry logic with RPC noise suppression
- `--json` output flag for AI agent integration
- MCP server (`midnight-wallet-mcp`) for Claude Code and other MCP clients
- Connector client package (`@midnight-wallet-cli/connector`)

### Changed
- Minified build output
- Centralized package metadata via `src/lib/pkg.ts`

## [0.1.5] - 2025-04-15

### Added
- Animated logo and wordmark on startup
- `--agent` flag for comprehensive AI reference manual
- Localnet management (`mn localnet up/stop/down/status/clean`)

### Fixed
- Wordmark animation frame alignment

## [0.1.0] - 2025-04-01

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
