// Runs one action in the account build: a generated script imports the
// build's module for outside callers and hands it a wallet backed by mn serve.
// For a local build the script is placed in the build's directory, so its
// imports resolve there; for the installed package it imports the driver and
// midnight-js-types by the URLs mn's own dependencies resolve to, and is placed
// in the records directory. The script's working directory is the account's
// records directory, where the build keeps its private-state stores; the
// records themselves go where MIDNIGHT_ACCOUNT_STATE_DIR says, which is the
// same place. The package fetches its proving artefacts as it first proves
// with each, into the cache MIDNIGHT_ACCOUNT_ARTEFACTS_DIR names.
//
// The build logs its progress with console.log. The script sends that to
// stderr, where mn shows it as progress, and writes the action's result as one
// JSON line on stdout.

import { randomBytes } from 'node:crypto';
import { SCRIPT_PRELUDE, executeScript, rpcClientCode, walletProviderCode } from '../contract/runner.ts';
import { NATIVE_TOKEN_TYPE, TOKEN_MULTIPLIER } from '../constants.ts';
import { UsageError } from '../errors.ts';
import type { NetworkConfig } from '../network.ts';
import { ACCOUNT_BUILD_ENTRY, ACCOUNT_DRIVER_VERSION, type AccountBuild, accountArtifactsDir } from './account-build.ts';

/** Where and how an action runs. */
export interface AccountBridge {
  /** The account build. */
  build: AccountBuild;
  /** The account's records directory (must exist). */
  recordsDir: string;
  networkConfig: NetworkConfig;
  /** The mn serve that pays; not needed to ask which account is on record. */
  servePort?: number;
  /** Each line of the build's progress. */
  onMessage?: (message: string) => void;
}

export type BridgeAction =
  /** Which account the records name, if any. Touches neither the chain nor a wallet. */
  | { kind: 'account' }
  /** Deploy the account and activate its boot device (or finish one that stopped part way). */
  | { kind: 'deploy' }
  /** Deposit shielded NIGHT from the paying wallet into the account; `value` in the smallest unit, as decimal text. */
  | { kind: 'deposit'; value: string }
  /** One of the owner's commands, as the build's own command line takes it. */
  | { kind: 'owner'; argv: readonly string[] };

export interface AccountOnRecord {
  address: string;
  /** The owner key's arm: `k1` (secp256k1) or `v1` (JubJub). */
  arm: string;
}

export interface DeployOutcome {
  address: string;
  /** An account whose deploy had stopped part way was completed, not a new one deployed. */
  resumed: boolean;
  /** The boot device was activated by this run. */
  activated: boolean;
  /** Where the record of an earlier deploy that never reached the chain was moved to. */
  setAside?: string;
}

export interface DepositOutcome {
  address: string;
  /** The deposited value, in the smallest unit, as decimal text. */
  value: string;
  txHash: string;
  blockHeight: number;
}

export interface OwnerCommandResult {
  /** The build's exit code: 0 done, 1 failed, 2 the command line was wrong. */
  exitCode: number;
  /** What the command wrote as its result (JSON text when run with --json). */
  output: string;
  /** What it reported as errors. */
  errors: string[];
}

/** The network isn't one the account build can reach: the caller's to fix, by naming another. */
export class UnreachableByAccountBuildError extends UsageError {
  constructor(networkId: string) {
    super(
      `The account build reaches only an undeployed (local) network; this is ${networkId}. `
      + 'Run mn grant with --network undeployed and the endpoints of a local ledger-9 stack.',
    );
    this.name = 'UnreachableByAccountBuildError';
    Object.setPrototypeOf(this, UnreachableByAccountBuildError.prototype);
  }
}

/** The WebSocket URL of a node as the http(s) URL the build takes. */
const httpOf = (url: string): string => url.replace(/^ws/, 'http');

/**
 * What the build reads from its environment: its endpoints, as URLs, where its
 * records go, and for the installed package where it caches its proving
 * artefacts (a local build has its own).
 */
