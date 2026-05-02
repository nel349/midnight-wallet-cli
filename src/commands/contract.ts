// Contract commands — inspect, deploy, call, and query state for compiled Midnight contracts.

import { resolve } from 'node:path';
import type { NetworkName } from '../lib/network.ts';
import { type ParsedArgs, getFlag, hasFlag, requireFlag } from '../lib/argv.ts';
import { UsageError } from '../lib/errors.ts';
import { writeJsonResult } from '../lib/json-output.ts';
import { header, keyValue } from '../ui/format.ts';
import { bold, dim, teal, yellow, green } from '../ui/colors.ts';
import { start as startSpinner, type Spinner } from '../ui/spinner.ts';

/**
 * No-op spinner for `--json` callers. Suppresses chrome on stderr so
 * programmatic consumers (agents, scripts) get a clean JSON-only stream
 * on stdout with nothing on stderr to misinterpret.
 */
function silentSpinner(): Spinner {
  return { update() {}, stop() {}, fail() {}, log() {} };
}
import {
  findContractInfo,
  formatCircuitSignature,
  formatCircuitFlags,
  formatWitnessSignature,
  toJsonOutput,
} from '../lib/contract/inspect.ts';

const VALID_SUBCOMMANDS = ['inspect', 'deploy', 'call', 'state'] as const;
type Subcommand = typeof VALID_SUBCOMMANDS[number];

function isValidSubcommand(s: string): s is Subcommand {
  return (VALID_SUBCOMMANDS as readonly string[]).includes(s);
}

export default async function contractCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  const subcommand = args.subcommand;

  if (!subcommand || !isValidSubcommand(subcommand)) {
    throw new UsageError(
      `Usage: midnight contract <${VALID_SUBCOMMANDS.join('|')}>\n\n` +
      `  inspect   Show circuits, witnesses, and types for a compiled contract\n` +
      `  deploy    Deploy a contract to the network\n` +
      `  call      Call a circuit on a deployed contract\n` +
      `  state     Read the ledger state of a deployed contract\n\n` +
      `Run "midnight help contract" for more info.`
    );
  }

  switch (subcommand) {
    case 'inspect':
      return handleInspect(args);
    case 'deploy':
      return handleDeploy(args);
    case 'call':
      return handleCall(args);
    case 'state':
      return handleState(args);
  }
}

// ── Inspect ──

/**
 * Resolve the directory to scan for managed/<name>/. Honours --managed
 * (direct path to a managed/<name>/ dir, used by all four subcommands) and
 * --path (dApp root, the more common case). When both are set --managed
 * wins because it's the more specific signal.
 */
function resolveScanDir(args: ParsedArgs): string {
  const managedFlag = getFlag(args, 'managed');
  const pathFlag = getFlag(args, 'path');
  return resolve(managedFlag ?? pathFlag ?? process.cwd());
}

async function handleInspect(args: ParsedArgs): Promise<void> {
  const jsonMode = hasFlag(args, 'json');
  const startDir = resolveScanDir(args);
  const contractName = getFlag(args, 'name');

  const { info } = findContractInfo(startDir, contractName);

  if (jsonMode) {
    writeJsonResult(toJsonOutput(info));
    return;
  }

  process.stderr.write('\n' + header(`Contract: ${info.name}`) + '\n\n');
  process.stderr.write(keyValue('Compiler', info.compilerVersion) + '\n');
  process.stderr.write(keyValue('Language', info.languageVersion) + '\n');
  process.stderr.write(keyValue('Runtime', info.runtimeVersion) + '\n');

  process.stderr.write('\n' + bold('  Circuits') + '\n');
  if (info.circuits.length === 0) {
    process.stderr.write(dim('    (none)') + '\n');
  } else {
    for (const circuit of info.circuits) {
      const sig = formatCircuitSignature(circuit);
      const flags = formatCircuitFlags(circuit);
      const flagColor = circuit.pure ? teal(flags) : yellow(flags);
      process.stderr.write(`    ${sig}  ${dim('—')} ${flagColor}\n`);
    }
  }

  process.stderr.write('\n' + bold('  Witnesses') + '\n');
  if (info.witnesses.length === 0) {
    process.stderr.write(dim('    (none)') + '\n');
  } else {
    for (const witness of info.witnesses) {
      process.stderr.write(`    ${formatWitnessSignature(witness)}\n`);
    }
  }

  if (info.siblings.length > 0) {
    process.stderr.write('\n' + bold('  Other contracts in this project') + '\n');
    for (const name of info.siblings) {
      process.stderr.write(`    ${teal(name)}\n`);
    }
    process.stderr.write('\n' + dim('  Inspect a sibling: mn contract inspect --name <name>') + '\n');
  }

  process.stderr.write('\n');
}

