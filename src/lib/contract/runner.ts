// Contract runner — execute contract operations in the dApp's own process context.
// Uses mn's serve RPC server for wallet operations (balance, sign, submit).
// The generated script only needs contract SDK + RPC client — no wallet SDK.

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NetworkConfig } from '../network.ts';
import { WITNESS_FILE_CANDIDATES } from './witness-discovery.ts';
import { coerceArg } from './arg-coerce.ts';

/**
 * Walk up from this module to find the closest `node_modules` directory.
 * The generated deploy/call script imports SDK packages by bare specifier
 * (`@midnight-ntwrk/midnight-js-contracts`, `ws`, etc.); without help, Node
 * resolves those against the user's project — which usually doesn't have them.
 *
 * NODE_PATH is documented as honored only by CommonJS resolution, not ESM.
 * Since the deploy script is ESM (.mjs), we instead write the script into a
 * temp dir that contains a `node_modules` symlink to ours. Node's normal
 * walk-up from the script's location then finds our SDK packages.
 */
function findOurNodeModules(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Bounded walk — node_modules should be a few levels up at most. Stop at
  // filesystem root.
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const OUR_NODE_MODULES = findOurNodeModules();

export interface RunnerOptions {
  dappDir: string;
  networkConfig: NetworkConfig;
  managedDir: string;
  contractName: string;
  servePort: number;
  onMessage?: (msg: string) => void;
}

export interface DeployOptions extends RunnerOptions {
  privateStateKey?: string;
  /**
   * Constructor arguments passed to the contract's `Constructor` (the WASM
   * function the SDK invokes during `deployContract`). Forwarded to
   * `deployContract({ args: [...] })`. Order matters — match the contract's
   * Compact `constructor(...)` signature.
   */
  args?: unknown[];
}

export interface CallOptions extends RunnerOptions {
  contractAddress: string;
  circuit: string;
  args?: unknown[];
  privateStateKey?: string;
}

export interface StateOptions {
  dappDir: string;
  networkConfig: NetworkConfig;
  managedDir: string;
  contractName: string;
  contractAddress: string;
  onMessage?: (msg: string) => void;
}

export interface DeployResult {
  contractAddress: string;
}

export interface CallResult {
  status: string;
  circuit: string;
}

export interface StateResult {
  fields: Record<string, string>;
  maps: Record<string, { size: string }>;
}

export async function runState(options: StateOptions): Promise<StateResult> {
  const script = generateStateScript(options);
  const result = await executeScript(options.dappDir, script, options.onMessage);
  try {
    return JSON.parse(result) as StateResult;
  } catch {
    throw new Error(`State script returned unexpected output:\n${result}`);
  }
}

export async function runDeploy(options: DeployOptions): Promise<DeployResult> {
  const script = generateDeployScript(options);
  const result = await executeScript(options.dappDir, script, options.onMessage);
  try {
    return JSON.parse(result) as DeployResult;
  } catch {
    throw new Error(`Deploy script returned unexpected output:\n${result}`);
  }
}

export async function runCall(options: CallOptions): Promise<CallResult> {
  const script = generateCallScript(options);
  const result = await executeScript(options.dappDir, script, options.onMessage);
  try {
    return JSON.parse(result) as CallResult;
  } catch {
    throw new Error(`Call script returned unexpected output:\n${result}`);
  }
}

// ── Shared script fragments ──

/** Minimal JSON-RPC client over WebSocket that talks to mn serve. */
function rpcClientCode(servePort: number): string {
  return `
import WebSocket from 'ws';

const RPC_URL = 'ws://127.0.0.1:${servePort}';
let rpcId = 0;
let rpcWs;

async function rpcConnect() {
  return new Promise((resolve, reject) => {
    rpcWs = new WebSocket(RPC_URL);
    rpcWs.on('open', () => resolve(rpcWs));
    rpcWs.on('error', (err) => reject(new Error('Cannot connect to mn serve at ' + RPC_URL + ': ' + err.message)));
    setTimeout(() => reject(new Error('Timeout connecting to mn serve at ' + RPC_URL)), 5000);
  });
}

function rpcCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    const timeout = setTimeout(() => reject(new Error('RPC timeout for ' + method)), 300000);

    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timeout);
          rpcWs.removeListener('message', handler);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch {}
    };

    rpcWs.on('message', handler);
    rpcWs.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

function rpcClose() {
  if (rpcWs) rpcWs.close();
}
`;
}

/** Build walletProvider that delegates to mn serve RPC. */
function walletProviderCode(): string {
  return `
// Wallet provider backed by mn serve RPC
const walletProvider = {
  getCoinPublicKey: () => {
    // Will be populated after getShieldedAddresses
    return walletState?.shieldedCoinPublicKey ?? '';
  },
  getEncryptionPublicKey: () => {
    return walletState?.shieldedEncryptionPublicKey ?? '';
  },
  async balanceTx(tx, ttl) {
    const { toHex } = await import('@midnight-ntwrk/midnight-js-utils');
    const txHex = toHex(tx.serialize());
    const result = await rpcCall('balanceUnsealedTransaction', { tx: txHex });

    const { fromHex } = await import('@midnight-ntwrk/midnight-js-utils');
    const { Transaction } = await import('@midnight-ntwrk/midnight-js-types');
    const bytes = fromHex(result.tx);
    return Transaction.deserialize('signature', 'proof', 'binding', bytes);
  },
  async submitTx(tx) {
    const { toHex } = await import('@midnight-ntwrk/midnight-js-utils');
    const txHex = toHex(tx.serialize());
    await rpcCall('submitTransaction', { tx: txHex });
    return tx.identifiers()[0];
  },
};

// Get wallet state for coin/encryption public keys
const walletState = await rpcCall('getShieldedAddresses', {});
`;
}

function contractSetupCode(contractName: string, managedDir: string): string {
  return `
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

const MANAGED_DIR = ${JSON.stringify(managedDir)};

// Load compiled contract class
const contractMod = await import(pathToFileURL(resolve(MANAGED_DIR, 'contract', 'index.js')).href);

// Try to load witnesses and private state factory.
// Both relative-to-cwd locations and contract/<...> locations are checked
// so mn dev (which chdirs into the contract sub-package) and mn contract
// deploy run from a workspace root both work.
const WITNESS_CANDIDATES = ${JSON.stringify(WITNESS_FILE_CANDIDATES)};
let witnesses;
let createPrivateState;
for (const p of WITNESS_CANDIDATES) {
  try {
    const wMod = await import(pathToFileURL(resolve(p)).href);
    if (wMod.witnesses) { witnesses = wMod.witnesses; }
    // Look for createInitialPrivateState or create*PrivateState
    for (const key of Object.keys(wMod)) {
      if (typeof wMod[key] === 'function' && key.startsWith('create') && key.toLowerCase().includes('privatestate')) {
        createPrivateState = wMod[key];
      }
    }
    if (witnesses) break;
  } catch {}
}

// Note: callers (commands/contract.ts, commands/dev.ts) preflight when the
// contract's compiler-info declares witnesses, so a missing module here means
// the contract truly has no witnesses (vacant is correct). The runtime
// warning still names every path we tried — useful when the SDK later
// complains about a specific witness name despite preflight passing.
if (!witnesses) {
  process.stderr.write('Warning: No witnesses module found — using vacant witnesses. Searched:\\n');
  for (const p of WITNESS_CANDIDATES) process.stderr.write('  - ' + p + '\\n');
}

// Generate initial private state.
// Uses a deterministic seed derived from the wallet so post/takeDown use the same key.
// The private state provider (leveldb) persists between calls, but initialPrivateState
// is the fallback when no stored state exists yet.
function makeInitialPrivateState() {
  if (createPrivateState) {
    // Derive a deterministic key from the wallet's coin public key.
    // This ensures post and takeDown always use the same secret key
    // for the same wallet, even across separate CLI invocations.
    const cpk = walletState?.shieldedCoinPublicKey ?? '';
    let secretKey;
    if (cpk && cpk.length >= 64) {
      // Use first 32 bytes of coin public key as seed
      secretKey = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        secretKey[i] = parseInt(cpk.substr(i * 2, 2), 16);
      }
    } else {
      // Fallback: random (will break takeDown if state isn't persisted)
      secretKey = new Uint8Array(32);
      globalThis.crypto.getRandomValues(secretKey);
    }
    try { return createPrivateState(secretKey); } catch {}
    try { return createPrivateState(); } catch {}
  }
  return {};
}

const compiled = witnesses
  ? CompiledContract.make(${JSON.stringify(contractName)}, contractMod.Contract).pipe(
      (c) => CompiledContract.withWitnesses(c, witnesses),
      (c) => CompiledContract.withCompiledFileAssets(c, MANAGED_DIR),
    )
  : CompiledContract.make(${JSON.stringify(contractName)}, contractMod.Contract).pipe(
      CompiledContract.withVacantWitnesses,
      (c) => CompiledContract.withCompiledFileAssets(c, MANAGED_DIR),
    );
`;
}

function providerSetupCode(managedDir: string, networkConfig: NetworkConfig, privateStateKey: string): string {
  return `
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';

const zkConfigProvider = new NodeZkConfigProvider(MANAGED_DIR);

const providers = {
  privateStateProvider: levelPrivateStateProvider({
    privateStateStoreName: ${JSON.stringify(privateStateKey)},
    privateStoragePasswordProvider: () => Promise.resolve('mn-contract-default-pwd-16ch'),
    accountId: 'mn-contract-runner',
  }),
  publicDataProvider: indexerPublicDataProvider(
    ${JSON.stringify(networkConfig.indexer)},
    ${JSON.stringify(networkConfig.indexerWS ?? networkConfig.indexer.replace('http', 'ws'))},
  ),
  zkConfigProvider,
  proofProvider: httpClientProofProvider(${JSON.stringify(networkConfig.proofServer)}, zkConfigProvider),
  walletProvider,
  midnightProvider: walletProvider,
};
`;
}

// ── Script generation ──

/**
 * Inline arg-coercion helper for the generated bridge script. Compact
 * circuits use only a small set of runtime types (BigInt for Uint, Uint8Array
 * for Bytes, primitives, plus structs of these), but JSON arg payloads —
 * coming from CLI `--args` flags or MCP `args` params — can only encode
 * numbers, strings, arrays, objects, and booleans. We coerce predictably:
 *
 *   - number              → BigInt              (Uint<N> circuit args within
 *                                                Number.MAX_SAFE_INTEGER)
 *   - "123n"              → BigInt(123)         (BigInt literal syntax — for
 *                                                values bigger than what JSON
 *                                                numbers can carry safely;
 *                                                e.g. registerProvider's
 *                                                256-bit field elements)
 *   - array of 0–255 ints → Uint8Array          (Bytes<N> circuit args)
 *   - object              → recurse into values (Struct args; field types
 *                                                inferred per-value)
 *   - array (non-byte)    → recurse into items
 *
 * Plain strings, booleans, null, and Uint8Array pass through unchanged.
 *
 * Implementation lives in arg-coerce.ts so we can unit-test it directly.
 * Here it's serialized via .toString() and bound to a stable `coerceArg`
 * const in the generated bridge — bun's minifier mangles the function's
 * own name, so we can't rely on the inlined body declaring it under the
 * expected identifier. Wrapping in parens + assigning to const keeps the
 * call site (`...map(coerceArg)`) referring to the right thing regardless.
 */
const ARG_COERCE_FN = `\nconst coerceArg = (${coerceArg.toString()});\n`;

function generateDeployScript(opts: DeployOptions): string {
  const privateStateKey = opts.privateStateKey ?? `${opts.contractName}PrivateState`;
  // Constructor args are pre-serialized to JSON here (still in our process)
  // so the generated script just spreads them. The coerceArg helper inside
  // the bridge then upgrades number → BigInt and number[] → Uint8Array, the
  // two coercions Compact circuits invariably need.
  const argsLiteral = JSON.stringify(opts.args ?? []);

  return `
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
setNetworkId(${JSON.stringify(opts.networkConfig.networkId.toLowerCase())});

${rpcClientCode(opts.servePort)}
${contractSetupCode(opts.contractName, opts.managedDir)}

process.stderr.write('Connecting to mn serve...\\n');
await rpcConnect();
process.stderr.write('Connected\\n');

${walletProviderCode()}
${providerSetupCode(opts.managedDir, opts.networkConfig, privateStateKey)}

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';

${ARG_COERCE_FN}
const constructorArgs = (${argsLiteral}).map(coerceArg);
process.stderr.write('Deploying contract' + (constructorArgs.length ? ' with ' + constructorArgs.length + ' constructor arg(s)...' : '...') + '\\n');
const deployed = await deployContract(providers, {
  compiledContract: compiled,
  privateStateId: ${JSON.stringify(privateStateKey)},
  initialPrivateState: makeInitialPrivateState(),
  args: constructorArgs,
});

const address = deployed.deployTxData?.public?.contractAddress ?? 'unknown';
process.stderr.write('Deploy complete: ' + address + '\\n');

console.log(JSON.stringify({ contractAddress: address }));
rpcClose();
process.exit(0);
`;
}

function generateCallScript(opts: CallOptions): string {
  const privateStateKey = opts.privateStateKey ?? `${opts.contractName}PrivateState`;

  return `
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
setNetworkId(${JSON.stringify(opts.networkConfig.networkId.toLowerCase())});

${rpcClientCode(opts.servePort)}
${contractSetupCode(opts.contractName, opts.managedDir)}

process.stderr.write('Connecting to mn serve...\\n');
await rpcConnect();
process.stderr.write('Connected\\n');

${walletProviderCode()}
${providerSetupCode(opts.managedDir, opts.networkConfig, privateStateKey)}

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';

process.stderr.write('Finding deployed contract...\\n');
const deployed = await findDeployedContract(providers, {
  compiledContract: compiled,
  contractAddress: ${JSON.stringify(opts.contractAddress)},
  privateStateId: ${JSON.stringify(privateStateKey)},
  initialPrivateState: makeInitialPrivateState(),
});

process.stderr.write('Calling ${opts.circuit}...\\n');
${ARG_COERCE_FN}
const args = (${JSON.stringify(opts.args ?? [])}).map(coerceArg);
await deployed.callTx.${opts.circuit}(...args);

console.log(JSON.stringify({ status: 'success', circuit: ${JSON.stringify(opts.circuit)} }));
rpcClose();
process.exit(0);
`;
}

function generateStateScript(opts: StateOptions): string {
  return `
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
setNetworkId(${JSON.stringify(opts.networkConfig.networkId.toLowerCase())});

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';

const MANAGED_DIR = ${JSON.stringify(opts.managedDir)};

// Load the contract module which exports the ledger() function
const contractMod = await import(pathToFileURL(resolve(MANAGED_DIR, 'contract', 'index.js')).href);

if (typeof contractMod.ledger !== 'function') {
  console.error('Contract module does not export a ledger() function');
  process.exit(1);
}

process.stderr.write('Querying contract state...\\n');
const provider = indexerPublicDataProvider(
  ${JSON.stringify(opts.networkConfig.indexer)},
  ${JSON.stringify(opts.networkConfig.indexerWS ?? opts.networkConfig.indexer.replace('http', 'ws'))},
);

const contractState = await provider.queryContractState(${JSON.stringify(opts.contractAddress)});
if (!contractState) {
  console.error('No contract found at address ${opts.contractAddress}');
  process.exit(1);
}

process.stderr.write('Parsing ledger state...\\n');
// ledger() expects contractState.data (ChargedState), not the full ContractState
const state = contractMod.ledger(contractState.data ?? contractState);

// Extract scalar fields and map fields
const fields = {};
const maps = {};

for (const key of Object.keys(state)) {
  const val = state[key];

  // Check if it's a map-like (has size() and Symbol.iterator)
  if (val && typeof val === 'object' && typeof val.size === 'function') {
    try {
      maps[key] = { size: val.size().toString() };
    } catch {
      maps[key] = { size: '?' };
    }
  } else if (typeof val === 'bigint') {
    fields[key] = val.toString();
  } else if (typeof val === 'string') {
    fields[key] = val;
  } else if (typeof val === 'boolean') {
    fields[key] = String(val);
  } else if (val instanceof Uint8Array) {
    fields[key] = Array.from(val).map(b => b.toString(16).padStart(2, '0')).join('');
  } else if (val !== undefined && val !== null) {
    try { fields[key] = JSON.stringify(val); } catch { fields[key] = '?'; }
  }
}

console.log(JSON.stringify({ fields, maps }));
process.exit(0);
`;
}

// ── Script execution ──

/**
 * Names of npm packages the generated bridge script (and the user's compiled
 * contract module) bare-import. When any of these are missing from the user's
 * node_modules, overlayMidnightSdk symlinks ours into theirs so resolution
 * succeeds. `@midnight-ntwrk` is a scope — symlinking the whole scope dir
 * brings every SDK package along in one shot.
 */
const SDK_OVERLAY_NAMES = ['@midnight-ntwrk', 'ws'] as const;

/**
 * Make our SDK packages resolvable from `userNodeModules`. Two cases:
 *   1. User has no node_modules at all → symlink the whole tree (cheap, the
 *      pre-existing fast path).
 *   2. User has a node_modules dir but is missing one of SDK_OVERLAY_NAMES
 *      (common for "compile-only" projects that ship Compact source +
 *      managed artifacts but never `npm install`-ed the SDK) → symlink the
 *      missing top-level entries individually so we don't clobber what they
 *      DO have.
 *
 * Returns the list of paths to remove on cleanup, in reverse-creation order.
 */
function overlayMidnightSdk(userNodeModules: string): string[] {
  if (!OUR_NODE_MODULES) return [];
  const created: string[] = [];

  // Fast path: no user node_modules → whole-tree symlink.
  if (!existsSync(userNodeModules)) {
    try {
      symlinkSync(OUR_NODE_MODULES, userNodeModules);
      created.push(userNodeModules);
    } catch { /* leave alone — caller will get a clean module-not-found from node */ }
    return created;
  }

  // Per-package overlay: only fill in what's missing. Never replace existing
  // entries — the user might be pinning a specific version we shouldn't shadow.
  for (const name of SDK_OVERLAY_NAMES) {
    const target = join(OUR_NODE_MODULES, name);
    const link = join(userNodeModules, name);
    if (!existsSync(target) || existsSync(link)) continue;
    try {
      symlinkSync(target, link);
      created.push(link);
    } catch { /* ignore — at worst the bridge fails with a clear ERR_MODULE_NOT_FOUND */ }
  }
  return created;
}

async function executeScript(
  dappDir: string,
  script: string,
  onMessage?: (msg: string) => void,
): Promise<string> {
  // ESM resolution walks up from the importing file's location to find
  // node_modules; NODE_PATH does NOT work for ESM. Three different files
  // need to resolve bare imports during a deploy:
  //   1. the generated script.mjs (in dappDir)
  //   2. the user's compiled contract/index.js (under managed/<name>/)
  //   3. the user's witnesses.js (under dist/ or src/)
  // All three live somewhere under dappDir, so symlinking ours into the
  // dApp's node_modules satisfies all of them. overlayMidnightSdk handles
  // both the empty-tree and missing-package cases; cleanup removes only
  // what we created so the dApp dir ends up exactly as we found it.
  const userNodeModules = join(dappDir, 'node_modules');
  const overlayPaths = overlayMidnightSdk(userNodeModules);

  const scriptPath = join(dappDir, `.mn-contract-${Date.now()}.mjs`);
  writeFileSync(scriptPath, script);

  const cleanup = () => {
    try { unlinkSync(scriptPath); } catch {}
    // Remove overlay symlinks in reverse order of creation. unlinkSync on a
    // symlink only removes the link, never the target — safe even if the
    // user's node_modules dir was created by us (it's a symlink itself in
    // that case, so it goes too).
    for (const p of overlayPaths.slice().reverse()) {
      try { unlinkSync(p); } catch {}
    }
  };

  return new Promise<string>((resolve, reject) => {
    const child = spawn('node', [scriptPath], {
      cwd: dappDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) {
        stderr += line + '\n';
        onMessage?.(line);
      }
    });

    child.on('close', (code) => {
      cleanup();
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Script exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}
