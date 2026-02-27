// help command — show usage for all commands or a specific command
// Logo animation on stderr, command table on stdout

import { type ParsedArgs } from '../lib/argv.ts';
import { bold, teal, gray, dim } from '../ui/colors.ts';
import { header, divider } from '../ui/format.ts';
import { animateMaterialize } from '../ui/animate.ts';

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
    usage: 'wallet generate [--network <name>] [--seed <hex>] [--mnemonic "..."] [--output <file>] [--force]',
    flags: [
      '--network <name>    Network: preprod, preview, undeployed',
      '--seed <hex>        Restore from existing seed (64-char hex)',
      '--mnemonic "..."    Restore from BIP-39 mnemonic (24 words)',
      '--output <file>     Custom output path (default: ~/.midnight/wallet.json)',
      '--force             Overwrite existing wallet file',
    ],
    examples: [
      'wallet generate --network preprod',
      'wallet generate --network preprod --output my-wallet.json',
      'wallet generate --seed 0123456789abcdef...',
    ],
  },
  {
    name: 'info',
    description: 'Display wallet address, network, creation date (no secrets shown)',
    usage: 'wallet info [--wallet <file>]',
    flags: [
      '--wallet <file>     Custom wallet file path',
    ],
    examples: [
      'wallet info',
      'wallet info --wallet my-wallet.json',
    ],
  },
  {
    name: 'balance',
    description: 'Check unshielded balance via GraphQL subscription',
    usage: 'wallet balance [address] [--network <name>] [--indexer-ws <url>]',
    flags: [
      '<address>           Address to check (or reads from wallet file)',
      '--network <name>    Override network detection',
      '--indexer-ws <url>  Custom indexer WebSocket URL',
    ],
    examples: [
      'wallet balance',
      'wallet balance mn_addr_preprod1...',
      'wallet balance --network preprod',
    ],
  },
  {
    name: 'address',
    description: 'Derive and display an unshielded address from a seed',
    usage: 'wallet address --seed <hex> [--network <name>] [--index <n>]',
    flags: [
      '--seed <hex>        Seed to derive from (required, 64-char hex)',
      '--network <name>    Network for address prefix (default: resolved)',
      '--index <n>         Key derivation index (default: 0)',
    ],
    examples: [
      'wallet address --seed 0123456789abcdef... --network preprod',
      'wallet address --seed 0123456789abcdef... --index 1',
    ],
  },
  {
    name: 'genesis-address',
    description: 'Display the genesis wallet address (seed 0x01) for a network',
    usage: 'wallet genesis-address [--network <name>]',
    flags: [
      '--network <name>    Network for address prefix (default: resolved)',
    ],
    examples: [
      'wallet genesis-address --network undeployed',
      'wallet genesis-address --network preprod',
    ],
  },
  {
    name: 'inspect-cost',
    description: 'Display current block limits derived from LedgerParameters',
    usage: 'wallet inspect-cost',
    examples: [
      'wallet inspect-cost',
    ],
  },
  {
    name: 'config',
    description: 'Manage persistent config (default network, etc.)',
    usage: 'wallet config <get|set> <key> [value]',
    flags: [
      'get <key>           Read a config value',
      'set <key> <value>   Write a config value',
    ],
    examples: [
      'wallet config get network',
      'wallet config set network preprod',
    ],
  },
  {
    name: 'help',
    description: 'Show usage for all commands or a specific command',
    usage: 'wallet help [command]',
    examples: [
      'wallet help',
      'wallet help balance',
    ],
  },
];

function printCommandTable(): void {
  process.stdout.write('\n' + header('Commands') + '\n\n');

  for (const spec of COMMAND_SPECS) {
    const name = teal(spec.name.padEnd(18));
    process.stdout.write(`  ${name}${spec.description}\n`);
  }

  process.stdout.write('\n' + dim(`Run ${bold('wallet help <command>')} for detailed usage.`) + '\n\n');
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

  // General help: logo animation + command table
  await animateMaterialize();
  process.stderr.write('\n');
  printCommandTable();
}

export { COMMAND_SPECS };
