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
- [ ] `commands/transfer.ts` — send unshielded NIGHT (with --genesis support)
- [ ] `commands/dust-register.ts` — register UTXOs for dust generation
- [ ] `commands/dust-status.ts` — check dust status and balance (requires WalletFacade sync)
- [ ] Signal handling (SIGINT/SIGTERM) — clean shutdown of WebSocket connections and WalletFacade during active operations

## Phase 6: Install + Verify
- [ ] npm install and resolve any dependency issues
- [ ] typecheck passes (`npm run typecheck`)
- [ ] All unit tests pass (`npm test`)
- [ ] Manual test: generate → info → balance → transfer flow

## Future (not in scope now)
- [ ] `--json` output flag for machine-readable output
- [ ] Shielded balance display
- [ ] WalletFacade-based balance (full sync, shows dust)
- [ ] `wallet list` — show all wallets in ~/.midnight/
- [ ] `wallet switch` — change active wallet
- [ ] `--watch` flag for balance command
- [ ] DApp connector — local WS server implementing `@midnight-ntwrk/midnight-dapp-connector-api` (v4.0.0), allows browser dApps to request tx approval via CLI