// ── Preflight check: balance + dust before deploy/call ──

async function preflight(network: string, jsonMode: boolean, wallet?: string): Promise<void> {
  const { loadWalletConfig, resolveWalletPath } = await import('../lib/wallet-config.ts');
  const { resolveNetwork } = await import('../lib/resolve-network.ts');
  const { defaultRepository } = await import('../lib/wallet-data-repository.ts');
  const { NATIVE_TOKEN_TYPE } = await import('../lib/constants.ts');

  const { config: networkConfig } = resolveNetwork({
    args: { command: 'contract', subcommand: undefined, positionals: [], flags: { network } },
  });
  // resolveWalletPath honours --wallet when passed; without the arg, it
  // falls back to the active wallet from config. Forwarding the user's
  // --wallet flag here keeps the preflight check aligned with the wallet
  // that the actual deploy/call will use.
  const walletConfig = loadWalletConfig(resolveWalletPath(wallet));
  const seedBuffer = Buffer.from(walletConfig.seed, 'hex');
  const address = walletConfig.addresses[network as NetworkName];

  // In JSON mode, suppress the spinner entirely so stderr stays quiet for
  // programmatic callers. The same pattern applies in handleDeploy/handleCall.
  const spinner = jsonMode ? silentSpinner() : startSpinner('Checking wallet...');
  const repo = defaultRepository();

  try {
    // Two cheap reads through the repo — no facade, no proof server, no
    // strict sync. The repo's tip-aware memo means the next deploy/call
    // in the same MCP session pays ~zero on these checks.
    const balanceView = await repo.unshielded(address, networkConfig);
    const nightBalance = balanceView.balances.get(NATIVE_TOKEN_TYPE) ?? 0n;

    if (nightBalance === 0n) {
      spinner.fail('No NIGHT balance');
      throw new Error(
        `Wallet has 0 NIGHT on ${network}.\n\n` +
        `  Fund your wallet before deploying:\n` +
        `    Address: ${address}\n` +
        (network === 'undeployed'
          ? `    Run: midnight airdrop 1000\n`
          : `    Use the Midnight faucet or transfer from another wallet.\n`)
      );
    }

    const dustView = await repo.dust(seedBuffer, networkConfig, { onStatus: (s) => spinner.update(s) });
    if (dustView.balance === 0n && dustView.availableCoins === 0) {
      spinner.fail('No dust available');
      throw new Error(
        `Wallet has no dust on ${network}. Dust is required to pay transaction fees.\n\n` +
        `  Register for dust generation:\n` +
        `    Run: midnight dust register --network ${network}\n` +
        `    Then wait: midnight dust status --network ${network}\n`
      );
    }

    spinner.stop(`Wallet OK (${nightBalance} NIGHT, dust available)`);
  } catch (err) {
    spinner.fail('Wallet check failed');
    throw err;
  }
}

// ── Serve lifecycle for deploy/call ──

/** Map CLI network name (lowercase) to the SDK networkId the serve reports. */
const NETWORK_TO_SDK_ID: Record<string, string> = {
  preprod: 'PreProd',
  preview: 'Preview',
  undeployed: 'Undeployed',
};

/**
 * Ask an mn serve listening on `port` what network it serves. Sends a single
 * getConnectionStatus RPC. Returns the SDK networkId string ("PreProd" etc.)
 * on success, or null on any timeout/error/parse failure (callers treat null
 * as "unknown — refuse to reuse").
 */
