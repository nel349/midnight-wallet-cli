// Contract runner — execute contract operations in the dApp's own process context.
// Uses mn's serve RPC server for wallet operations (balance, sign, submit).
// The generated script only needs contract SDK + RPC client — no wallet SDK.

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { NetworkConfig } from '../network.ts';

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

// Try to load witnesses and private state factory
let witnesses;
let createPrivateState;
for (const p of ['contract/dist/witnesses.js', 'contract/src/witnesses.js']) {
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

if (!witnesses) process.stderr.write('Warning: No witnesses found — using vacant witnesses\\n');

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

function generateDeployScript(opts: DeployOptions): string {
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

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';

process.stderr.write('Deploying contract...\\n');
const deployed = await deployContract(providers, {
  compiledContract: compiled,
  privateStateId: ${JSON.stringify(privateStateKey)},
  initialPrivateState: makeInitialPrivateState(),
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
// Convert numeric args to BigInt (Compact runtime requires BigInt for all integers)
const rawArgs = ${JSON.stringify(opts.args ?? [])};
const args = rawArgs.map(a => typeof a === 'number' ? BigInt(a) : a);
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

async function executeScript(
  dappDir: string,
  script: string,
  onMessage?: (msg: string) => void,
): Promise<string> {
  const scriptPath = join(dappDir, `.mn-contract-${Date.now()}.mjs`);
  writeFileSync(scriptPath, script);

  return new Promise<string>((resolve, reject) => {
    const child = spawn('node', [scriptPath], {
      cwd: dappDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
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
      try { unlinkSync(scriptPath); } catch {}
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Script exited with code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });

    child.on('error', (err) => {
      try { unlinkSync(scriptPath); } catch {}
      reject(err);
    });
  });
}
