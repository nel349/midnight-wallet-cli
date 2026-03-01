// help command — show usage for all commands or a specific command
// Horizontal layout: logo on left, commands on right (all on stderr)
// Agent-friendly: plain text when piped (non-TTY)
// JSON mode: outputs capability manifest for agent self-discovery

import { createRequire } from 'node:module';
import { type ParsedArgs, hasFlag } from '../lib/argv.ts';
import { bold, teal, gray, dim } from '../ui/colors.ts';
import { header } from '../ui/format.ts';
import { animateMaterialize } from '../ui/animate.ts';
import { COMMAND_BRIEFS } from '../ui/art.ts';
import { writeJsonResult } from '../lib/json-output.ts';

interface CommandSpec {
  name: string;
  description: string;
  usage: string;
  flags?: string[];
  examples?: string[];
  jsonFields?: Record<string, string>;
}

const COMMAND_SPECS: CommandSpec[] = [
  {
    name: 'generate',
    description: 'Generate a new wallet (random mnemonic, or restore from seed/mnemonic)',
    usage: 'midnight generate [--network <name>] [--seed <hex>] [--mnemonic "..."] [--output <file>] [--force]',
    flags: [
      '--network <name>    Network: preprod, preview, undeployed',
      '--seed <hex>        Restore from existing seed (64-char hex)',
      '--mnemonic "..."    Restore from BIP-39 mnemonic (24 words)',
      '--output <file>     Custom output path (default: ~/.midnight/wallet.json)',
      '--force             Overwrite existing wallet file',
    ],
    examples: [
      'midnight generate --network preprod',
      'midnight generate --network preprod --output my-wallet.json',
      'midnight generate --seed 0123456789abcdef...',
    ],
    jsonFields: {
      address: 'Generated wallet address (bech32m)',
      network: 'Network name',
      seed: 'Hex-encoded 32-byte seed',
      mnemonic: 'BIP-39 mnemonic (24 words, only if generated or provided)',
      file: 'Path where wallet file was saved',
      createdAt: 'ISO 8601 creation timestamp',
    },
  },
  {
    name: 'info',
    description: 'Display wallet address, network, creation date (no secrets shown)',
    usage: 'midnight info [--wallet <file>]',
    flags: [
      '--wallet <file>     Custom wallet file path',
    ],
    examples: [
      'midnight info',
      'midnight info --wallet my-wallet.json',
    ],
    jsonFields: {
      address: 'Wallet address (bech32m)',
      network: 'Network name',
      createdAt: 'ISO 8601 creation timestamp',
      file: 'Wallet file path',
    },
  },
  {
    name: 'balance',
    description: 'Check unshielded balance via GraphQL subscription',
    usage: 'midnight balance [address] [--network <name>] [--indexer-ws <url>]',
    flags: [
      '<address>           Address to check (or reads from wallet file)',
      '--network <name>    Override network detection',
      '--indexer-ws <url>  Custom indexer WebSocket URL',
    ],
    examples: [
      'midnight balance',
      'midnight balance mn_addr_preprod1...',
      'midnight balance --network preprod',
    ],
    jsonFields: {
      address: 'Checked address (bech32m)',
      network: 'Network name',
      balances: 'Object mapping token type to balance string',
      utxoCount: 'Number of UTXOs',
      txCount: 'Number of transactions synced',
    },
  },
  {
    name: 'address',
    description: 'Derive and display an unshielded address from a seed',
    usage: 'midnight address --seed <hex> [--network <name>] [--index <n>]',
    flags: [
      '--seed <hex>        Seed to derive from (required, 64-char hex)',
      '--network <name>    Network for address prefix (default: resolved)',
      '--index <n>         Key derivation index (default: 0)',
    ],
    examples: [
      'midnight address --seed 0123456789abcdef... --network preprod',
      'midnight address --seed 0123456789abcdef... --index 1',
    ],
    jsonFields: {
      address: 'Derived address (bech32m)',
      network: 'Network name',
      index: 'Key derivation index',
      path: 'BIP-44 derivation path',
    },
  },
  {
    name: 'genesis-address',
    description: 'Display the genesis wallet address (seed 0x01) for a network',
    usage: 'midnight genesis-address [--network <name>]',
    flags: [
      '--network <name>    Network for address prefix (default: resolved)',
    ],
    examples: [
      'midnight genesis-address --network undeployed',
      'midnight genesis-address --network preprod',
    ],
    jsonFields: {
      address: 'Genesis wallet address (bech32m)',
      network: 'Network name',
    },
  },
  {
    name: 'inspect-cost',
    description: 'Display current block limits derived from LedgerParameters',
    usage: 'midnight inspect-cost',
    examples: [
      'midnight inspect-cost',
    ],
    jsonFields: {
      readTime: 'Read time limit (picoseconds)',
      computeTime: 'Compute time limit (picoseconds)',
      blockUsage: 'Block usage limit (bytes)',
      bytesWritten: 'Bytes written limit (bytes)',
      bytesChurned: 'Bytes churned limit (bytes)',
    },
  },
  {
    name: 'airdrop',
    description: 'Fund your wallet from the genesis wallet (undeployed network only)',
    usage: 'midnight airdrop <amount> [--wallet <file>]',
    flags: [
      '<amount>            Amount in NIGHT to airdrop',
      '--wallet <file>     Custom wallet file path',
    ],
    examples: [
      'midnight airdrop 1000',
      'midnight airdrop 0.5 --wallet my-wallet.json',
    ],
    jsonFields: {
      txHash: 'Transaction hash',
      amount: 'Amount airdropped (NIGHT string)',
      recipient: 'Recipient address (bech32m)',
      network: 'Network name',
    },
  },
  {
    name: 'transfer',
    description: 'Send NIGHT tokens to another address',
    usage: 'midnight transfer <to> <amount> [--wallet <file>]',
    flags: [
      '<to>                Recipient bech32m address',
      '<amount>            Amount in NIGHT to send',
      '--wallet <file>     Custom wallet file path',
    ],
    examples: [
      'midnight transfer mn_addr_undeployed1... 100',
      'midnight transfer mn_addr_preprod1... 50 --wallet my-wallet.json',
    ],
    jsonFields: {
      txHash: 'Transaction hash',
      amount: 'Amount transferred (NIGHT string)',
      recipient: 'Recipient address (bech32m)',
      network: 'Network name',
    },
  },
  {
    name: 'dust',
    description: 'Register UTXOs for dust (fee token) generation or check status',
    usage: 'midnight dust <register|status> [--wallet <file>]',
    flags: [
      'register            Register NIGHT UTXOs for dust generation',
      'status              Check dust registration status and balance',
      '--wallet <file>     Custom wallet file path',
    ],
    examples: [
      'midnight dust register',
      'midnight dust status',
    ],
    jsonFields: {
      subcommand: 'register or status',
      dustBalance: 'Dust balance (raw bigint string)',
      registered: 'Number of registered UTXOs (status only)',
      unregistered: 'Number of unregistered UTXOs (status only)',
      nightBalance: 'NIGHT balance (raw bigint string, status only)',
      dustAvailable: 'Whether dust tokens are available (status only)',
      txHash: 'Registration transaction hash (register only, if submitted)',
    },
  },
  {
    name: 'config',
    description: 'Manage persistent config (default network, etc.)',
    usage: 'midnight config <get|set> <key> [value]',
    flags: [
      'get <key>           Read a config value',
      'set <key> <value>   Write a config value',
    ],
    examples: [
      'midnight config get network',
      'midnight config set network preprod',
    ],
    jsonFields: {
      action: 'get or set',
      key: 'Config key name',
      value: 'Config value',
    },
  },
  {
    name: 'localnet',
    description: 'Manage a local Midnight network via Docker Compose',
    usage: 'midnight localnet <up|stop|down|status|logs|clean>',
    flags: [
      'up              Start the local network (node, indexer, proof server)',
      'stop            Stop containers (preserves state for fast restart)',
      'down            Remove containers, networks, and volumes (full teardown)',
      'status          Show service status and ports',
      'logs            Stream service logs (Ctrl+C to stop)',
      'clean           Remove conflicting containers from other setups',
    ],
    examples: [
      'midnight localnet up',
      'midnight localnet stop',
      'midnight localnet status',
      'midnight localnet down',
      'midnight localnet clean',
    ],
    jsonFields: {
      subcommand: 'up, stop, down, status, or clean',
      services: 'Array of { name, state, port, health? } (up/status only)',
      status: 'Operation result message (stop/down/clean)',
      removed: 'Array of removed container names (clean only)',
    },
  },
  {
    name: 'help',
    description: 'Show usage for all commands or a specific command',
    usage: 'midnight help [command]',
    examples: [
      'midnight help',
      'midnight help balance',
    ],
    jsonFields: {
      cli: 'CLI metadata (name, version, description)',
      globalFlags: 'Array of global flag descriptions',
      commands: 'Array of command specs with jsonFields',
    },
  },
];