export function bridgeEnvironment(networkConfig: NetworkConfig, recordsDir: string, build?: AccountBuild): Record<string, string> {
  if (networkConfig.networkId.toLowerCase() !== 'undeployed') {
    throw new UnreachableByAccountBuildError(networkConfig.networkId);
  }
  return {
    MIDNIGHT_ACCOUNT_NODE_URL: httpOf(networkConfig.node),
    MIDNIGHT_ACCOUNT_INDEXER_URL: networkConfig.indexer,
    MIDNIGHT_ACCOUNT_PROOF_SERVER_URL: networkConfig.proofServer,
    MIDNIGHT_ACCOUNT_STATE_DIR: recordsDir,
    ...(build?.kind === 'package' ? { MIDNIGHT_ACCOUNT_ARTEFACTS_DIR: accountArtifactsDir() } : {}),
  };
}

/** The owner key a deploy is given, read by the script from its environment: never on a command line, never in the script. */
const OWNER_KEY_ENV = 'MN_GRANT_OWNER_KEY';

/** How the script names a module: a local build's by its place beside the script, the package's by its URL. */
const driverUrlCode = (build: AccountBuild): string => build.kind === 'package'
  ? JSON.stringify(build.driverUrl)
  : `pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(ACCOUNT_BUILD_ENTRY)})).href`;
const typesSpecifier = (build: AccountBuild): string => (build.kind === 'package' ? build.typesUrl : '@midnight-ntwrk/midnight-js-types');

const driverImport = (build: AccountBuild): string => `
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The build logs its progress with console.log, and its command line reports
// errors with console.error: progress to stderr, errors kept for the result.
const reported = [];
console.log = (...args) => process.stderr.write(args.join(' ') + '\\n');
console.error = (...args) => { reported.push(args.join(' ')); };

const driver = await import(${driverUrlCode(build)});
if (driver.DRIVER_VERSION !== ${ACCOUNT_DRIVER_VERSION}) {
  fail(new Error('This account build speaks version ' + driver.DRIVER_VERSION + ' of its interface; this mn speaks version ${ACCOUNT_DRIVER_VERSION}. Update the older of the two.'));
}
`;

/** One object offering both of midnight-js's provider interfaces, as the build takes its paying wallet. */
const payingWallet = (build: AccountBuild): string => `
import { createWalletProvider, createMidnightProvider, Transaction } from ${JSON.stringify(typesSpecifier(build))};
const toHex = (bytes) => Buffer.from(bytes).toString('hex');
const fromHex = (hex) => new Uint8Array(Buffer.from(hex, 'hex'));

await rpcConnect();
${walletProviderCode()}
const wallet = {
  supportedEras: walletProvider.supportedEras,
  getCoinPublicKey: () => walletProvider.getCoinPublicKey(),
  getEncryptionPublicKey: () => walletProvider.getEncryptionPublicKey(),
  balanceTx: (...args) => walletProvider.balanceTx(...args),
  submitTx: (...args) => midnightProvider.submitTx(...args),
};
`;

const RESULT = `
process.stdout.write('\\n' + JSON.stringify(result) + '\\n');
`;

/**
 * A deposit, refused before the build is called when the wallet's synced
 * shielded NIGHT (as mn serve holds it) is short: the SDK's own refusal names
 * neither the token nor the amounts.
 */
function depositCode(value: string): string {
  return `const value = BigInt(${JSON.stringify(value)});
const balances = await rpcCall('getShieldedBalances', {});
const held = BigInt(balances?.[${JSON.stringify(NATIVE_TOKEN_TYPE)}] ?? 0);
const night = (specks) => (specks / ${TOKEN_MULTIPLIER}n) + '.' + String(specks % ${TOKEN_MULTIPLIER}n).padStart(${String(TOKEN_MULTIPLIER).length - 1}, '0') + ' NIGHT';
if (held < value) {
  fail(new Error('Not enough shielded NIGHT for this deposit: the wallet holds ' + night(held) + ' shielded and the deposit takes ' + night(value) + '. '
    + 'Get shielded NIGHT into it first: midnight airdrop <amount> --shielded on a local chain, or midnight transfer <this wallet> <amount> --shielded from another wallet.'));
}
const result = await driver.depositOver(wallet, value);`;
}

