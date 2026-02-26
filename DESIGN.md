# midnight-wallet-cli — Design Document

## Wallet Storage

Default location: `~/.midnight/wallet.json` (hidden directory).

Commands that accept `--wallet <file>` can point at a different wallet file. Multiple wallets supported via named files (e.g., `~/.midnight/devnet.wallet.json`).

Future: `wallet list` and `wallet switch` for managing multiple wallets.

## Subcommand Table

| Command | Args / Flags | Description |
|---------|-------------|-------------|
| `wallet generate` | `[--network <name>]` `[--seed <hex>]` `[--mnemonic "..."]` `[--output <file>]` | Generate a new wallet (random mnemonic, or restore from seed/mnemonic). Saves to `~/.midnight/wallet.json`. |
| `wallet info` | `[--wallet <file>]` | Display wallet address, network, creation date. Does NOT show seed/mnemonic. |
| `wallet balance` | `[address]` `[--watch]` `[--network <name>]` `[--indexer-ws <url>]` | Check unshielded balance via lightweight GraphQL subscription. If no address, reads from wallet. |
| `wallet transfer` | `<to> <amount>` `[--wallet <file>]` `[--genesis]` `[--proof-server <url>]` `[--no-fees]` | Transfer unshielded NIGHT. `--genesis` uses seed 0x01 for devnet funding. Full flow: sync, dust check, build recipe, sign, prove, submit. |
| `wallet dust register` | `[--wallet <file>]` `[--proof-server <url>]` | Register NIGHT UTXOs for dust generation. Required before any fee-paying transaction. |
| `wallet dust status` | `[--wallet <file>]` | Check dust registration status and current dust balance. |
| `wallet address` | `[--seed <hex>]` `[--network <name>]` `[--index <n>]` | Derive and display an unshielded address from a seed without creating a wallet file. |
| `wallet genesis-address` | `[--network <name>]` | Display the genesis wallet address (seed 0x01) for a given network. |
| `wallet inspect-cost` | (none) | Display current block limits derived from LedgerParameters. |
| `wallet help` | `[command]` | Show usage for all commands or a specific command. |

### Network Flag

All commands that accept `--network` support: `preprod`, `preview`, `undeployed`.

When no `--network` is specified:
- Commands reading from wallet.json use the stored network
- Commands receiving an address auto-detect from the `mn_addr_<network>` prefix
- `undeployed` network auto-detects testcontainer ports via `docker ps`

## File Structure

```
midnight-wallet-cli/
├── CLAUDE.md
├── DESIGN.md
├── package.json
├── tsconfig.json
├── .gitignore
├── tasks/
│   ├── todo.md
│   └── lessons.md
└── src/
    ├── wallet.ts                # Entry point — argv dispatch
    ├── commands/
    │   ├── balance.ts
    │   ├── transfer.ts
    │   ├── generate.ts
    │   ├── info.ts
    │   ├── dust-register.ts
    │   ├── dust-status.ts
    │   ├── address.ts
    │   ├── genesis-address.ts
    │   ├── inspect-cost.ts
    │   └── help.ts
    ├── lib/
    │   ├── constants.ts
    │   ├── network.ts
    │   ├── derivation.ts
    │   ├── wallet-config.ts
    │   ├── facade.ts
    │   └── balance-subscription.ts
    └── ui/
        ├── format.ts
        ├── spinner.ts
        └── colors.ts
```

## Shared Library Modules

### `lib/constants.ts`
All magic values: GENESIS_SEED, NATIVE_TOKEN_TYPE, TOKEN_DECIMALS (6), dust cost parameters, timeout durations.

### `lib/network.ts`
- Network config map (indexer, indexerWS, node, proofServer, networkId) for preprod, preview, undeployed
- Network auto-detection from address prefix (`mn_addr_<network>`)
- Testcontainer port auto-detection via `docker ps` for undeployed network

### `lib/derivation.ts`
HD wallet key derivation for the three Midnight roles (Zswap, NightExternal, Dust). All use account=0, index=0.

### `lib/wallet-config.ts`
Load/save wallet files. Default path: `~/.midnight/wallet.json`. Creates `~/.midnight/` directory if it doesn't exist. The wallet config stores: seed (hex), optional mnemonic, network name, derived address, creation timestamp.

