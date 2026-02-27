# midnight-wallet-cli — Design Document

## Storage

All wallet CLI state lives in `~/.midnight/` (hidden directory):
- `~/.midnight/wallet.json` — default wallet file
- `~/.midnight/config.json` — persistent config (default network, etc.)

`--wallet <file>` on any command points at a custom wallet path. `--output <file>` on generate saves to a custom path.

Future: `wallet list` and `wallet switch` for managing multiple wallets.

## Subcommand Table

| Command | Args / Flags | Description |
|---------|-------------|-------------|
| `wallet generate` | `[--network <name>]` `[--seed <hex>]` `[--mnemonic "..."]` `[--output <file>]` `[--force]` | Generate a new wallet (random mnemonic, or restore from seed/mnemonic). Saves to `~/.midnight/wallet.json` unless `--output` specifies a custom path. Refuses to overwrite an existing file unless `--force` is specified. `--seed` and `--mnemonic` are mutually exclusive. |
| `wallet info` | `[--wallet <file>]` | Display wallet address, network, creation date. Does NOT show seed/mnemonic. |
| `wallet balance` | `[address]` `[--network <name>]` `[--indexer-ws <url>]` | Check unshielded balance via lightweight GraphQL subscription. If no address, reads from wallet. |
| `wallet transfer` | `<to> <amount>` `[--wallet <file>]` `[--genesis]` `[--proof-server <url>]` `[--no-fees]` | Transfer unshielded NIGHT. `--genesis` uses seed 0x01 (auto-detects network from `<to>` address). Full flow: sync, dust check, build recipe, sign, prove, submit. |
| `wallet dust register` | `[--wallet <file>]` `[--proof-server <url>]` | Register NIGHT UTXOs for dust generation. Required before any fee-paying transaction. |
| `wallet dust status` | `[--wallet <file>]` `[--proof-server <url>]` | Check dust registration status and current dust balance. Requires WalletFacade sync. |
| `wallet address` | `[--seed <hex>]` `[--network <name>]` `[--index <n>]` | Derive and display an unshielded address from a seed without creating a wallet file. |
| `wallet genesis-address` | `[--network <name>]` | Display the genesis wallet address (seed 0x01) for a given network. |
| `wallet inspect-cost` | (none) | Display current block limits derived from LedgerParameters. |
| `wallet config` | `set <key> <value>` / `get <key>` | Manage persistent config. Keys: `network` (default: `undeployed`). Stored in `~/.midnight/config.json`. |
| `wallet help` | `[command]` | Show usage for all commands or a specific command. |

### Network Flag

All commands that accept `--network` support: `preprod`, `preview`, `undeployed`.

Network resolution order (first match wins):
1. Explicit `--network` flag
2. Wallet file's stored network (for commands that load a wallet)
3. Auto-detect from address prefix (`mn_addr_<network>`)
4. Default from `~/.midnight/config.json`
5. Fallback: `undeployed`

When network is `undeployed`, auto-detect testcontainer ports via `docker ps`.


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

## UX & Visual Design

### Output Destinations
- **stdout**: Data output only (addresses, balances, JSON). Pipeable.
- **stderr**: Spinners, progress indicators, status messages, animations.

### Color Palette (ANSI 256)
Raw ANSI escape codes. Respect `NO_COLOR` env var.
- Deep midnight blue (`38;5;17`) — borders, backgrounds
- Teal/cyan (`38;5;38`) — highlights, active elements, spinners
- Purple accent (`38;5;99`) — ZK/privacy-related operations (proving, dust)
- White — data values, important text
- Dim gray — labels, secondary text
- Red — errors
- Green — success confirmations
- Yellow — warnings

### Spinner
Braille animation on stderr: `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`. Updates in-place with `\r`.

### Formatting Patterns
- Header: `═` repeated line with centered title
- Divider: `─` repeated line
- Key-value: aligned padding (`  Key:       Value`)
- NIGHT amounts: always 6 decimal places
- Box drawing for structured output (`╔═╗║╚═╝`)

### Midnight Logo (ASCII Art)
Block-character rendering of the Midnight symbol (circle + 3 vertical squares). Built with Unicode block characters (`▀▄█░▓▒`). Displayed on `wallet help` and first run.