/** The script for one action in `build`. A wallet-backed action needs the port of the mn serve that pays. */
export function generateBridgeScript(action: BridgeAction, build: AccountBuild, servePort?: number): string {
  if (action.kind === 'account') {
    return `${SCRIPT_PRELUDE}${driverImport(build)}
const result = driver.accountOnRecord() ?? null;
${RESULT}
process.exit(0);
`;
  }
  if (servePort === undefined) throw new Error(`The ${action.kind} action needs an mn serve to pay`);
  const run = action.kind === 'deploy'
    ? `const result = await driver.deployOver(wallet, process.env.${OWNER_KEY_ENV});`
    : action.kind === 'deposit'
    ? depositCode(action.value)
    : `const written = [];
const exitCode = await driver.runOwnerOver(wallet, ${JSON.stringify(action.argv)}, (text) => { written.push(text); });
const result = { exitCode, output: written.join('\\n'), errors: reported };`;
  return `${SCRIPT_PRELUDE}
${rpcClientCode(servePort, build.kind === 'package' ? build.wsUrl : 'ws')}
${payingWallet(build)}${driverImport(build)}
${run}
${RESULT}
rpcClose();
process.exit(0);
`;
}

/** The result line: the last line of what the script wrote to stdout. */
function parseResult<T>(stdout: string, what: string): T {
  const last = stdout.trim().split('\n').at(-1) ?? '';
  try {
    return JSON.parse(last) as T;
  } catch {
    throw new Error(`The account build's ${what} returned unexpected output:\n${stdout}`);
  }
}

async function run<T>(bridge: AccountBridge, action: BridgeAction, what: string, extraEnv: Record<string, string> = {}): Promise<T> {
  const { build } = bridge;
  const stdout = await executeScript({
    dir: build.kind === 'package' ? bridge.recordsDir : build.dir,
    script: generateBridgeScript(action, build, bridge.servePort),
    cwd: bridge.recordsDir,
    env: { ...bridgeEnvironment(bridge.networkConfig, bridge.recordsDir, build), ...extraEnv },
    onMessage: bridge.onMessage,
    // A local build has its own dependencies installed, and the package's are
    // imported by URL: no node_modules is touched.
    overlaySdk: false,
    label: 'grant',
  });
  return parseResult<T>(stdout, what);
}

/** The account the records name, or null when there is none yet. */
export function accountOnRecord(bridge: AccountBridge): Promise<AccountOnRecord | null> {
  return run<AccountOnRecord | null>(bridge, { kind: 'account' }, 'account lookup');
}

/**
 * Deploys the owner's account and activates its boot device, paid through mn
 * serve. `ownerKey` (32 bytes of hex) is the key a new account is born on; an
 * account already on record keeps its own.
 */
export function deployAccount(bridge: AccountBridge, ownerKey: string): Promise<DeployOutcome> {
  return run<DeployOutcome>(bridge, { kind: 'deploy' }, 'deploy', { [OWNER_KEY_ENV]: ownerKey });
}

/** Deposits `value` (the smallest unit, as decimal text) of shielded NIGHT from the wallet behind mn serve into the account on record. */
export async function depositIntoAccount(bridge: AccountBridge, value: string): Promise<DepositOutcome> {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`A deposit's value is a positive whole number of the smallest unit; got "${value}"`);
  return run<DepositOutcome>(bridge, { kind: 'deposit', value }, 'deposit');
}

/** Runs one of the owner's commands, paid through mn serve. */
export function runOwnerCommand(bridge: AccountBridge, argv: readonly string[]): Promise<OwnerCommandResult> {
  return run<OwnerCommandResult>(bridge, { kind: 'owner', argv }, 'owner command');
}

/** A fresh secp256k1 secret for a development owner key: 32 random bytes, as hex. */
export function newDevelopmentOwnerKey(): string {
  return randomBytes(32).toString('hex');
}