async function probeServeNetwork(port: number): Promise<string | null> {
  const WebSocket = (await import('ws')).default;
  return new Promise<string | null>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const timeout = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, 2000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getConnectionStatus', params: {} }));
    });
    ws.on('message', (data: Buffer) => {
      clearTimeout(timeout);
      try {
        const msg = JSON.parse(data.toString());
        const id = msg?.result?.networkId;
        ws.close();
        resolve(typeof id === 'string' ? id : null);
      } catch {
        ws.close();
        resolve(null);
      }
    });
    ws.on('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

async function ensureServe(network: string, jsonMode: boolean, wallet?: string): Promise<{ port: number; stop: () => Promise<void> }> {
  const { startServe } = await import('../lib/test/serve-manager.ts');
  const { DEFAULT_SERVE_PORT } = await import('../lib/constants.ts');

  // Check if serve is already running on the default port
  const net = await import('net');
  const portInUse = await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
    socket.connect(DEFAULT_SERVE_PORT, '127.0.0.1');
  });

  if (portInUse) {
    // Probe the existing serve. Reuse only if it serves the requested network;
    // otherwise refuse loudly so the user stops the wrong-network serve instead
    // of getting a cryptic "expect 'preprod' found 'undeployed'" mid-deploy.
    const expectedSdkId = NETWORK_TO_SDK_ID[network];
    const actualSdkId = await probeServeNetwork(DEFAULT_SERVE_PORT);
    if (actualSdkId && expectedSdkId && actualSdkId !== expectedSdkId) {
      throw new Error(
        `mn serve is already running on port ${DEFAULT_SERVE_PORT} for network ${actualSdkId.toLowerCase()}, ` +
        `but this command needs ${network}.\n` +
        `Stop the running serve first (e.g. pkill -f 'mn serve') or run this command on the matching network.`
      );
    }
    if (!jsonMode) process.stderr.write(dim('  mn serve already running on port ' + DEFAULT_SERVE_PORT) + '\n');
    return { port: DEFAULT_SERVE_PORT, stop: async () => {} };
  }

  // Start serve in-process
  const spinner = jsonMode ? silentSpinner() : startSpinner('Starting mn serve...');
  const handle = await startServe({
    network,
    wallet,
    onMessage: (msg) => spinner.update(msg),
  });
  spinner.stop('mn serve ready (port ' + handle.port + ')');
  return { port: handle.port, stop: () => handle.stop() };
}

// ── Deploy ──

async function handleDeploy(args: ParsedArgs): Promise<void> {
  const jsonMode = hasFlag(args, 'json');
  // dApp dir for runner/witness discovery is --path (or cwd). --managed only
  // tells us where contract-info.json lives; the runner still needs the
  // project root to load witnesses.js and write the level-db cache.
  const dappDir = resolve(getFlag(args, 'path') ?? process.cwd());
  const scanDir = resolveScanDir(args);
  const contractName = getFlag(args, 'name');

  const { runDeploy } = await import('../lib/contract/runner.ts');
  const { resolveNetwork } = await import('../lib/resolve-network.ts');

  if (!jsonMode) {
    process.stderr.write('\n' + header('Contract Deploy') + '\n\n');
  }

  const { info } = findContractInfo(scanDir, contractName);

  // Fail fast when the contract declares witnesses but no compiled
  // witnesses.js is on disk — otherwise the SDK throws a cryptic
  // "first (witnesses) argument does not contain a function-valued field
  // named X" mid-deploy after a long wait.
  const declaredWitnesses = info.witnesses.map((w) => w.name);
  if (declaredWitnesses.length > 0) {
    const { findWitnessFile, buildMissingWitnessError } = await import('../lib/contract/witness-discovery.ts');
    if (!findWitnessFile(dappDir)) {
      throw new Error(buildMissingWitnessError({ projectRoot: dappDir, witnessNames: declaredWitnesses }));
    }
  }

  const network = getFlag(args, 'network') ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'contract', subcommand: 'deploy', positionals: [], flags: { network } },
  });

  // Constructor args via --args '<json>'. Same parsing as `mn contract call`:
  // arrays are passed positionally; objects are unwrapped to Object.values
  // (so the contract author can pick whichever shape feels natural).
  const argsJson = getFlag(args, 'args');
  let constructorArgs: unknown[] = [];
  if (argsJson) {
    try {
      const parsed = JSON.parse(argsJson);
      constructorArgs = Array.isArray(parsed) ? parsed : Object.values(parsed);
    } catch (err) {
      throw new UsageError(`Invalid --args JSON: ${(err as Error).message}`);
    }
  }

  if (!jsonMode) {
    process.stderr.write(keyValue('Contract', info.name) + '\n');
    process.stderr.write(keyValue('Network', network) + '\n');
    if (constructorArgs.length > 0) {
      process.stderr.write(keyValue('Constructor args', String(constructorArgs.length)) + '\n');
    }
    process.stderr.write('\n');
  }

  // Pre-check: verify wallet has balance and dust before attempting deploy
  await preflight(network, jsonMode, getFlag(args, 'wallet'));

  // Start mn serve (or reuse existing)
  const serve = await ensureServe(network, jsonMode, getFlag(args, 'wallet'));

  const spinner = jsonMode ? silentSpinner() : startSpinner('Deploying contract...');

  try {
    const result = await runDeploy({
      dappDir,
      networkConfig,
      managedDir: info.managedDir,
      contractName: info.name,
      servePort: serve.port,
      args: constructorArgs,
      onMessage: (msg) => spinner.update(msg),
    });

    spinner.stop(green('✓') + ' Contract deployed');

    if (jsonMode) {
      // JSON path emits a single line of structured output on stdout. The
      // bare address line below is for the human "pipe through head" workflow
      // and would pollute the JSON stream.
      writeJsonResult({
        subcommand: 'deploy',
        contractName: info.name,
        address: result.contractAddress,
        network,
      });
    } else {
      process.stderr.write('\n');
      process.stderr.write(keyValue('Address', result.contractAddress) + '\n');
      process.stderr.write('\n' + green('  ✓ Deploy successful') + '\n');
      writeNextStepsHint(result.contractAddress, info.circuits, network);
      // Pipeable address on stdout for shell composition (e.g. `addr=$(mn contract deploy)`).
      process.stdout.write(result.contractAddress + '\n');
    }
  } catch (err) {
    spinner.fail('Deploy failed');
    throw err;
  } finally {
    await serve.stop();
  }
}