// Build the right-side lines for the horizontal layout
function buildSideContent(): string[] {
  const lines: string[] = [];
  // Line 0: header
  lines.push(bold('Commands'));
  // Lines 1-12: command briefs
  for (const [name, brief] of COMMAND_BRIEFS) {
    lines.push(`${teal(name.padEnd(18))}${brief}`);
  }
  // Blank
  lines.push('');
  // Footer
  lines.push(dim(`midnight (or mn) help <command>`));
  lines.push(dim(`--json flag available on all commands`));
  lines.push(dim(`midnight help --agent`) + dim(`  AI & MCP reference`));
  return lines;
}

// Plain text output for non-TTY / agent-friendly
function printPlainHelp(): void {
  process.stderr.write('\nCommands:\n\n');
  for (const [name, brief] of COMMAND_BRIEFS) {
    process.stderr.write(`  ${name.padEnd(18)}${brief}\n`);
  }
  process.stderr.write('\n  Usage: midnight <command> (or: mn <command>)\n');
  process.stderr.write('  --json flag available on all commands\n');
  process.stderr.write('  midnight help --agent   AI & MCP reference\n\n');
}

function printCommandHelp(spec: CommandSpec): void {
  process.stdout.write('\n' + header(spec.name) + '\n\n');
  process.stdout.write(`  ${spec.description}\n\n`);
  process.stdout.write(gray('Usage:') + '\n');
  process.stdout.write(`  ${spec.usage}\n\n`);

  if (spec.flags && spec.flags.length > 0) {
    process.stdout.write(gray('Flags:') + '\n');
    for (const flag of spec.flags) {
      process.stdout.write(`  ${flag}\n`);
    }
    process.stdout.write('\n');
  }

  if (spec.examples && spec.examples.length > 0) {
    process.stdout.write(gray('Examples:') + '\n');
    for (const example of spec.examples) {
      process.stdout.write(`  ${dim('$')} ${example}\n`);
    }
    process.stdout.write('\n');
  }
}

