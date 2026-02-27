# midnight-wallet-cli

A standalone git-style CLI wallet for the Midnight blockchain.

## Usage

```bash
npm run wallet -- <command> [options]
```

## Commands

| Command | Description |
|---------|-------------|
| `wallet generate` | Generate a new wallet or restore from seed/mnemonic |
| `wallet info` | Display wallet address, network, creation date |
| `wallet balance [address]` | Check unshielded NIGHT balance |
| `wallet transfer <to> <amount>` | Transfer unshielded NIGHT (`--genesis` for devnet funding) |
| `wallet dust register` | Register NIGHT UTXOs for dust generation |
| `wallet dust status` | Check dust registration status and balance |
| `wallet address` | Derive an address from a seed |
| `wallet genesis-address` | Show the genesis wallet address |
| `wallet inspect-cost` | Display current block limits |
| `wallet config set/get` | Manage persistent CLI config (default network, etc.) |
| `wallet help [command]` | Show usage for all or a specific command |

## Supported Networks

- **preprod** — Midnight pre-production testnet
- **preview** — Midnight preview testnet
- **undeployed** — Local devnet (auto-detects testcontainer ports)

## Quick Start

```bash
# Generate a wallet on preprod
npm run wallet -- generate --network preprod

# Check your balance
npm run wallet -- balance

# Transfer NIGHT to another address
npm run wallet -- transfer mn_addr_preprod1... 100

# Fund from genesis (local devnet)
npm run wallet -- transfer mn_addr_undeployed1... 1000 --genesis
```

## Publishing

See [PUBLISHING.md](./PUBLISHING.md) for build, pack, and npm publish instructions.

## Requirements

- Node.js >= 20
- A running proof server on `localhost:6300` (for write operations)