/**
 * Print "what next?" hints after a successful deploy. Always shows the
 * state-read command (works even for contracts with no public circuits),
 * and adds a call command when at least one circuit takes no arguments
 * (those run as-is without --args).
 */
function writeNextStepsHint(address: string, circuits: { name: string; arguments: unknown[] }[], network: string): void {
  const networkFlag = network === 'undeployed' ? '' : ` --network ${network}`;
  process.stderr.write('\n' + dim('  Next:') + '\n');
  process.stderr.write(dim('    mn contract state --address ') + teal(address) + dim(networkFlag) + '\n');
  const noArgCircuit = circuits.find((c) => c.arguments.length === 0);
  if (noArgCircuit) {
    process.stderr.write(
      dim('    mn contract call --address ') + teal(address) +
      dim(' --circuit ') + teal(noArgCircuit.name) + dim(networkFlag) + '\n',
    );
  }
  process.stderr.write('\n');
}

// ── Call ──

async function handleCall(args: ParsedArgs): Promise<void> {
  const jsonMode = hasFlag(args, 'json');
  const dappDir = resolve(getFlag(args, 'path') ?? process.cwd());
  const scanDir = resolveScanDir(args);
  const contractName = getFlag(args, 'name');

  const address = requireFlag(args, 'address', 'contract address');
  const circuit = requireFlag(args, 'circuit', 'circuit name');
  const argsJson = getFlag(args, 'args');

  const { runCall } = await import('../lib/contract/runner.ts');
  const { resolveNetwork } = await import('../lib/resolve-network.ts');

  if (!jsonMode) {
    process.stderr.write('\n' + header('Contract Call') + '\n\n');
  }

  const { info } = findContractInfo(scanDir, contractName);

  let callArgs: unknown[] = [];
  if (argsJson) {
    try {
      const parsed = JSON.parse(argsJson);
      callArgs = Array.isArray(parsed) ? parsed : Object.values(parsed);
    } catch (err) {
      throw new UsageError(`Invalid --args JSON: ${(err as Error).message}`);
    }
  }

  const network = getFlag(args, 'network') ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'contract', subcommand: 'call', positionals: [], flags: { network } },
  });

  if (!jsonMode) {
    process.stderr.write(keyValue('Contract', info.name) + '\n');
    process.stderr.write(keyValue('Circuit', circuit) + '\n');
    process.stderr.write(keyValue('Address', address.slice(0, 20) + '...') + '\n\n');
  }

  await preflight(network, jsonMode, getFlag(args, 'wallet'));

  const serve = await ensureServe(network, jsonMode, getFlag(args, 'wallet'));
  const spinner = jsonMode ? silentSpinner() : startSpinner(`Calling ${circuit}...`);

  try {
    const result = await runCall({
      dappDir,
      networkConfig,
      managedDir: info.managedDir,
      contractName: info.name,
      contractAddress: address,
      circuit,
      args: callArgs,
      servePort: serve.port,
      onMessage: (msg) => spinner.update(msg),
    });

    spinner.stop(green('✓') + ` ${circuit} called`);

    if (jsonMode) {
      writeJsonResult({
        subcommand: 'call',
        contractName: info.name,
        circuit,
        address,
        network,
        status: result.status,
      });
    } else {
      process.stderr.write('\n' + green('  ✓ Circuit call successful') + '\n\n');
    }
  } catch (err) {
    spinner.fail('Call failed');
    throw err;
  } finally {
    await serve.stop();
  }
}

