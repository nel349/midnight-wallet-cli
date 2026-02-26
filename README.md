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
| `wallet send <to> <amount>` | Send unshielded NIGHT to an address |
| `wallet fund <to> <amount>` | Fund an address (supports `--genesis` for devnet) |
| `wallet dust register` | Register NIGHT UTXOs for dust generation |
| `wallet dust status` | Check dust registration status and balance |
| `wallet address` | Derive an address from a seed |
| `wallet genesis-address` | Show the genesis wallet address |
| `wallet inspect-cost` | Display current block limits |
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

# Send NIGHT to another address
npm run wallet -- send mn_addr_preprod1... 100
```

## Requirements

- Node.js >= 20
- A running proof server on `localhost:6300` (for write operations)
