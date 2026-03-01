# midnight-wallet-cli

[![CI](https://github.com/nel349/midnight-wallet-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/nel349/midnight-wallet-cli/actions/workflows/ci.yml)

A standalone CLI wallet for the Midnight blockchain. Manage wallets, check balances, transfer NIGHT tokens, and run a local devnet — all from the terminal.

## Install

```bash
npm install -g midnight-wallet-cli
```

This installs three commands: `midnight` (or `mn` for short) and `midnight-wallet-mcp`.

## Commands

| Command | Description |
|---------|-------------|
| `midnight generate` | Generate a new wallet or restore from seed/mnemonic |
| `midnight info` | Display wallet address, network, creation date |
| `midnight balance [address]` | Check unshielded NIGHT balance |
| `midnight transfer <to> <amount>` | Send NIGHT tokens to another address |
| `midnight airdrop <amount>` | Fund wallet from genesis (local devnet only) |
| `midnight dust register` | Register NIGHT UTXOs for dust (fee token) generation |
| `midnight dust status` | Check dust registration status and balance |
| `midnight address --seed <hex>` | Derive an address from a seed |
| `midnight genesis-address` | Show the genesis wallet address |
| `midnight inspect-cost` | Display current block cost limits |
| `midnight config get/set` | Manage persistent config (default network, etc.) |
| `midnight localnet up/stop/down/status` | Manage a local Midnight network via Docker |
| `midnight help [command]` | Show usage for all or a specific command |

## Quick Start

```bash
# Generate a wallet
midnight generate --network preprod

# Check balance
midnight balance

# Transfer NIGHT
midnight transfer mn_addr_preprod1... 100

# Local devnet: start network, airdrop, register dust
midnight localnet up
midnight generate --network undeployed
midnight airdrop 1000
midnight dust register
```

## Supported Networks

| Network | Description |
|---------|-------------|
| `preprod` | Midnight pre-production testnet |
| `preview` | Midnight preview testnet |
| `undeployed` | Local devnet via Docker (`midnight localnet up`) |

## JSON Output for Automation

Every command supports `--json` for structured output:

```bash
midnight balance --json
# → {"address":"mn_addr_...","network":"undeployed","balances":{"NIGHT":"504.850000"},"utxoCount":2,"txCount":8}

midnight transfer mn_addr_... 100 --json
# → {"txHash":"00ab...","amount":100,"recipient":"mn_addr_...","network":"undeployed"}
```

When `--json` is active:
- stdout receives a single line of JSON
- stderr is fully suppressed (no spinners, no formatting)
- Errors produce: `{"error":true,"code":"...","message":"...","exitCode":N}`

Run `midnight help --json` for a full capability manifest, or `midnight help --agent` for a comprehensive AI agent reference.

## MCP Server for AI Agents

The package includes an MCP (Model Context Protocol) server that exposes all wallet operations as typed tools. AI agents call them directly via JSON-RPC over stdio — no shell spawning or output parsing needed.

### Claude Code

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "midnight-wallet": {
      "command": "npx",
      "args": ["-y", "midnight-wallet-cli@latest", "--mcp"]
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "midnight-wallet": {
      "command": "npx",
      "args": ["-y", "midnight-wallet-cli@latest", "--mcp"]
    }
  }
}
```

### Cursor

Create `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "midnight-wallet": {
      "command": "npx",
      "args": ["-y", "midnight-wallet-cli@latest", "--mcp"]
    }
  }
}
```

### VS Code (GitHub Copilot)

Create `.vscode/mcp.json` in your project root:

```json
{
  "servers": {
    "midnight-wallet": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "midnight-wallet-cli@latest", "--mcp"]
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "midnight-wallet": {
      "command": "npx",
      "args": ["-y", "midnight-wallet-cli@latest", "--mcp"]
    }
  }
}
```

> **Tip:** If you installed globally (`npm install -g midnight-wallet-cli`), you can use `"command": "midnight-wallet-mcp"` instead of the `npx` form.

### Available MCP Tools

Once connected, your AI agent gets access to 17 tools:

| Tool | Description |
|------|-------------|
| `midnight_generate` | Generate or restore a wallet |
| `midnight_info` | Show wallet info (no secrets) |
| `midnight_balance` | Check NIGHT balance |
| `midnight_address` | Derive address from seed |
| `midnight_genesis_address` | Show genesis wallet address |
| `midnight_inspect_cost` | Show block cost limits |
| `midnight_airdrop` | Fund wallet from genesis |
| `midnight_transfer` | Send NIGHT tokens |
| `midnight_dust_register` | Register UTXOs for dust generation |
| `midnight_dust_status` | Check dust status |
| `midnight_config_get` | Read config value |
| `midnight_config_set` | Write config value |
| `midnight_localnet_up` | Start local network |
| `midnight_localnet_stop` | Stop local network |
| `midnight_localnet_down` | Remove local network |
| `midnight_localnet_status` | Show service status |
| `midnight_localnet_clean` | Remove conflicting containers |

## Requirements

- Node.js >= 20
- Docker (for `midnight localnet` commands)
- A running proof server on `localhost:6300` (for transactions on local devnet)