// ── State ──

async function handleState(args: ParsedArgs): Promise<void> {
  const jsonMode = hasFlag(args, 'json');
  const dappDir = resolve(getFlag(args, 'path') ?? process.cwd());
  const scanDir = resolveScanDir(args);
  const contractName = getFlag(args, 'name');
  const address = requireFlag(args, 'address', 'contract address');

  const { resolveNetwork } = await import('../lib/resolve-network.ts');
  const { runState } = await import('../lib/contract/runner.ts');

  const network = getFlag(args, 'network') ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'contract', subcommand: 'state', positionals: [], flags: { network } },
  });

  if (!jsonMode) {
    process.stderr.write('\n' + header('Contract State') + '\n\n');
    process.stderr.write(keyValue('Address', address.slice(0, 20) + '...') + '\n');
    process.stderr.write(keyValue('Network', network) + '\n\n');
  }

  // Try parsed ledger state via runner (needs compiled contract in dApp)
  const spinner = jsonMode ? silentSpinner() : startSpinner('Querying contract state...');

  try {
    const { info } = findContractInfo(scanDir, contractName);

    const result = await runState({
      dappDir,
      networkConfig,
      managedDir: info.managedDir,
      contractName: info.name,
      contractAddress: address,
      onMessage: (msg) => spinner.update(msg),
    });

    spinner.stop(green('✓') + ' State retrieved');

    if (jsonMode) {
      writeJsonResult({
        subcommand: 'state',
        address,
        network,
        ...result,
      });
    } else {
      // Display scalar fields
      const hasFields = Object.keys(result.fields).length > 0;
      const hasMaps = Object.keys(result.maps).length > 0;

      if (hasFields || hasMaps) {
        process.stderr.write(bold('  Ledger State') + '\n');
        for (const [key, value] of Object.entries(result.fields)) {
          process.stderr.write(`    ${key}: ${teal(value)}` + '\n');
        }
        for (const [key, info] of Object.entries(result.maps)) {
          process.stderr.write(`    ${key}: ${dim(`Map (${(info as any).size} entries)`)}` + '\n');
        }
      } else {
        process.stderr.write(dim('  (no ledger fields found)') + '\n');
      }
      process.stderr.write('\n');
    }
  } catch (err) {
    // If runner fails (no compiled contract in cwd), fall back to raw state
    spinner.stop(yellow('⚠') + ' Parsed state unavailable, showing raw');

    const { buildStateProvider } = await import('../lib/contract/providers.ts');
    const publicDataProvider = buildStateProvider(networkConfig);
    const contractState = await publicDataProvider.queryContractState(address);

    if (!contractState) {
      throw new Error(`No contract found at address ${address} on ${network}`);
    }

    const stateData = contractState.data ?? contractState;

    if (jsonMode) {
      writeJsonResult({ subcommand: 'state', address, network, raw: stateData });
    } else {
      process.stderr.write(bold('  Raw State') + '\n');
      process.stderr.write(dim('    (run from dApp root for parsed ledger fields)') + '\n');
      process.stderr.write(`    ${JSON.stringify(stateData).slice(0, 200)}\n\n`);
    }
  }
}
