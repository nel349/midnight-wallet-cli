// Midnight Wallet CLI — MCP Server
// Exposes all CLI commands as MCP tools via stdio transport
// Launch: midnight-wallet-mcp (or: node dist/mcp-server.js)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { captureCommand } from './lib/run-command.ts';
import { classifyError, ERROR_CODES } from './lib/exit-codes.ts';
import type { ParsedArgs } from './lib/argv.ts';
import { PKG_VERSION } from './lib/pkg.ts';
import { createConfirmationStore } from './lib/mcp/confirmation.ts';

// Skill file — teaches MCP clients how to use this CLI conversationally.
// Exposed as an MCP resource so any client can fetch it via resources/read.
const SKILL_URI = 'midnight-wallet://skill';
const SKILL_PATH = fileURLToPath(new URL('../docs/SKILL.md', import.meta.url));

// ── Tool definitions ────────────────────────────────────────

interface ToolAnnotations {
  /** Tool does not modify state (safe to call without confirmation). */
  readOnlyHint?: boolean;
  /** Tool may perform destructive actions — moves funds, deletes files, tears down infra. */
  destructiveHint?: boolean;
  /** Repeated calls with same args yield the same result. */
  idempotentHint?: boolean;
  /** Tool touches the network / chain / external process (Docker, indexer, node). */
  openWorldHint?: boolean;
}

interface ToolDef {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
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
  'cache':           () => import('./commands/cache.ts'),
  'config':          () => import('./commands/config.ts'),
  'localnet':        () => import('./commands/localnet.ts'),
  'wallet':          () => import('./commands/wallet.ts'),
  'status':          () => import('./commands/status.ts'),
};

async function importHandler(name: string) {
  const loader = handlerLoaders[name];
  if (!loader) throw new Error(`Unknown command handler: ${name}`);
  const mod = await loader();
  return mod.default;
}

const TOOLS: ToolDef[] = [
  // midnight_generate (deprecated) removed from MCP surface — agents should use
  // midnight_wallet_generate. The CLI `mn generate` command still exists for humans.
  {
    name: 'midnight_wallet_generate',
    description: 'Create wallet.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        network: { type: 'string', enum: ['preprod', 'preview', 'undeployed'] },
        seed: { type: 'string', description: '64-char hex' },
        mnemonic: { type: 'string', description: 'BIP-39 24 words' },
        force: { type: 'string' },
      },
      required: ['name'],
    },
    async handler(params) {
      const name = params.name as string;
      const args = buildArgs('wallet', params, 'generate');
      args.positionals = [name];
      delete args.flags.name;
      if (params.force === 'true' || params.force === true) args.flags.force = true;
      const handler = await importHandler('wallet');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_wallet_list',
    description: 'List wallets.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async handler() {
      const args: ParsedArgs = {
        command: 'wallet',
        subcommand: 'list',
        positionals: [],
        flags: { json: true },
      };
      const handler = await importHandler('wallet');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_wallet_use',
    description: 'Set active wallet.',
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
    },
    async handler(params) {
      const name = params.name as string;
      const args: ParsedArgs = {
        command: 'wallet',
        subcommand: 'use',
        positionals: [name],
        flags: { json: true },
      };
      const handler = await importHandler('wallet');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_wallet_info',
    description: 'Show wallet details.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
    },
    async handler(params) {
      const name = params.name as string | undefined;
      const args: ParsedArgs = {
        command: 'wallet',
        subcommand: 'info',
        positionals: name ? [name] : [],
        flags: { json: true },
      };
      const handler = await importHandler('wallet');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_wallet_remove',
    description: 'Remove wallet.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
    },
    async handler(params) {
      const name = params.name as string;
      const args: ParsedArgs = {
        command: 'wallet',
        subcommand: 'remove',
        positionals: [name],
        flags: { json: true },
      };
      const handler = await importHandler('wallet');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_info',
    description: 'Wallet metadata.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        wallet: { type: 'string' },
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
    description: 'NIGHT balance.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        wallet: { type: 'string' },
        network: { type: 'string', enum: ['preprod', 'preview', 'undeployed'] },
        'indexer-ws': { type: 'string' },
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
    description: 'Derive address from seed.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        seed: { type: 'string', description: '64-char hex' },
        network: { type: 'string', enum: ['preprod', 'preview', 'undeployed'] },
        index: { type: 'string' },
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
    description: 'Genesis address.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        network: { type: 'string', enum: ['preprod', 'preview', 'undeployed'] },
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
    description: 'Block limits.',
    annotations: { readOnlyHint: true, idempotentHint: true },
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
    description: 'Fund from genesis (undeployed).',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'string', description: 'NIGHT' },
        wallet: { type: 'string' },
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
    description: 'Send NIGHT (returns pending token; see skill).',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'bech32m' },
        amount: { type: 'string', description: 'NIGHT' },
        wallet: { type: 'string' },
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
    description: 'Register for dust.',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        wallet: { type: 'string' },
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
    description: 'Dust status.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        wallet: { type: 'string' },
        'proof-server': { type: 'string' },
        node: { type: 'string' },
        'indexer-ws': { type: 'string' },
        'no-cache': { type: 'string' },
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
    description: 'Read config.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
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
    description: 'Write config.',
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
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
    name: 'midnight_cache_clear',
    description: 'Clear sync cache.',
    annotations: { destructiveHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        network: { type: 'string', enum: ['preprod', 'preview', 'undeployed'] },
        wallet: { type: 'string' },
      },
    },
    async handler(params) {
      const args = buildArgs('cache', params, 'clear');
      const handler = await importHandler('cache');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_config_unset',
    description: 'Reset config.',
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
      },
      required: ['key'],
    },
    async handler(params) {
      const key = params.key as string;
      const args: ParsedArgs = {
        command: 'config',
        subcommand: 'unset',
        positionals: [key],
        flags: { json: true },
      };
      const handler = await importHandler('config');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_localnet_up',
    description: 'Start localnet (Docker).',
    annotations: { openWorldHint: true },
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
    description: 'Stop localnet (preserves state).',
    annotations: { idempotentHint: true, openWorldHint: true },
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
    description: 'Localnet teardown (removes volumes).',
    annotations: { destructiveHint: true, openWorldHint: true },
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
    description: 'Localnet status.',
    annotations: { readOnlyHint: true, openWorldHint: true },
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
    description: 'Remove stray containers.',
    annotations: { destructiveHint: true, openWorldHint: true },
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
  // {
  //   name: 'midnight_status',
  //   description: 'Show Midnight network health — runs live probes and overlays canary monitoring data',
  //   inputSchema: {
  //     type: 'object',
  //     properties: {
  //       network: { type: 'string', description: 'Network to check: preprod, preview, undeployed', enum: ['preprod', 'preview', 'undeployed'] },
  //       all: { type: 'string', description: 'Set to "true" to show all networks' },
  //     },
  //   },
  //   async handler(params) {
  //     const args = buildArgs('status', params);
  //     if (params.all === 'true' || params.all === true) args.flags.all = true;
  //     const handler = await importHandler('status');
  //     return captureCommand(handler, args);
  //   },
  // },
  // status command disabled — currently being reworked

  {
    name: 'midnight_confirm_operation',
    description: 'Redeem a pending token (confirm step).',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string' },
      },
      required: ['token'],
    },
    async handler() {
      // Redemption is handled by the CallTool wrapper below — this handler
      // is only reached if the wrapper fails to intercept. Treat as a bug.
      throw new Error('midnight_confirm_operation reached the inner handler — this is an MCP wiring bug');
    },
  },
];

