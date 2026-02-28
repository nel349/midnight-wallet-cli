// help command — show usage for all commands or a specific command
// Horizontal layout: logo on left, commands on right (all on stderr)
// Agent-friendly: plain text when piped (non-TTY)

import { type ParsedArgs } from '../lib/argv.ts';
import { bold, teal, gray, dim } from '../ui/colors.ts';
import { header } from '../ui/format.ts';
import { animateMaterialize } from '../ui/animate.ts';
import { COMMAND_BRIEFS } from '../ui/art.ts';

interface CommandSpec {
  name: string;
  description: string;
  usage: string;
  flags?: string[];
  examples?: string[];
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
  },
  {
    name: 'inspect-cost',
    description: 'Display current block limits derived from LedgerParameters',
    usage: 'midnight inspect-cost',
    examples: [
      'midnight inspect-cost',
    ],
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
  },
  {
    name: 'help',
    description: 'Show usage for all commands or a specific command',
    usage: 'midnight help [command]',
    examples: [
      'midnight help',
      'midnight help balance',
    ],
  },
];

// Build the right-side lines for the horizontal layout (indices 0-10)
function buildSideContent(): string[] {
  const lines: string[] = [];
  // Line 0: header
  lines.push(bold('Commands'));
  // Lines 1-8: command briefs
  for (const [name, brief] of COMMAND_BRIEFS) {
    lines.push(`${teal(name.padEnd(18))}${brief}`);
  }
  // Line 9: blank (alongside last logo line)
  lines.push('');
  // Line 10: footer (alongside wordmark)
  lines.push(dim(`midnight (or mn) help <command>`));
  return lines;
}

// Plain text output for non-TTY / agent-friendly
function printPlainHelp(): void {
  process.stderr.write('\nCommands:\n\n');
  for (const [name, brief] of COMMAND_BRIEFS) {
    process.stderr.write(`  ${name.padEnd(18)}${brief}\n`);
  }
  process.stderr.write('\n  Usage: midnight <command> (or: mn <command>)\n\n');
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

export default async function helpCommand(args: ParsedArgs): Promise<void> {
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