### `lib/facade.ts`
Build the full WalletFacade from a seed and network config. Assembles ShieldedWallet + UnshieldedWallet + DustWallet. Provides sync helper with progress reporting and clean shutdown.

### `lib/balance-subscription.ts`
Direct GraphQL WebSocket subscription for read-only balance checking. No proof server needed. Tracks UTXOs by intentHash:outputIndex, computes unspent balances.

## UX Formatting

### Output Destinations
- **stdout**: Data output only (addresses, balances, JSON). Pipeable.
- **stderr**: Spinners, progress indicators, status messages.

### Colors
Raw ANSI escape codes. Respect `NO_COLOR` env var.
- Headers: bold
- Keys: dim
- Errors: red
- Success: green
- Warnings: yellow

### Spinner
Braille animation on stderr: `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`. Updates in-place with `\r`.

### Formatting Patterns
- Header: `═` repeated line with centered title
- Divider: `─` repeated line
- Key-value: aligned padding (`  Key:       Value`)
- NIGHT amounts: always 6 decimal places

## Data Flow

### Read-Only Commands (balance, info, address, genesis-address, inspect-cost)

```
argv → parse subcommand + flags
     → load wallet.json if needed
     → detect network
     → execute (no proof server required)
     → format output to stdout
     → exit 0
```

### Write Commands (transfer, dust register)

```
argv → parse subcommand + flags
     → load wallet from ~/.midnight/wallet.json (or --wallet)
     → resolve network config (testcontainer detection for undeployed)
     → build WalletFacade from seed
     → sync wallet (with progress spinner)
     → command-specific logic:
         transfer: check balance → ensure dust → build recipe → sign → prove → submit
         dust register: find unregistered UTXOs → register → wait for dust
     → clean shutdown
     → exit 0
```

### Error Handling
- All errors to stderr, exit code 1
- Wallet file missing → suggest `wallet generate`
- Network detection failure → list valid networks
- Insufficient balance → show current vs required
- Proof timeout → show elapsed time
- Connection errors → show endpoint URL

## Midnight SDK Patterns

### HD Derivation Roles
Path: `m/44'/2400'/account'/role/index`

| Role | Enum | Purpose |
|------|------|---------|
| Zswap | `Roles.Zswap` | Shielded wallet (ZK proofs) |
| NightExternal | `Roles.NightExternal` | Unshielded wallet (NIGHT transfers) |
| Dust | `Roles.Dust` | Dust wallet (fee token generation) |

### Dust Registration
NIGHT tokens generate DUST (non-transferable fee token) only after UTXOs are explicitly registered on-chain. Required before any fee-paying transaction.

### Transfer Flow
Build recipe → sign → finalize (ZK proof, can take minutes) → submit

### Balance via GraphQL
WebSocket subscription using `graphql-transport-ws` protocol. Subscribe to `unshieldedTransactions(address)`, track created/spent UTXOs, sum unspent values.

## Network Configs

| Network | Indexer | Node | Proof Server |
|---------|--------|------|-------------|
| preprod | `indexer.preprod.midnight.network` | `rpc.preprod.midnight.network` | localhost:6300 |
| preview | `indexer.preview.midnight.network` | `rpc.preview.midnight.network` | localhost:6300 |
| undeployed | localhost:8088 | localhost:9944 | localhost:6300 |

## Key Constants

| Constant | Value |
|----------|-------|
| GENESIS_SEED | `00...01` (32 bytes) |
| NATIVE_TOKEN_TYPE | `00...00` (32 bytes) |
| TOKEN_DECIMALS | 6 |
| DUST_COST_OVERHEAD | 300_000_000_000_000 |
| DUST_FEE_BLOCKS_MARGIN | 5 |
| TX_TTL_MINUTES | 10 |

## Dependencies

```
@midnight-ntwrk/wallet-sdk-facade
@midnight-ntwrk/wallet-sdk-hd
@midnight-ntwrk/wallet-sdk-shielded
@midnight-ntwrk/wallet-sdk-unshielded-wallet
@midnight-ntwrk/wallet-sdk-dust-wallet
@midnight-ntwrk/wallet-sdk-address-format
@midnight-ntwrk/wallet-sdk-abstractions
@midnight-ntwrk/ledger
@midnight-ntwrk/midnight-js-types
@midnight-ntwrk/midnight-js-network-id
@scure/bip39
rxjs
ws
```
