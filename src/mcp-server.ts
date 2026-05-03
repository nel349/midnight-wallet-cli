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
import { trimAgentMessage } from './lib/error-trim.ts';
import { FULL_FLAG, type ParsedArgs } from './lib/argv.ts';
import { PKG_VERSION } from './lib/pkg.ts';
import { createConfirmationStore } from './lib/mcp/confirmation.ts';

// Skill resources — teach MCP clients how to use this CLI conversationally.
// Split into:
//   - /core: intent routing + safety rules. ~830 tokens. Fetch on session start.
//   - /full: canonical flows, error recovery, concept primers. ~2.3k tokens.
//           Fetch on demand (errors, multi-step flows, concept questions).
// The original `midnight-wallet://skill` URI stays as a deprecated alias for
// /full so existing MCP clients keep working.
const SKILL_CORE_URI = 'midnight-wallet://skill/core';
const SKILL_FULL_URI = 'midnight-wallet://skill/full';
const SKILL_LEGACY_URI = 'midnight-wallet://skill';
const SKILL_CORE_PATH = fileURLToPath(new URL('../docs/SKILL-CORE.md', import.meta.url));
const SKILL_FULL_PATH = fileURLToPath(new URL('../docs/SKILL.md', import.meta.url));

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
    // Standard agent escape hatch: an MCP arg of `full: true` means
    // "give me the human shape, not the slim agent shape". Translate to
    // the internal `_full` flag so handlers reading isMinimalMode pick
    // it up. No CLI command uses `--full` directly, so the rename is safe.
    const flagKey = key === 'full' ? FULL_FLAG : key;
    if (typeof value === 'boolean') {
      if (value) flags[flagKey] = true;
    } else {
      flags[flagKey] = String(value);
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
  'contract':        () => import('./commands/contract.ts'),
  'test':            () => import('./commands/test.ts'),
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
    description: 'List wallets. Default: per-wallet { name, active, network, address, shieldedAddress } scoped to the active network. Pass { full: true } for the 3-network addresses + shieldedAddresses maps.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        full: {
          type: 'boolean',
          description: 'Return full per-network addresses + shieldedAddresses maps (the same shape `mn wallet list --json` emits). Default false (slim).',
        },
      },
    },
    async handler({ full }: { full?: boolean } = {}) {
      const flags: Record<string, string | true> = { json: true };
      if (full) flags[FULL_FLAG] = true;
      const args: ParsedArgs = {
        command: 'wallet',
        subcommand: 'list',
        positionals: [],
        flags,
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
    description: 'Show wallet details. Default: { name, active, network, address, shieldedAddress } scoped to the active network. Pass { full: true } for the per-network maps + createdAt + file path.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        full: {
          type: 'boolean',
          description: 'Return the full per-network addresses + shieldedAddresses maps and bookkeeping fields (matches `mn wallet info <name> --json`). Default false (slim).',
        },
      },
    },
    async handler(params) {
      const name = params.name as string | undefined;
      const full = params.full as boolean | undefined;
      const flags: Record<string, string | true> = { json: true };
      if (full) flags[FULL_FLAG] = true;
      const args: ParsedArgs = {
        command: 'wallet',
        subcommand: 'info',
        positionals: name ? [name] : [],
        flags,
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
    description: 'NIGHT balance. Default: { network, unshielded, shielded } — no echoed addresses. Pass { full: true } for the human shape including address + shieldedAddress.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        wallet: { type: 'string' },
        network: { type: 'string', enum: ['preprod', 'preview', 'undeployed'] },
        'indexer-ws': { type: 'string' },
        full: {
          type: 'boolean',
          description: 'Include the queried address + shieldedAddress in the response (matches `mn balance --json`). Default false (slim).',
        },
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
    description: 'Dust status. Default: { network, registered, registeredUtxos, unregisteredUtxos, dustBalance, dustAvailable }. Pass { full: true } for sync internals (eventsApplied, ownedUtxos, cached).',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        wallet: { type: 'string' },
        'proof-server': { type: 'string' },
        node: { type: 'string' },
        'indexer-ws': { type: 'string' },
        'no-cache': { type: 'string' },
        full: {
          type: 'boolean',
          description: 'Include sync internals (eventsApplied, ownedUtxos, cached) in the response (matches `mn dust status --json`). Default false (slim).',
        },
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
    description: 'Localnet teardown (volumes + undeployed cache).',
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

  // ── Contract operations ──────────────────────────────────────────
  {
    name: 'midnight_contract_inspect',
    description: 'Inspect a compiled Compact contract: name, circuits (with arg/return types), witnesses, compiler/language/runtime versions. Reads managed/<name>/compiler/contract-info.json under the dapp dir. Returns a `siblings` array listing other contracts in the same project — call again with `name` to inspect a sibling.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to dApp directory (defaults to cwd)' },
        managed: { type: 'string', description: 'Direct path to a managed/<name>/ directory (overrides path)' },
        name: { type: 'string', description: 'Specific contract name to inspect when the project has multiple (see siblings field)' },
      },
    },
    async handler(params) {
      const args = buildArgs('contract', params, 'inspect');
      const handler = await importHandler('contract');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_contract_state',
    description: 'Read the current ledger state of a deployed contract. Returns the ledger fields as a JSON object.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Contract address (hex)' },
        wallet: { type: 'string' },
        network: { type: 'string', enum: ['preprod', 'preview', 'undeployed'] },
        path: { type: 'string', description: 'dApp directory (defaults to cwd; needed to find the compiled artifact for state decoding)' },
        managed: { type: 'string', description: 'Direct path to a managed/<name>/ directory (overrides path-based contract scan)' },
        name: { type: 'string', description: 'Specific contract name when the project has multiple' },
      },
      required: ['address'],
    },
    async handler(params) {
      const args = buildArgs('contract', params, 'state');
      const handler = await importHandler('contract');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_contract_deploy',
    description: 'Deploy a compiled Compact contract (returns pending token; agent must show the description and redeem via midnight_confirm_operation).',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        wallet: { type: 'string' },
        network: { type: 'string', enum: ['preprod', 'preview', 'undeployed'] },
        args: { type: 'string', description: 'JSON-encoded array or object of constructor arguments' },
        path: { type: 'string', description: 'dApp directory (defaults to cwd)' },
        managed: { type: 'string', description: 'Direct path to a managed/<name>/ directory (overrides path-based contract scan)' },
        name: { type: 'string', description: 'Specific contract name when the project has multiple' },
      },
    },
    async handler(params) {
      const args = buildArgs('contract', params, 'deploy');
      const handler = await importHandler('contract');
      return captureCommand(handler, args);
    },
  },
  {
    name: 'midnight_contract_call',
    description: 'Call a circuit on a deployed contract (returns pending token; agent must show the description and redeem via midnight_confirm_operation).',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Contract address (hex)' },
        circuit: { type: 'string', description: 'Circuit name to invoke' },
        wallet: { type: 'string' },
        network: { type: 'string', enum: ['preprod', 'preview', 'undeployed'] },
        args: { type: 'string', description: 'JSON-encoded array or object of circuit arguments' },
        path: { type: 'string', description: 'dApp directory (defaults to cwd)' },
        managed: { type: 'string', description: 'Direct path to a managed/<name>/ directory (overrides path-based contract scan)' },
        name: { type: 'string', description: 'Specific contract name when the project has multiple' },
      },
      required: ['address', 'circuit'],
    },
    async handler(params) {
      const args = buildArgs('contract', params, 'call');
      const handler = await importHandler('contract');
      return captureCommand(handler, args);
    },
  },

  // ── Test framework ───────────────────────────────────────────────
  {
    name: 'midnight_test_create',
    description: 'Generate a test scaffold for the contract. Two paths: (1) AI-assisted — pass `goal` (and optionally `screen` for UI strategy) and the scaffold is generated by Claude reading the contract + screen source, producing a focused suite with realistic args / on-screen labels. (2) Deterministic — pass `no-ai: true` (or omit goal/screen in non-interactive mode) for boilerplate scaffolds that the user reviews. CLI strategy emits dapp.test.json + tests/suites/<name>/{suite,actions,assertions}.json. Browser strategy emits prompt.md instead of actions.json plus the browser fields in dapp.test.json — required: port, build-cmd. Use force:true to overwrite.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'dApp directory (defaults to cwd)' },
        name: { type: 'string', description: 'Specific contract name when the project has multiple' },
        suite: { type: 'string', description: 'Suite directory name under tests/suites/ (auto-derived from circuit/screen when AI scaffolds)' },
        strategy: { type: 'string', enum: ['cli', 'browser'], description: 'cli (default): drive contracts via actions.json. browser: drive a real UI via Claude + Chrome via prompt.md.' },
        network: { type: 'string', enum: ['preprod', 'preview', 'undeployed'] },
        goal: { type: 'string', description: 'AI mode: one-line success criterion this suite should verify (e.g. "round goes from 0 to 1 after increment"). Triggers AI scaffolding.' },
        screen: { type: 'string', description: 'AI mode + browser strategy: name of the screen component to focus on (e.g. "loan-request-form" or "LoanRequestForm"). Auto-discovered from src/components, src/pages, src/screens.' },
        'no-ai': { type: 'boolean', description: 'Force deterministic scaffolder even when claude CLI is available.' },
        port: { type: 'string', description: 'Browser strategy only — dev server port (e.g. "4173").' },
        'build-cmd': { type: 'string', description: 'Browser strategy only — shell command that builds + serves the UI (e.g. "npm run dev").' },
        'build-dir': { type: 'string', description: 'Browser strategy only — subdir the build runs in (monorepo case).' },
        url: { type: 'string', description: 'Browser strategy only — full URL Claude opens (default http://localhost:<port>/).' },
        'browser-mode': { type: 'string', enum: ['dom', 'vision', 'script'], description: 'Browser strategy only — how Claude perceives the page. dom (HTML/React UIs, fast, needs chrome-devtools-mcp), vision (canvas games, slow), script (advanced, needs hooks). Default: dom for AI scaffolds.' },
        force: { type: 'boolean', description: 'Overwrite existing files instead of aborting on collision' },
      },
    },
    async handler(params) {
      const args = buildArgs('test', params, 'create');
      const handler = await importHandler('test');
      return captureCommand(handler, args);
    },
  },

  // ── Localnet logs ────────────────────────────────────────────────
  {
    name: 'midnight_localnet_logs',
    description: 'Snapshot of recent localnet logs (last N lines per service, no streaming). Returns { tail, lines: string[] }.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        tail: { type: 'string', description: 'Number of lines to retrieve (default 200)' },
      },
    },
    async handler(params) {
      const args = buildArgs('localnet', params, 'logs');
      // tail default: 200 if not specified by agent
      if (!args.flags.tail) args.flags.tail = '200';
      const handler = await importHandler('localnet');
      return captureCommand(handler, args);
    },
  },

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
const REQUIRES_CONFIRMATION = new Set<string>([
  'midnight_transfer',
  'midnight_contract_deploy',
  'midnight_contract_call',
]);