/**
 * Tools that require the two-step confirmation flow. On first call, we return
 * a pending token; the agent must call midnight_confirm_operation with the
 * token to actually execute.
 */
const REQUIRES_CONFIRMATION = new Set<string>(['midnight_transfer']);

const confirmationStore = createConfirmationStore();

function describePendingOp(tool: string, params: Record<string, unknown>): string {
  const network = (params.network as string | undefined) ?? 'active network';
  const wallet = (params.wallet as string | undefined) ?? 'active wallet';
  switch (tool) {
    case 'midnight_transfer':
      return `Send ${params.amount} NIGHT from ${wallet} to ${params.to} on ${network}`;
    default:
      return `Execute ${tool} with ${JSON.stringify(params)}`;
  }
}

// ── Server setup ────────────────────────────────────────────

const server = new Server(
  { name: 'midnight-wallet-cli', version: PKG_VERSION },
  { capabilities: { tools: {}, resources: {} } },
);

// ── Resource: skill file ───────────────────────────────────
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: SKILL_URI,
      name: 'midnight-wallet skill',
      description: 'Conversational guide for using midnight-wallet-cli. Read this first to learn intent routing, canonical flows, safety rules, and error recovery.',
      mimeType: 'text/markdown',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri !== SKILL_URI) {
    throw new Error(`Unknown resource: ${request.params.uri}`);
  }
  const text = readFileSync(SKILL_PATH, 'utf-8');
  return {
    contents: [{ uri: SKILL_URI, mimeType: 'text/markdown', text }],
  };
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawParams } = request.params;
  const params = (rawParams ?? {}) as Record<string, unknown>;

  // Step 2 of confirmation: redeem the token and execute the original tool.
  if (name === 'midnight_confirm_operation') {
    const token = typeof params.token === 'string' ? params.token : '';
    const pending = confirmationStore.redeem(token);
    if (!pending) {
      return errorResponse(new Error('Unknown or expired confirmation token. The first-step tool call may need to be re-issued.'));
    }
    return executeTool(pending.tool, pending.args);
  }

  // Step 1 of confirmation: return a pending token instead of executing.
  if (REQUIRES_CONFIRMATION.has(name)) {
    const pending = confirmationStore.create({
      tool: name,
      args: params,
      description: describePendingOp(name, params),
    });
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          pending: true,
          token: pending.token,
          description: pending.description,
          tool: pending.tool,
          expiresAt: new Date(pending.expiresAt).toISOString(),
          nextStep: 'Show the description to the user, get explicit consent, then call midnight_confirm_operation with this token.',
        }, null, 2),
      }],
    };
  }

  return executeTool(name, params);
});

async function executeTool(name: string, params: Record<string, unknown>) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return errorResponse(new Error(`Unknown tool: ${name}`));

  try {
    const result = await tool.handler(params);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return errorResponse(err instanceof Error ? err : new Error(String(err)));
  }
}

function errorResponse(error: Error) {
  const { errorCode } = classifyError(error);
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error: true, code: errorCode, message: error.message }),
    }],
    isError: true,
  };
}

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err.message}\n`);
  process.exit(1);
});