function outputJsonManifest(): void {
  const require = createRequire(import.meta.url);
  const pkg = require('../../package.json');

  const manifest = {
    cli: {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      bin: ['midnight', 'mn'],
    },
    globalFlags: [
      { name: '--json', description: 'Output structured JSON to stdout (suppresses all stderr)' },
      { name: '--wallet <file>', description: 'Custom wallet file path' },
      { name: '--network <name>', description: 'Override network (preprod, preview, undeployed)' },
      { name: '--version, -v', description: 'Print CLI version' },
      { name: '--help, -h', description: 'Show help' },
    ],
    commands: COMMAND_SPECS.map(spec => ({
      name: spec.name,
      description: spec.description,
      usage: spec.usage,
      flags: spec.flags,
      examples: spec.examples,
      jsonFields: spec.jsonFields,
    })),
  };

  writeJsonResult(manifest);
}

function printAgentManual(): void {
  const require = createRequire(import.meta.url);
  const pkg = require('../../package.json');

  const manual = `
MIDNIGHT CLI — AI Agent & MCP Reference
========================================

Version: ${pkg.version}

STRUCTURED JSON OUTPUT
──────────────────────

Every command supports the --json flag. When passed:
  - stdout receives a single line of JSON
  - stderr is fully suppressed (no spinners, no formatting)
  - Errors produce JSON: {"error":true,"code":"...","message":"...","exitCode":N}

Usage: midnight <command> [args] --json

CAPABILITY MANIFEST
───────────────────

  midnight help --json

Outputs a machine-readable JSON manifest containing all commands,
their flags, examples, and expected JSON output fields. Use this
for programmatic discovery of CLI capabilities.

COMMANDS & JSON SCHEMAS
───────────────────────
${COMMAND_SPECS.filter(s => s.jsonFields).map(spec => {
  const fields = Object.entries(spec.jsonFields!)
    .map(([k, v]) => `    ${k.padEnd(20)}${v}`)
    .join('\n');
  return `
  ${spec.name}
  ${spec.usage}
  JSON fields:
${fields}`;
}).join('\n')}

ERROR CODES
───────────

When --json is active and an error occurs, the output is:
  {"error":true,"code":"<CODE>","message":"...","exitCode":N}

  Code                    Exit  Meaning
  INVALID_ARGS            2     Missing or invalid arguments
  WALLET_NOT_FOUND        3     Wallet file does not exist
  NETWORK_ERROR           4     Connection refused, timeout, DNS failure
  INSUFFICIENT_BALANCE    5     Not enough NIGHT for the operation
  TX_REJECTED             6     Transaction rejected by the node
  STALE_UTXO              6     UTXOs consumed by another transaction
  PROOF_TIMEOUT           6     ZK proof generation timed out
  DUST_REQUIRED           5     No dust tokens available for fees
  CANCELLED               7     Operation cancelled (SIGINT)
  UNKNOWN                 1     Unclassified error

EXIT CODES
──────────

  0   Success
  1   General error
  2   Invalid arguments / usage
  3   Wallet not found
  4   Network / connection error
  5   Insufficient balance
  6   Transaction rejected
  7   Operation cancelled (SIGINT)

MCP SERVER
──────────

The CLI includes an MCP (Model Context Protocol) server for native
AI agent integration. Instead of parsing CLI output, agents call
typed tools directly via JSON-RPC over stdio.

Add to your MCP config (.mcp.json, .cursor/mcp.json, etc.):

  {
    "mcpServers": {
      "midnight-wallet": {
        "command": "npx",
        "args": ["-y", "midnight-wallet-cli@latest", "--mcp"]
      }
    }
  }

Or if installed globally: "command": "midnight-wallet-mcp"

The MCP server exposes 17 tools covering all CLI commands
(excluding help and localnet logs which are not suitable for MCP).

EXAMPLE WORKFLOW
────────────────

  # 1. Generate a wallet
  midnight generate --network undeployed --json
  # → {"address":"mn_addr_...","network":"undeployed","seed":"...","mnemonic":"...","file":"...","createdAt":"..."}

  # 2. Check balance
  midnight balance --json
  # → {"address":"mn_addr_...","network":"undeployed","balances":{},"utxoCount":0,"txCount":0}

  # 3. Airdrop tokens (undeployed network)
  midnight airdrop 1000 --json
  # → {"txHash":"...","amount":"1000","recipient":"mn_addr_...","network":"undeployed"}

  # 4. Transfer tokens
  midnight transfer mn_addr_... 100 --json
  # → {"txHash":"...","amount":"100","recipient":"mn_addr_...","network":"undeployed"}
`;

  process.stdout.write(manual);
}

export default async function helpCommand(args: ParsedArgs): Promise<void> {
  // Agent manual: comprehensive reference for AI agents
  if (hasFlag(args, 'agent')) {
    printAgentManual();
    return;
  }

  // JSON mode: output capability manifest
  if (hasFlag(args, 'json')) {
    outputJsonManifest();
    return;
  }

  // Specific command help: wallet help <command>
  const targetCommand = args.subcommand;

  if (targetCommand) {
    const spec = COMMAND_SPECS.find(s => s.name === targetCommand);
    if (!spec) {
      throw new Error(
        `Unknown command: "${targetCommand}"\n` +
        `Available commands: ${COMMAND_SPECS.map(s => s.name).join(', ')}`
      );
    }
    printCommandHelp(spec);
    return;
  }

  // General help: horizontal layout (logo + commands side by side)
  if (!process.stderr.isTTY) {
    // Agent-friendly: plain text, no animation, no ANSI
    printPlainHelp();
    return;
  }
  const sideContent = buildSideContent();
  await animateMaterialize(undefined, sideContent);
}

export { COMMAND_SPECS };
export type { CommandSpec };
