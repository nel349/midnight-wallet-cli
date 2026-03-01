// Midnight Wallet CLI — MCP Server
// Exposes all CLI commands as MCP tools via stdio transport
// Launch: midnight-wallet-mcp (or: node dist/mcp-server.js)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';
import { captureCommand } from './lib/run-command.ts';
import { classifyError, ERROR_CODES } from './lib/exit-codes.ts';
import type { ParsedArgs } from './lib/argv.ts';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// ── Tool definitions ────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
  handler: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

// Helper: build ParsedArgs from MCP tool parameters
function buildArgs(
  command: string,
  params: Record<string, unknown>,
  subcommand?: string,
): ParsedArgs {
  const flags: Record<string, string | true> = { json: true };
  const positionals: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'boolean') {
      if (value) flags[key] = true;
    } else {
      flags[key] = String(value);
    }
  }

  return {
    command,
    subcommand,
    positionals,
    flags,
  };
}

// Lazy-import command handlers via static import() paths so bun can bundle them.
// Template-literal imports like `import('./commands/${name}.ts')` are not resolvable
// at build time, so each command is listed explicitly.
type CommandHandler = (args: ParsedArgs, signal?: AbortSignal) => Promise<void>;

const handlerLoaders: Record<string, () => Promise<{ default: CommandHandler }>> = {
  'generate':        () => import('./commands/generate.ts'),
  'info':            () => import('./commands/info.ts'),
  'balance':         () => import('./commands/balance.ts'),
  'address':         () => import('./commands/address.ts'),
  'genesis-address': () => import('./commands/genesis-address.ts'),
  'inspect-cost':    () => import('./commands/inspect-cost.ts'),
  'airdrop':         () => import('./commands/airdrop.ts'),
  'transfer':        () => import('./commands/transfer.ts'),
  'dust':            () => import('./commands/dust.ts'),
  'config':          () => import('./commands/config.ts'),
  'localnet':        () => import('./commands/localnet.ts'),
};

async function importHandler(name: string) {
  const loader = handlerLoaders[name];
  if (!loader) throw new Error(`Unknown command handler: ${name}`);
  const mod = await loader();
  return mod.default;
}

