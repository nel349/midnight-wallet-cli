# midnight-wallet-cli — TODO

## Phase 1: Project Scaffolding
- [x] Create directory + git init
- [x] Create CLAUDE.md
- [x] Create DESIGN.md
- [x] Create package.json + tsconfig.json
- [x] Create README.md
- [x] Initial git commit

## Phase 2: Core Library (`src/lib/`)
- [ ] `constants.ts` — GENESIS_SEED, NATIVE_TOKEN_TYPE, TOKEN_DECIMALS, timeout values, dust parameters
- [ ] `network.ts` — NETWORK_CONFIGS map, detectNetworkFromAddress(), detectTestcontainerPorts(), resolveNetworkConfig()
- [ ] `derivation.ts` — deriveShieldedSeed(), deriveUnshieldedSeed(), deriveDustSeed()
- [ ] `wallet-config.ts` — WalletConfig interface, loadWalletConfig(), saveWalletConfig(), default path ~/.midnight/wallet.json
- [ ] `cli-config.ts` — loadCliConfig(), saveCliConfig(), default network, stored in ~/.midnight/config.json
- [ ] `facade.ts` — buildFacade(), syncFacade() with progress, stopFacade()
- [ ] `balance-subscription.ts` — lightweight GraphQL WS balance check (no proof server)

## Phase 2b: Core Library Tests
- [ ] `constants.test.ts` — verify exported values are correct types and formats
- [ ] `network.test.ts` — detectNetworkFromAddress() with valid/invalid prefixes, network resolution order
- [ ] `derivation.test.ts` — deterministic derivation (same seed → same output), all three roles
- [ ] `wallet-config.test.ts` — save/load round-trip, missing file error, invalid JSON error, ~/.midnight/ directory creation
- [ ] `cli-config.test.ts` — save/load round-trip, default values when no config file exists

## Phase 3: UI Layer (`src/ui/`)
- [ ] `colors.ts` — ANSI helpers respecting NO_COLOR
- [ ] `format.ts` — header(), divider(), keyValue(), formatNight(), formatAddress()
- [ ] `spinner.ts` — braille spinner on stderr

## Phase 3b: UI Layer Tests
- [ ] `colors.test.ts` — colors enabled/disabled via NO_COLOR, each helper wraps correctly
- [ ] `format.test.ts` — formatNight() decimal precision, formatAddress() truncation, keyValue() alignment

## Phase 4: Read-Only Commands
- [ ] `wallet.ts` — entry point, subcommand dispatch
- [ ] `commands/help.ts` — usage for all or specific command
- [ ] `commands/generate.ts` — create wallet from random mnemonic, seed, or mnemonic restore
- [ ] `commands/info.ts` — display wallet metadata (no secrets)
- [ ] `commands/balance.ts` — unshielded balance via GraphQL subscription
- [ ] `commands/address.ts` — derive address from seed
- [ ] `commands/genesis-address.ts` — show genesis address for a network
- [ ] `commands/inspect-cost.ts` — display block limits
- [ ] `commands/config.ts` — get/set persistent config (default network, etc.)

## Phase 5: Write Commands
- [ ] `commands/transfer.ts` — send unshielded NIGHT (with --genesis support)
- [ ] `commands/dust-register.ts` — register UTXOs for dust generation
- [ ] `commands/dust-status.ts` — check dust status and balance (requires WalletFacade sync)

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
