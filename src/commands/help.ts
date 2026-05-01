// help command — show usage for all commands or a specific command
// Horizontal layout: logo on left, commands on right (all on stderr)
// Agent-friendly: plain text when piped (non-TTY)
// JSON mode: outputs capability manifest for agent self-discovery

import { type ParsedArgs, hasFlag } from '../lib/argv.ts';
import { bold, teal, gray, dim } from '../ui/colors.ts';
import { header } from '../ui/format.ts';
import { animateMaterialize } from '../ui/animate.ts';
import { COMMAND_BRIEFS, WORDMARK_BIG } from '../ui/art.ts';
import { hasShownIntroThisSession, markIntroShown } from '../lib/intro-marker.ts';
import { writeJsonResult } from '../lib/json-output.ts';
import { PKG_NAME, PKG_VERSION, PKG_DESCRIPTION } from '../lib/pkg.ts';

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
    name: 'wallet',
    description: 'Manage named wallets (generate, list, use, info, remove, seed)',
    usage: 'midnight wallet <generate|list|use|info|remove|seed> [args]',
    flags: [
      'generate <name>     Create a new named wallet and set it as active',
      'list                Show all wallets with active marker',
      'use <name>          Set active wallet',
      'info [name]         Show wallet details (active wallet if no name)',
      'remove <name>       Delete a wallet (refuses active or last wallet)',
      'seed [name]         Reveal the seed + mnemonic (prompts for confirmation)',
      '',
      'generate flags:',
      '--network <name>    Network: preprod, preview, undeployed',
      '--seed <hex>        Restore from existing seed (64-char hex)',
      '--mnemonic "..."    Restore from BIP-39 mnemonic (24 words)',
      '--force             Overwrite existing wallet file',
      '',
      'seed flags:',
      '--entropy           Also output the 32-byte BIP-39 entropy alongside the',
      '                    64-byte PBKDF2 seed (use when another tool expects',
      '                    the shorter entropy format — NB: the two derive',
      '                    DIFFERENT Midnight wallets from the same mnemonic)',
      '--json              Print JSON (skips interactive confirmation)',
    ],
    examples: [
      'midnight wallet generate alice --network preprod',
      'midnight wallet list',
      'midnight wallet use alice',
      'midnight wallet info alice',
      'midnight wallet remove bob',
      'midnight wallet seed alice --entropy',
    ],
    jsonFields: {
      name: 'Wallet name',
      address: 'Wallet address (bech32m)',
      network: 'Network name',
      active: 'Whether this is the active wallet',
      wallets: 'Array of wallet info objects (list only)',
    },
  },
  {
    name: 'generate',
    description: '(Deprecated — use "midnight wallet generate <name>" instead)',
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
    usage: 'midnight info [--wallet <name|file>]',
    flags: [
      '--wallet <name|file> Wallet name or path',
    ],
    examples: [
      'midnight info',
      'midnight info --wallet my-wallet.json',
    ],
    jsonFields: {
      addresses: 'Per-network unshielded addresses { preprod, preview, undeployed }',
      shieldedAddresses: 'Per-network shielded addresses { preprod, preview, undeployed }',
      activeNetwork: 'Currently active network',
      activeAddress: 'Unshielded address for active network (also written to stdout)',
      createdAt: 'ISO 8601 creation timestamp',
      file: 'Wallet file path',
    },
  },
  {
    name: 'balance',
    description: 'Check unshielded + shielded balance (full wallet sync)',
    usage: 'midnight balance [address] [--network <name>] [--indexer-ws <url>]',
    flags: [
      '<address>           Check a specific address (unshielded only, no wallet sync)',
      '--network <name>    Override network',
      '--indexer-ws <url>  Custom indexer WebSocket URL',
    ],
    examples: [
      'midnight balance',
      'midnight balance mn_addr_preprod1...',
    ],
    jsonFields: {
      address: 'Unshielded address (bech32m)',
      shieldedAddress: 'Shielded address',
      network: 'Network name',
      unshielded: '{ NIGHT, utxoCount }',
      shielded: '{ NIGHT, availableCoins, pendingCoins }',
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
    usage: 'midnight airdrop <amount> [--shielded] [--wallet <name|file>]',
    flags: [
      '<amount>            Amount in NIGHT to airdrop',
      '--shielded          Airdrop shielded NIGHT (from genesis shielded balance)',
      '--wallet <name|file> Wallet name or path',
    ],
    examples: [
      'midnight airdrop 1000',
      'midnight airdrop 100 --shielded',
    ],
    jsonFields: {
      txHash: 'Transaction hash',
      amount: 'Amount airdropped (NIGHT string)',
      recipient: 'Recipient address (unshielded airdrop)',
      shieldedAddress: 'Shielded address (--shielded airdrop)',
      network: 'Network name',
    },
  },
  {
    name: 'transfer',
    description: 'Send NIGHT tokens to another address (unshielded or --shielded)',
    usage: 'midnight transfer <to> <amount> [--shielded] [--wallet <name|file>] [--proof-server <url>] [--node <url>] [--indexer-ws <url>]',
    flags: [
      '<to>                Recipient bech32m address (unshielded or shielded)',
      '<amount>            Amount in NIGHT to send',
      '--shielded          Send from shielded balance to a shielded address',
      '--wallet <name|file> Wallet name or path',
      '--proof-server <url>  Override proof server URL',
      '--node <url>          Override substrate node RPC URL',
      '--indexer-ws <url>    Override indexer WebSocket URL',
    ],
    examples: [
      'midnight transfer mn_addr_undeployed1... 100',
      'midnight transfer mn_shield-addr_undeployed1... 50 --shielded',
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
    usage: 'midnight dust <register|status> [--wallet <name|file>] [--proof-server <url>] [--node <url>] [--indexer-ws <url>] [--no-cache (status only)]',
    flags: [
      'register            Register NIGHT UTXOs for dust generation',
      'status              Check dust registration; if registered, also shows dust balance',
      '--wallet <name|file> Wallet name or path',
      '--proof-server <url>  Override proof server URL (register only)',
      '--node <url>          Override substrate node RPC URL (register only)',
      '--indexer-ws <url>    Override indexer WebSocket URL',
      '--no-cache            Bypass wallet state cache (status only)',
    ],
    examples: [
      'midnight dust register',
      'midnight dust status',
    ],
    jsonFields: {
      subcommand: 'register or status',
      registered: 'true if at least one NIGHT UTXO is registered for dust generation (status only)',
      registeredUtxos: 'Number of registered UTXOs (status only)',
      unregisteredUtxos: 'Number of unregistered UTXOs (status only)',
      dustBalance: 'Dust balance (raw bigint string; status only when registered, and register)',
      nightBalance: 'NIGHT balance (raw bigint string; status only when registered)',
      dustAvailable: 'Whether dust tokens are available (status only when registered)',
      txHash: 'Registration transaction hash (register only, if submitted)',
    },
  },
  {
    name: 'config',
    description: 'Manage persistent config (default network, endpoints, etc.)',
    usage: 'midnight config <get|set|unset> <key> [value]',
    flags: [
      'get <key>           Read a config value',
      'set <key> <value>   Write a config value',
      'unset <key>         Reset a config value to its default',
      '',
      'Keys: network, wallet, proof-server, node, indexer-ws',
    ],
    examples: [
      'midnight config get network',
      'midnight config set network preprod',
      'midnight config set wallet alice',
      'midnight config set proof-server http://localhost:6300',
      'midnight config set node wss://rpc.preprod.midnight.network',
      'midnight config set indexer-ws wss://indexer.preprod.midnight.network/api/v3/graphql/ws',
      'midnight config unset proof-server',
    ],
    jsonFields: {
      action: 'get, set, or unset',
      key: 'Config key name',
      value: 'Config value',
    },
  },
  {
    name: 'cache',
    description: 'Manage wallet state cache (clear cached sync data)',
    usage: 'midnight cache clear [--network <name>] [--wallet <name|file>]',
    flags: [
      'clear               Clear cached wallet state',
      '--network <name>    Only clear cache for this network',
      '--wallet <name|file> Only clear cache for this wallet',
    ],
    examples: [
      'midnight cache clear',
      'midnight cache clear --network preprod',
      'midnight cache clear --wallet alice',
    ],
    jsonFields: {
      action: 'clear',
      scope: 'all, network, or wallet',
      network: 'Network name (when scoped)',
      wallet: 'Wallet name (when scoped)',
    },
  },
  {
    name: 'serve',
    description: 'Start DApp Connector server over WebSocket JSON-RPC',
    usage: 'midnight serve [--port <n>] [--wallet <name|file>] [--network <name>] [--proof-server <url>] [--node <url>] [--indexer-ws <url>] [--approve-all] [--no-auto-approve-reads] [--json]',
    flags: [
      '--port <n>                    Server port (default: 9932)',
      '--wallet <name|file>          Wallet name or path',
      '--network <name>              Override network detection',
      '--proof-server <url>          Override proof server URL',
      '--node <url>                  Override substrate node RPC URL',
      '--indexer-ws <url>            Override indexer WebSocket URL',
      '--approve-all                 Auto-approve all requests (reads + writes)',
      '--no-auto-approve-reads       Prompt for read methods too',
    ],
    examples: [
      'midnight serve',
      'midnight serve --port 8080',
      'midnight serve --approve-all',
    ],
    jsonFields: {
      port: 'Server port number',
      network: 'Network name',
      address: 'Wallet address (bech32m)',
      status: 'Server status (listening)',
    },
  },
  {
    name: 'test',
    description: 'Run E2E tests for Midnight dApps',
    usage: 'midnight test <run|list|results> [--suite <name>] [--json]',
    flags: [
      'run                           Run test suites for the current dApp',
      'list                          List available test suites',
      'results                       Show latest test results',
      '--suite <name>                Select a specific test suite',
      '--all                         Show all results (with results subcommand)',
      '--json                        Output structured JSON',
    ],
    examples: [
      'midnight test run',
      'midnight test run --suite e2e-gameplay',
      'midnight test list',
      'midnight test results',
      'midnight test results --all --json',
    ],
    jsonFields: {
      dapp: 'DApp name from dapp.test.json',
      suite: 'Test suite name',
      status: 'Overall result: pass, fail, timeout, or error',
      duration: 'Total duration in seconds',
      prep: 'Array of prep step results',
      assertions: 'Array of assertion results',
    },
  },
  {
    name: 'dev',
    description: 'Iteration loop for Compact contract development (localnet + compile-on-save + one-key deploy)',
    usage: 'midnight dev [path]',
    flags: [
      '[path]          Project directory (default: cwd)',
      '',
      'Keystrokes (while running):',
      '  d             Deploy the current compiled artifact (dev-alice on undeployed)',
      '  t             Run the project\'s npm test script (test:dev preferred, then test)',
      '  q             Quit cleanly',
      '  Ctrl+C        Quit cleanly',
    ],
    examples: [
      'midnight dev',
      'midnight dev ./contract',
    ],
  },
  {
    name: 'contract',
    description: 'Inspect, deploy, call, and query Midnight smart contracts',
    usage: 'midnight contract <inspect|deploy|call|state> [options]',
    flags: [
      'inspect                       Show circuits, witnesses, and types',
      'deploy                        Deploy a contract to the network',
      'call                          Call a circuit on a deployed contract',
      'state                         Read ledger state of a deployed contract',
      '--address <addr>              Contract address (call, state)',
      '--circuit <name>              Circuit to call (call)',
      '--args \'<json>\'               JSON arguments — constructor args (deploy) or circuit args (call)',
      '--network <name>              Override network (default: undeployed)',
      '--path <dir>                  Path to dApp directory (inspect)',
      '--managed <dir>               Direct path to managed/<name> directory (inspect)',
      '--json                        Output structured JSON',
    ],
    examples: [
      'midnight contract inspect',
      'midnight contract deploy',
      'midnight contract deploy --args \'{"deadlineSecs": 300}\'',
      'midnight contract call --address 0x123 --circuit submit_score --args \'{"score": 100, "alias": "TEST"}\'',
      'midnight contract state --address 0x123',
      'midnight contract deploy --json',
    ],
    jsonFields: {
      name: 'Contract name',
      address: 'Deployed contract address (deploy, call)',
      compilerVersion: 'Compact compiler version (inspect)',
      circuits: 'Array of circuit definitions (inspect)',
      witnesses: 'Array of witness definitions (inspect)',
      state: 'Contract ledger state (state)',
    },
  },
  {
    name: 'localnet',
    description: 'Manage a local Midnight network via Docker Compose',
    usage: 'midnight localnet <up|stop|down|status|logs|clean>',
    flags: [
      'up              Start the local network (node, indexer, proof server)',
      'stop            Stop containers (preserves state for fast restart)',
      'down            Full teardown: containers, networks, volumes, + undeployed wallet cache',
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
  // {
  //   name: 'status',
  //   description: 'Show Midnight network health (from canary monitoring)',
  //   usage: 'midnight status [--network <name>] [--all] [--json] [--watch]',
  //   flags: [
  //     '--network <name>    Show status for a specific network (default: wallet network or preprod)',
  //     '--all               Show all networks side by side',
  //     '--watch             Refresh every 30s',
  //   ],
  //   examples: [
  //     'midnight status',
  //     'midnight status --network preview',
  //     'midnight status --all',
  //     'midnight status --json',
  //     'midnight status --watch',
  //   ],
  //   jsonFields: {
  //     lastUpdated: 'ISO 8601 timestamp of last canary run',
  //     dashboard: 'Dashboard URL',
  //     networks: 'Per-network service health (overall + services)',
  //     issues: 'Known issues filtered by network',
  //   },
  // },
  // status command disabled — currently being reworked
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

// Build the right column: wordmark (lines 0-2), blank, then commands
function buildRightColumn(): string[] {
  const lines: string[] = [];
  // Lines 0-2: big wordmark (animated by animateMaterialize)
  for (const wl of WORDMARK_BIG) {
    lines.push(wl);
  }
  // Line 3: blank
  lines.push('');
  // Line 4: header
  lines.push(bold('Commands'));
  // Lines 5+: command briefs
  for (const [name, brief] of COMMAND_BRIEFS) {
    lines.push(`${teal(name.padEnd(18))}${brief}`);
  }
  // Footer
  lines.push('');
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
  const manifest = {
    cli: {
      name: PKG_NAME,
      version: PKG_VERSION,
      description: PKG_DESCRIPTION,
      bin: ['midnight', 'mn'],
    },
    globalFlags: [
      { name: '--json', description: 'Output structured JSON to stdout (suppresses all stderr)' },
      { name: '--wallet <name|file>', description: 'Wallet name or path' },
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
  const manual = `
MIDNIGHT CLI — AI Agent & MCP Reference
========================================

Version: ${PKG_VERSION}

OVERVIEW
────────

midnight-wallet-cli (mn) is a standalone CLI wallet for the Midnight
blockchain. It manages wallets, balances, transfers (unshielded and
shielded), dust fees, a DApp connector server, contract inspection,
E2E testing, and a local devnet — all from the terminal.

Wallets are network-agnostic: one seed derives addresses for all three
networks (undeployed, preprod, preview). Network is chosen at runtime.

STRUCTURED JSON OUTPUT
──────────────────────

Every command supports --json. When passed:
  - stdout receives a single line of JSON
  - stderr is fully suppressed (no spinners, no formatting)
  - Errors: {"error":true,"code":"...","message":"...","exitCode":N}

Usage: midnight <command> [args] --json

CAPABILITY MANIFEST
───────────────────

  midnight help --json

Outputs a machine-readable manifest with all commands, flags,
examples, and JSON field schemas.

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

SHIELDED TRANSACTIONS
─────────────────────

Midnight supports private (shielded) transactions using zero-knowledge
proofs. The CLI provides full shielded support:

  Balance (shows both unshielded + shielded):
    midnight balance --json
    → { address, shieldedAddress, network,
        unshielded: { NIGHT, utxoCount },
        shielded: { NIGHT, availableCoins, pendingCoins } }

  Shielded airdrop (localnet only — genesis has 250M shielded NIGHT):
    midnight airdrop 100 --shielded --json
    → { txHash, amount, shieldedAddress, network, type: "shielded" }

  Shielded transfer (to shielded address or wallet name):
    midnight transfer alice 50 --shielded --json
    midnight transfer mn_shield-addr_... 50 --shielded --json
    → { txHash, amount, recipient, network, type: "shielded" }

  Positional address balance (unshielded only, fast GraphQL):
    midnight balance mn_addr_... --json
    → { address, network, balances, utxoCount, txCount }

Note: there is no self-shielding. Shielded coins come from receiving
transfers from wallets that already have shielded tokens.

WALLET NAME RESOLUTION
──────────────────────

Transfer commands accept wallet names instead of full addresses:

  midnight transfer alice 10           → resolves alice's unshielded address
  midnight transfer alice 10 --shielded → resolves alice's shielded address

Names are resolved from ~/.midnight/wallets/<name>.json. If the input
starts with mn_addr_ or mn_shield-addr_, it's used as an address directly.

DAPP CONNECTOR
──────────────

  midnight serve [--port 9932] [--approve-all] [--network name]

Starts a WebSocket JSON-RPC server implementing the Midnight
ConnectedAPI interface (same as the Lace browser wallet). Any DApp
can connect to it — no browser extension needed.

  - Port default: 9932, localhost only
  - Read operations: auto-approved
  - Write operations: terminal approval prompt (or --approve-all)
  - --no-auto-approve-reads: require approval for everything

DApp developers connect via the midnight-wallet-connector npm package:

  npm install midnight-wallet-connector

  import { createWalletClient } from 'midnight-wallet-connector';
  const wallet = await createWalletClient({
    url: 'ws://localhost:9932',
    networkId: 'Undeployed',  // or 'PreProd', 'Preview'
  });
  const balances = await wallet.getUnshieldedBalances();

Reference DApp: https://github.com/nel349/midnight-starship

SMART CONTRACTS
───────────────

Run these commands from the root of a dApp project that contains a
compiled Compact contract (managed/ directory with .js and .d.ts files).

  Inspect — show circuits, witnesses, types:
    midnight contract inspect [--path <dir>] [--json]
    → { name, compilerVersion, circuits: [...], witnesses: [...] }

  Deploy — deploy a contract to the network:
    midnight contract deploy [--network <name>] [--json]
    → { contractName, address, network }
    Requires: funded wallet with dust. Auto-starts mn serve if needed.

  Call — call a circuit on a deployed contract:
    midnight contract call --address <addr> --circuit <name> [--args '<json>'] [--json]
    → { contractName, circuit, address, network, status }
    Example: midnight contract call --address abc123... --circuit post --args '["Hello!"]'

  State — read ledger state of a deployed contract:
    midnight contract state --address <addr> [--network <name>] [--json]
    → { address, network, fields: { key: value }, maps: { key: { size } } }

  Full workflow example:
    cd my-dapp
    midnight contract inspect                    # see what circuits exist
    midnight contract deploy                     # deploy to localnet
    midnight contract call --address <addr> --circuit post --args '["Hello"]'
    midnight contract state --address <addr>     # read on-chain state

E2E TESTING
───────────

  midnight test run [--suite <name>] [--json]
  midnight test list [--json]
  midnight test results [--all] [--json]

Runs E2E tests for Midnight dApps defined in dapp.test.json. Includes
contract deployment, circuit calls, and state verification.

ERROR CODES
───────────

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

MCP SERVER
──────────

The CLI includes an MCP (Model Context Protocol) server for native
AI agent integration. Agents call typed tools directly via JSON-RPC
over stdio — no shell spawning or output parsing.

Setup:

  Claude Code (.mcp.json):
  { "mcpServers": { "midnight-wallet": { "command": "midnight-wallet-mcp" } } }

  CLI: claude mcp add --transport stdio midnight-wallet -- midnight-wallet-mcp

  Cursor (.cursor/mcp.json):
  { "mcpServers": { "midnight-wallet": { "command": "midnight-wallet-mcp" } } }

  VS Code (.vscode/mcp.json):
  { "servers": { "midnight-wallet": { "type": "stdio", "command": "midnight-wallet-mcp" } } }

If not installed globally, use "command": "npx" with
"args": ["-y", "midnight-wallet-cli@latest", "--mcp"].

AVAILABLE MCP TOOLS (25)
────────────────────────

  Wallet Management
  midnight_wallet_generate     Create a named wallet                                name
  midnight_wallet_list         List all wallets                                     —
  midnight_wallet_use          Set active wallet                                    name
  midnight_wallet_info         Show wallet details (incl. shielded address)         —
  midnight_wallet_remove       Remove a named wallet                                name
  midnight_generate            Generate or restore a wallet (deprecated)            —

  Balance & Info
  midnight_info                Display wallet metadata                              —
  midnight_balance             Check unshielded + shielded balance                  —
  midnight_address             Derive address from seed                             seed
  midnight_genesis_address     Genesis wallet address                               —
  midnight_inspect_cost        Display block cost limits                            —

  Transactions
  midnight_airdrop             Fund wallet from genesis (undeployed only)           amount
  midnight_transfer            Send NIGHT (two-step — returns pending token)        to, amount
  midnight_dust_register       Register UTXOs for dust generation                   —
  midnight_dust_status         Check dust balance and registration                  —

  Consent
  midnight_confirm_operation   Redeem a pending token returned by a destructive     token
                               tool (step 2 of the confirmation flow)

  Configuration
  midnight_config_get          Read a config value                                  key
  midnight_config_set          Write a config value                                 key, value
  midnight_config_unset        Reset a config value to default                      key
  midnight_cache_clear         Clear cached wallet sync state                       —

  Local Network
  midnight_localnet_up         Start local network (Docker)                         —
  midnight_localnet_stop       Stop local network (preserves state)                 —
  midnight_localnet_down       Full teardown (volumes + undeployed cache)           —
  midnight_localnet_status     Show service status and ports                        —
  midnight_localnet_clean      Remove conflicting containers                        —

Optional params shared by wallet tools: wallet, network.
All tools return JSON. Errors: {error, code, message}.

TOOL ANNOTATIONS (MCP safety hints)
───────────────────────────────────

Every tool carries MCP-spec annotations so clients can apply safety policy
without hardcoding per-tool rules:

  readOnlyHint      Safe to call without user consent (balance, info, list).
  destructiveHint   Moves funds, deletes files, or tears down infra — treat
                    as requiring user consent.
  idempotentHint    Repeated calls with same args yield the same result.
  openWorldHint     Touches the network / chain / Docker — can fail
                    non-deterministically.

TWO-STEP CONFIRMATION FLOW (midnight_transfer)
──────────────────────────────────────────────

midnight_transfer does NOT execute on the first call. It returns a pending
token that the agent must show to the user for consent, then redeem via
midnight_confirm_operation to actually execute.

  Call 1:  midnight_transfer({ to, amount, wallet, network })
           → { pending: true, token, description, expiresAt, nextStep }
  Show:    the description to the user verbatim.
  Call 2:  midnight_confirm_operation({ token })
           → actual transfer result (txHash, etc)

Tokens are single-use and expire after 5 minutes.

MCP RESOURCES (skill file)
──────────────────────────

The server exposes one MCP Resource:

  uri       midnight-wallet://skill
  name      midnight-wallet skill
  mimeType  text/markdown

Call resources/read on connect to fetch a conversational guide covering
intent routing, canonical flows, safety rules, and error recovery. Ground
responses in it instead of training-data guesses.

TYPICAL AGENT WORKFLOWS
───────────────────────

  Local development (undeployed):
  1. midnight_localnet_up          → Start node, indexer, proof server
  2. midnight_wallet_generate      → Create wallet (name: "alice")
  3. midnight_config_set           → Set network (key: "network", value: "undeployed")
  4. midnight_airdrop              → Fund wallet (amount: "1000")
  5. midnight_dust_register        → Register for fee tokens
  6. midnight_balance              → Check unshielded + shielded balance
  7. midnight_transfer             → Returns pending token + description
  8. (show description to user, get explicit consent)
  9. midnight_confirm_operation    → Redeem token → actual transfer runs
 10. midnight_dust_status          → Check remaining dust

  Shielded workflow:
  1. midnight_airdrop              → Fund shielded (amount: "100", shielded: "true")
  2. midnight_balance              → Shows both unshielded + shielded
  3. midnight_transfer             → Returns pending token for shielded send
  4. (show + consent) → midnight_confirm_operation

  Testnet (preprod/preview):
  1. midnight_wallet_generate      → Create wallet
  2. midnight_config_set           → Set network (key: "network", value: "preview")
  3. (fund via faucet: https://faucet.preview.midnight.network/)
  4. midnight_dust_register        → Register for fees
  5. midnight_balance              → Check balance
  6. midnight_transfer → midnight_confirm_operation → transfer

  Contract development (CLI only — not an MCP tool):
  Run "mn dev" in a Compact project. It auto-starts localnet, provisions
  3 funded wallets (dev-alice/dev-bob/dev-carol), compiles on save, and
  accepts a "d" keystroke to deploy the current artifact with dev-alice.
  See "mn help dev".

EXAMPLE CLI COMMANDS
────────────────────

  # Generate wallet (all 3 network addresses + seed)
  midnight wallet generate alice --json
  # → {"name":"alice","addresses":{...},"activeAddress":"mn_addr_...","activeNetwork":"undeployed","seed":"...","file":"..."}

  # Balance (full sync — unshielded + shielded)
  midnight balance --json
  # → {"address":"mn_addr_...","shieldedAddress":"mn_shield-addr_...","network":"undeployed","unshielded":{"NIGHT":"1000.000000","utxoCount":1},"shielded":{"NIGHT":"10.000000","availableCoins":1,"pendingCoins":0}}

  # Transfer by wallet name
  midnight transfer bob 100 --json
  # → {"txHash":"00ab...","amount":100,"recipient":"mn_addr_...","network":"undeployed"}

  # Shielded transfer
  midnight transfer bob 50 --shielded --json
  # → {"txHash":"00cd...","amount":50,"recipient":"mn_shield-addr_...","network":"undeployed","type":"shielded"}

  # Shielded airdrop (localnet only)
  midnight airdrop 100 --shielded --json
  # → {"txHash":"00ef...","amount":100,"shieldedAddress":"mn_shield-addr_...","network":"undeployed","type":"shielded"}

  # Contract inspection
  midnight contract inspect --json
  # → {"name":"bboard","compilerVersion":"0.30.0","circuits":[{"name":"post",...}],"witnesses":[...]}

  # Deploy contract (from dApp root directory)
  midnight contract deploy --json
  # → {"subcommand":"deploy","contractName":"bboard","address":"6cc5...","network":"undeployed"}

  # Call a circuit
  midnight contract call --address 6cc5... --circuit post --args '["Hello from CLI!"]' --json
  # → {"subcommand":"call","circuit":"post","status":"success"}

  # Read contract state
  midnight contract state --address 6cc5... --json
  # → {"subcommand":"state","fields":{"state":"1","message":"...","owner":"..."}}

  # Start DApp connector
  midnight serve --network preview --approve-all
  # DApps connect at ws://localhost:9932
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
  const rightColumn = buildRightColumn();

  // Cinematic logo materialize plays only on the first invocation in this
  // shell session. Follow-up calls render the same layout statically so
  // viewers who just want the help text are not made to wait.
  // Override with `--intro` to force the animation, `--no-intro` to skip it.
  const forceIntro = hasFlag(args, 'intro');
  const skipIntro = hasFlag(args, 'no-intro');
  const seen = hasShownIntroThisSession();
  const animated = forceIntro || (!skipIntro && !seen);

  await animateMaterialize(undefined, rightColumn, { animated });
  if (animated) markIntroShown();
}

export { COMMAND_SPECS };
export type { CommandSpec };