const confirmationStore = createConfirmationStore();

function describePendingOp(tool: string, params: Record<string, unknown>): string {
  const network = (params.network as string | undefined) ?? 'active network';
  const wallet = (params.wallet as string | undefined) ?? 'active wallet';
  switch (tool) {
    case 'midnight_transfer':
      return `Send ${params.amount} NIGHT from ${wallet} to ${params.to} on ${network}`;
    case 'midnight_contract_deploy': {
      const argsHint = params.args ? ` with args ${params.args}` : '';
      return `Deploy contract from ${params.path ?? 'current directory'} as ${wallet} on ${network}${argsHint}`;
    }
    case 'midnight_contract_call': {
      const argsHint = params.args ? ` with args ${params.args}` : '';
      return `Call circuit ${params.circuit} on contract ${params.address} as ${wallet} on ${network}${argsHint}`;
    }
    default:
      return `Execute ${tool} with ${JSON.stringify(params)}`;
  }
}

// ── Server setup ────────────────────────────────────────────

const server = new Server(
  { name: 'midnight-wallet-cli', version: PKG_VERSION },
  { capabilities: { tools: {}, resources: {} } },
);

// ── Resources: skill files (core + full + deprecated alias) ───
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: SKILL_CORE_URI,
      name: 'midnight-wallet skill (core)',
      description: 'Read this first. Intent routing table + non-negotiable safety rules. ~830 tokens. Fetch /full on demand for canonical flows, error recovery, and concept primers.',
      mimeType: 'text/markdown',
    },
    {
      uri: SKILL_FULL_URI,
      name: 'midnight-wallet skill (full)',
      description: 'Canonical multi-step flows, error-recovery recipes, concept primers (NIGHT/DUST/shielded), network selection. Fetch on demand when you hit an error, start a multi-step flow, or need to explain a concept.',
      mimeType: 'text/markdown',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  if (uri === SKILL_CORE_URI) {
    const text = readFileSync(SKILL_CORE_PATH, 'utf-8');
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }
  // Legacy `midnight-wallet://skill` aliases to /full so existing clients keep
  // working. Not advertised in resources/list — new clients should use
  // /core + /full explicitly.
  if (uri === SKILL_FULL_URI || uri === SKILL_LEGACY_URI) {
    const text = readFileSync(SKILL_FULL_PATH, 'utf-8');
    return { contents: [{ uri, mimeType: 'text/markdown', text }] };
  }
  throw new Error(`Unknown resource: ${uri}`);
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
        text: JSON.stringify(stamp({
          pending: true,
          token: pending.token,
          description: pending.description,
          tool: pending.tool,
          expiresAt: new Date(pending.expiresAt).toISOString(),
          nextStep: 'Show the description to the user, get explicit consent, then call midnight_confirm_operation with this token.',
        }), null, 2),
      }],
    };
  }

  return executeTool(name, params);
});

/**
 * Stamp every MCP response with the server's PKG_VERSION so callers can
 * detect a stale server (CLI on disk says X, MCP responses say Y → restart
 * the MCP client). Underscore prefix marks it as metadata, distinct from
 * tool-shape data fields.
 */
function stamp<T extends Record<string, unknown>>(payload: T): T & { _serverVersion: string } {
  return { ...payload, _serverVersion: PKG_VERSION };
}

async function executeTool(name: string, params: Record<string, unknown>) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return errorResponse(new Error(`Unknown tool: ${name}`));

  try {
    const result = await tool.handler(params);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(stamp(result), null, 2) }],
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
      text: JSON.stringify(stamp({ error: true, code: errorCode, message: trimAgentMessage(error.message) })),
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
