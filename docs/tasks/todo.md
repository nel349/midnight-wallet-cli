# midnight-wallet-cli — TODO

## Phase 1: Project Scaffolding
- [x] Create directory + git init
- [x] Create CLAUDE.md
- [x] Create DESIGN.md
- [x] Create package.json + tsconfig.json
- [x] Create README.md
- [x] Initial git commit

## Phase 2: Core Library (`src/lib/`)
- [x] `constants.ts` — GENESIS_SEED, NATIVE_TOKEN_TYPE, TOKEN_DECIMALS, timeout values, dust parameters
- [x] `network.ts` — NETWORK_CONFIGS map, detectNetworkFromAddress(), detectTestcontainerPorts(), resolveNetworkConfig()
- [x] `derivation.ts` — deriveShieldedSeed(), deriveUnshieldedSeed(), deriveDustSeed()
- [x] `wallet-config.ts` — WalletConfig interface, loadWalletConfig(), saveWalletConfig(), default path ~/.midnight/wallet.json
- [x] `cli-config.ts` — loadCliConfig(), saveCliConfig(), default network, stored in ~/.midnight/config.json
- [x] `facade.ts` — buildFacade(), startAndSyncFacade(), quickSync(), stopFacade()
- [x] `balance-subscription.ts` — lightweight GraphQL WS balance check (no proof server)

## Phase 2b: Core Library Tests
- [x] `network.test.ts` — detectNetworkFromAddress(), isValidNetworkName(), getNetworkConfig(), resolveNetworkConfig() (21 tests)
- [x] `wallet-config.test.ts` — save/load round-trip, validation (seed hex, network, createdAt), permissions, overwrite (17 tests)
- [x] `cli-config.test.ts` — save/load round-trip, defaults, validation, corruption recovery, no mocks (21 tests)
- Skipped: `constants.test.ts` (trivial), `derivation.test.ts` / `facade.test.ts` (SDK integration, test with real flows later)

## Phase 3: UI Layer (`src/ui/`)
- [x] `colors.ts` — Midnight color palette (midnight blue, teal, purple accent), ANSI 256 helpers, NO_COLOR support
- [x] `format.ts` — header(), divider(), keyValue(), formatNight(), formatAddress(), box()
- [x] `spinner.ts` — braille spinner on stderr, start/stop/update
- [x] `art.ts` — ASCII art Midnight logo (block characters), pixel-style frames
- [x] `animate.ts` — frame-by-frame renderer for operation animations:
  - Wallet sync: starfield/particle drift with progress counter
  - ZK proof: hex stream resolving to `PROVED ✓`
  - Transfer: byte flow trail from sender to receiver
  - Dust: dots accumulating during registration wait
  - Success: character burst effect
  - Error: red flash + bordered box with recovery suggestion
  - Idle: subtle twinkling dots while waiting

## Phase 3b: UI Layer Tests
- [x] `colors.test.ts` — colors enabled/disabled via NO_COLOR, each helper wraps correctly
- [x] `format.test.ts` — formatNight() decimal precision, formatAddress() truncation, keyValue() alignment, box rendering

## Phase 4: Read-Only Commands
- [x] `wallet.ts` — entry point, subcommand dispatch
- [x] `commands/help.ts` — usage for all or specific command
- [x] `commands/generate.ts` — create wallet from random mnemonic, seed, or mnemonic restore
- [x] `commands/info.ts` — display wallet metadata (no secrets)
- [x] `commands/balance.ts` — unshielded balance via GraphQL subscription
- [x] `commands/address.ts` — derive address from seed
- [x] `commands/genesis-address.ts` — show genesis address for a network
- [x] `commands/inspect-cost.ts` — display block limits
- [x] `commands/config.ts` — get/set persistent config (default network, etc.)

## Phase 5: Write Commands
- [x] `lib/transfer.ts` — shared transfer execution (facade lifecycle, dust management, tx build/sign/prove/submit, stale UTXO retry)
- [x] `commands/airdrop.ts` — fund wallet from genesis (seed 0x01), undeployed network only
- [x] `commands/transfer.ts` — send unshielded NIGHT to another address with address validation
- [x] `commands/dust.ts` — register UTXOs for dust generation + check dust status (register/status subcommands)
- [x] Signal handling (SIGINT/SIGTERM) — global AbortController in wallet.ts, clean shutdown of WalletFacade during active operations
- [x] Fix: pin `ledger-v7` to exact `7.0.0` — prevents duplicate WASM modules in global install (instanceof DustParameters failure)
- [x] Fix: explicit `process.exit(0)` for facade commands — SDK WebSockets keep event loop alive after `facade.stop()`

## Phase 5b: Write Command Tests
- [x] `transfer-lib.test.ts` — nightToMicro(), parseAmount(), validateRecipientAddress() (19 tests)
- [x] `airdrop-command.test.ts` — argument validation, network restriction (8 tests)
- [x] `transfer-command.test.ts` — argument/address validation (7 tests)
- [x] `dust-command.test.ts` — subcommand validation (4 tests)
- [x] Updated `help.test.ts` — new command help specs (3 new tests)

## Phase 6: Install + Verify
- [x] npm install -g — resolved ledger-v7 deduplication issue
- [x] typecheck passes (`npm run typecheck`)
- [x] All unit tests pass (`npm test`) — 302 tests
- [x] Manual test: airdrop flow verified on local devnet

## Phase 7: Pillar 1 — AI Agent Friendly (COMPLETE)
- [x] `--json` output flag on all commands
- [x] MCP server via `midnight-wallet-mcp` binary
- [x] `--agent` flag on help for comprehensive AI reference manual
- [x] Structured exit codes in `exit-codes.ts`

## Phase 8: Pillar 2 — DApp Connector Server

`midnight serve` — DApp Connector API v4.0.1 over local WebSocket JSON-RPC.
Full plan: `tasks/pillar2-dapp-connector-plan.md`

- [X] Add reverse RPC to ws-rpc.ts
- [X] Create dapp-connector.ts (18 API methods)
- [X] Create serve.ts command
- [X] Wire into CLI (wallet.ts, help.ts, art.ts)
- [X] Tests + verification

## Future (not in scope now)
- [X] Shielded balance display
- [X] WalletFacade-based balance (full sync, shows dust)
- [X] `wallet list` — show all wallets in ~/.midnight/