```
        ██████████████
      ██              ██
    ██      ██████      ██
   ██       ██████       ██
   ██                    ██
   ██       ██████       ██
   ██       ██████       ██
    ██                  ██
      ██              ██
        ██████████████

       m i d n i g h t
```

### Operation Animations

All animations write to stderr, respect `NO_COLOR` (degrade to static text when disabled).

**Startup / help** — Logo materialize effect: the Midnight symbol renders pixel-by-pixel from random noise/static, characters resolve into the final logo frame by frame. Then the wordmark `m i d n i g h t` types out letter-by-letter beneath it.

**Wallet sync** — Starfield/particle effect: dots `·` drift across the terminal with a progress counter, evoking the midnight sky aesthetic.

**ZK proof generation** — Randomized hex characters (`a7 3f b2 00 ...`) stream across the line and gradually "resolve" into `PROVED ✓`. Conveys zero-knowledge computation happening.

**Transfer in progress** — Bytes visually flow from sender to receiver with a trail: `████░░░░░░░░████`. Shows movement of value.

**Dust accumulation** — Tiny dots `·` slowly appear and collect, representing dust generation over time. Used during `dust register` wait phase.

**Block confirmation** — After transaction submission, blocks stack like a tiny cityscape silhouette (callback to midnight_sky.png), representing the transaction being confirmed on-chain.

**Success** — Brief character burst effect, then clean success message with tx hash.

**Error** — Line briefly flashes red, then shows the error in a bordered box with recovery suggestion.

**Idle / waiting** — Subtle twinkling dots in empty space while waiting for network responses.

### UI Modules
- `ui/colors.ts` — Midnight palette constants, ANSI helpers, NO_COLOR support
- `ui/format.ts` — header(), divider(), keyValue(), formatNight(), formatAddress(), box()
- `ui/spinner.ts` — braille spinner on stderr, start/stop/update
- `ui/art.ts` — ASCII art logo, pixel-style frames
- `ui/animate.ts` — frame-by-frame renderer for operation animations (sync, proof, transfer, dust)

## Data Flow

### Read-Only Commands (balance, info, address, genesis-address, inspect-cost, config)

```
argv → parse subcommand + flags
     → load wallet.json if needed
     → detect network
     → execute (no proof server required)
     → format output to stdout
     → exit 0
```

### Write Commands (transfer, dust register, dust status)

```
argv → parse subcommand + flags
     → load wallet from ~/.midnight/wallet.json (or --wallet)
     → resolve network config (testcontainer detection for undeployed)
     → build WalletFacade from seed
     → pre-send sync (short timeout ~10s, catches stale UTXOs before building tx)
     → command-specific logic:
         transfer: check balance → ensure dust → build recipe → sign → prove → submit
         dust register: find unregistered UTXOs → register → wait for dust
         dust status: read dust state from synced facade
     → clean shutdown
     → exit 0
```

### Transfer Resilience

**Pre-send sync**: Always do a quick sync (~10s) before building a transaction. This catches UTXOs that were spent externally and prevents immediate rejection.

**Stale UTXO recovery (error 115)**: The node may reject a transaction because a referenced UTXO was already spent (e.g., by another wallet instance or a concurrent transaction). When this happens:
1. Mark the rejected UTXOs as spent locally
2. Re-sync the wallet to get fresh UTXO state
3. Rebuild and retry the transaction (up to 3 attempts)
4. On retry, preserve the spent markings from step 1 (don't clear them during re-sync)

If we don't hit error 115 in practice (because the facade handles it internally), document why and remove the retry logic.

**Network retry with exponential backoff**: On connection failures (indexer, node, proof server), retry with delays: 1s → 2s → 4s → 8s, max 3 attempts before failing with an actionable error message.

### Error Handling
- All errors to stderr, exit code 1
- Wallet file missing → suggest `wallet generate`
- Network detection failure → list valid networks
- Insufficient balance → show current vs required
- Stale UTXO (error 115) → auto-retry with re-sync (see above)
- Proof timeout → show elapsed time
- Connection errors → show endpoint URL with retry count

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

## Implementation Reference

Network configs, key constants, and dependencies are defined in source code (`lib/constants.ts`, `lib/network.ts`, `package.json`). See reference implementation in `/Users/norman/Development/midnight/kuira-verification-test/scripts/` for SDK patterns.