const TOOLS: ToolDef[] = [
  {
    name: 'midnight_generate',
    description: 'Generate a new wallet (random mnemonic, or restore from seed/mnemonic)',
    inputSchema: {
      type: 'object',
      properties: {
        network: { type: 'string', description: 'Network: preprod, preview, undeployed', enum: ['preprod', 'preview', 'undeployed'] },
        seed: { type: 'string', description: 'Restore from existing seed (64-char hex)' },
        mnemonic: { type: 'string', description: 'Restore from BIP-39 mnemonic (24 words)' },
        output: { type: 'string', description: 'Custom output path (default: ~/.midnight/wallet.json)' },
        force: { type: 'string', description: 'Set to "true" to overwrite existing wallet file' },
      },
    },
    async handler(params) {
      const args = buildArgs('generate', params);
      if (params.force === 'true' || params.force === true) args.flags.force = true;
      const handler = await importHandler('generate');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_info',
    description: 'Display wallet address, network, creation date (no secrets shown)',
    inputSchema: {
      type: 'object',
      properties: {
        wallet: { type: 'string', description: 'Custom wallet file path' },
      },
    },
    async handler(params) {
      const args = buildArgs('info', params);
      const handler = await importHandler('info');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_balance',
    description: 'Check unshielded balance via indexer subscription',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Address to check (or reads from wallet file)' },
        wallet: { type: 'string', description: 'Custom wallet file path' },
        network: { type: 'string', description: 'Override network detection', enum: ['preprod', 'preview', 'undeployed'] },
        'indexer-ws': { type: 'string', description: 'Custom indexer WebSocket URL' },
      },
    },
    async handler(params) {
      const address = params.address as string | undefined;
      const args = buildArgs('balance', params, address);
      // Remove address from flags since it's a positional (subcommand)
      delete args.flags.address;
      const handler = await importHandler('balance');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_address',
    description: 'Derive and display an unshielded address from a seed',
    inputSchema: {
      type: 'object',
      properties: {
        seed: { type: 'string', description: 'Seed to derive from (required, 64-char hex)' },
        network: { type: 'string', description: 'Network for address prefix', enum: ['preprod', 'preview', 'undeployed'] },
        index: { type: 'string', description: 'Key derivation index (default: 0)' },
      },
      required: ['seed'],
    },
    async handler(params) {
      const args = buildArgs('address', params);
      const handler = await importHandler('address');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_genesis_address',
    description: 'Display the genesis wallet address (seed 0x01) for a network',
    inputSchema: {
      type: 'object',
      properties: {
        network: { type: 'string', description: 'Network for address prefix', enum: ['preprod', 'preview', 'undeployed'] },
      },
    },
    async handler(params) {
      const args = buildArgs('genesis-address', params);
      const handler = await importHandler('genesis-address');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_inspect_cost',
    description: 'Display current block limits derived from LedgerParameters',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async handler() {
      const args = buildArgs('inspect-cost', {});
      const handler = await importHandler('inspect-cost');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_airdrop',
    description: 'Fund your wallet from the genesis wallet (undeployed network only)',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'string', description: 'Amount in NIGHT to airdrop' },
        wallet: { type: 'string', description: 'Custom wallet file path' },
      },
      required: ['amount'],
    },
    async handler(params) {
      const amount = params.amount as string;
      const args = buildArgs('airdrop', params, amount);
      delete args.flags.amount;
      const handler = await importHandler('airdrop');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_transfer',
    description: 'Send NIGHT tokens to another address',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient bech32m address' },
        amount: { type: 'string', description: 'Amount in NIGHT to send' },
        wallet: { type: 'string', description: 'Custom wallet file path' },
      },
      required: ['to', 'amount'],
    },
    async handler(params) {
      const to = params.to as string;
      const amount = params.amount as string;
      const args = buildArgs('transfer', params, to);
      args.positionals = [amount];
      delete args.flags.to;
      delete args.flags.amount;
      const handler = await importHandler('transfer');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_dust_register',
    description: 'Register NIGHT UTXOs for dust (fee token) generation',
    inputSchema: {
      type: 'object',
      properties: {
        wallet: { type: 'string', description: 'Custom wallet file path' },
      },
    },
    async handler(params) {
      const args = buildArgs('dust', params, 'register');
      const handler = await importHandler('dust');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_dust_status',
    description: 'Check dust registration status and balance',
    inputSchema: {
      type: 'object',
      properties: {
        wallet: { type: 'string', description: 'Custom wallet file path' },
      },
    },
    async handler(params) {
      const args = buildArgs('dust', params, 'status');
      const handler = await importHandler('dust');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_config_get',
    description: 'Read a persistent config value',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Config key to read (e.g. "network")' },
      },
      required: ['key'],
    },
    async handler(params) {
      const key = params.key as string;
      const args: ParsedArgs = {
        command: 'config',
        subcommand: 'get',
        positionals: [key],
        flags: { json: true },
      };
      const handler = await importHandler('config');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_config_set',
    description: 'Write a persistent config value',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Config key to set (e.g. "network")' },
        value: { type: 'string', description: 'Config value to set' },
      },
      required: ['key', 'value'],
    },
    async handler(params) {
      const key = params.key as string;
      const value = params.value as string;
      const args: ParsedArgs = {
        command: 'config',
        subcommand: 'set',
        positionals: [key, value],
        flags: { json: true },
      };
      const handler = await importHandler('config');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_localnet_up',
    description: 'Start a local Midnight network via Docker Compose',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async handler() {
      const args: ParsedArgs = {
        command: 'localnet',
        subcommand: 'up',
        positionals: [],
        flags: { json: true },
      };
      const handler = await importHandler('localnet');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_localnet_stop',
    description: 'Stop local network containers (preserves state for fast restart)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async handler() {
      const args: ParsedArgs = {
        command: 'localnet',
        subcommand: 'stop',
        positionals: [],
        flags: { json: true },
      };
      const handler = await importHandler('localnet');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_localnet_down',
    description: 'Remove local network containers, networks, and volumes (full teardown)',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async handler() {
      const args: ParsedArgs = {
        command: 'localnet',
        subcommand: 'down',
        positionals: [],
        flags: { json: true },
      };
      const handler = await importHandler('localnet');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_localnet_status',
    description: 'Show local network service status and ports',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async handler() {
      const args: ParsedArgs = {
        command: 'localnet',
        subcommand: 'status',
        positionals: [],
        flags: { json: true },
      };
      const handler = await importHandler('localnet');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_localnet_clean',
    description: 'Remove conflicting containers from other setups',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async handler() {
      const args: ParsedArgs = {
        command: 'localnet',
        subcommand: 'clean',
        positionals: [],
        flags: { json: true },
      };
      const handler = await importHandler('localnet');
      return captureCommand(handler, args);
    },
  },
];

// ── Server setup ────────────────────────────────────────────

const server = new Server(
  { name: 'midnight-wallet-cli', version: pkg.version },
  { capabilities: { tools: {} } },
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: params } = request.params;

  const tool = TOOLS.find(t => t.name === name);
  if (!tool) {
    return {
      content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    const result = await tool.handler(params ?? {});
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const { errorCode } = classifyError(error);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: true, code: errorCode, message: error.message }),
      }],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err.message}\n`);
  process.exit(1);
});
