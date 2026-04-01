// Contract commands — inspect, deploy, call, and query state for compiled Midnight contracts.

import { resolve } from 'node:path';
import type { NetworkName } from '../lib/network.ts';
import { type ParsedArgs, getFlag, hasFlag, requireFlag } from '../lib/argv.ts';
import { writeJsonResult } from '../lib/json-output.ts';
import { header, keyValue } from '../ui/format.ts';
import { bold, dim, teal, yellow, green, red } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';
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
    throw new Error(
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

async function handleInspect(args: ParsedArgs): Promise<void> {
  const jsonMode = hasFlag(args, 'json');

  const managedFlag = getFlag(args, 'managed');
  const pathFlag = getFlag(args, 'path');
  const startDir = resolve(managedFlag ?? pathFlag ?? process.cwd());

  const { info } = findContractInfo(startDir);

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

  process.stderr.write('\n');
}

// ── Serve lifecycle for deploy/call ──

async function ensureServe(network: string, jsonMode: boolean): Promise<{ port: number; stop: () => Promise<void> }> {
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
    if (!jsonMode) process.stderr.write(dim('  mn serve already running on port ' + DEFAULT_SERVE_PORT) + '\n');
    return { port: DEFAULT_SERVE_PORT, stop: async () => {} };
  }

  // Start serve in-process
  const spinner = startSpinner('Starting mn serve...');
  const handle = await startServe({
    network,
    onMessage: (msg) => spinner.update(msg),
  });
  spinner.stop('mn serve ready (port ' + handle.port + ')');
  return { port: handle.port, stop: () => handle.stop() };
}

// ── Deploy ──

async function handleDeploy(args: ParsedArgs): Promise<void> {
  const jsonMode = hasFlag(args, 'json');
  const dappDir = resolve(process.cwd());

  const { runDeploy } = await import('../lib/contract/runner.ts');
  const { resolveNetwork } = await import('../lib/resolve-network.ts');

  if (!jsonMode) {
    process.stderr.write('\n' + header('Contract Deploy') + '\n\n');
  }

  const { info } = findContractInfo(dappDir);

  const network = getFlag(args, 'network') ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'contract', subcommand: 'deploy', positionals: [], flags: { network } },
  });

  if (!jsonMode) {
    process.stderr.write(keyValue('Contract', info.name) + '\n');
    process.stderr.write(keyValue('Network', network) + '\n\n');
  }

  // Start mn serve (or reuse existing)
  const serve = await ensureServe(network, jsonMode);

  const spinner = startSpinner('Deploying contract...');

  try {
    const result = await runDeploy({
      dappDir,
      networkConfig,
      managedDir: info.managedDir,
      contractName: info.name,
      servePort: serve.port,
      onMessage: (msg) => spinner.update(msg),
    });

    spinner.stop(green('✓') + ' Contract deployed');

    if (jsonMode) {
      writeJsonResult({
        subcommand: 'deploy',
        contractName: info.name,
        address: result.contractAddress,
        network,
      });
    } else {
      process.stderr.write('\n');
      process.stderr.write(keyValue('Address', result.contractAddress) + '\n');
      process.stderr.write('\n' + green('  ✓ Deploy successful') + '\n\n');
    }

    // Write address to stdout for piping
    process.stdout.write(result.contractAddress + '\n');
  } catch (err) {
    spinner.stop(red('✗') + ' Deploy failed');
    throw err;
  } finally {
    await serve.stop();
  }
}

// ── Call ──

async function handleCall(args: ParsedArgs): Promise<void> {
  const jsonMode = hasFlag(args, 'json');
  const dappDir = resolve(process.cwd());

  const address = requireFlag(args, 'address', 'contract address');
  const circuit = requireFlag(args, 'circuit', 'circuit name');
  const argsJson = getFlag(args, 'args');

  const { runCall } = await import('../lib/contract/runner.ts');
  const { resolveNetwork } = await import('../lib/resolve-network.ts');

  if (!jsonMode) {
    process.stderr.write('\n' + header('Contract Call') + '\n\n');
  }

  const { info } = findContractInfo(dappDir);

  let callArgs: unknown[] = [];
  if (argsJson) {
    try {
      const parsed = JSON.parse(argsJson);
      callArgs = Array.isArray(parsed) ? parsed : Object.values(parsed);
    } catch (err) {
      throw new Error(`Invalid --args JSON: ${(err as Error).message}`);
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

  const serve = await ensureServe(network, jsonMode);
  const spinner = startSpinner(`Calling ${circuit}...`);

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
    spinner.stop(red('✗') + ' Call failed');
    throw err;
  } finally {
    await serve.stop();
  }
}

// ── State ──

async function handleState(args: ParsedArgs): Promise<void> {
  const jsonMode = hasFlag(args, 'json');
  const address = requireFlag(args, 'address', 'contract address');

  const { resolveNetwork } = await import('../lib/resolve-network.ts');
  const { buildStateProvider } = await import('../lib/contract/providers.ts');

  const network = getFlag(args, 'network') ?? 'undeployed';
  const { config: networkConfig } = resolveNetwork({
    args: { command: 'contract', subcommand: 'state', positionals: [], flags: { network } },
  });

  if (!jsonMode) {
    process.stderr.write('\n' + header('Contract State') + '\n\n');
    process.stderr.write(keyValue('Address', address.slice(0, 20) + '...') + '\n');
    process.stderr.write(keyValue('Network', network) + '\n\n');
  }

  const spinner = startSpinner('Querying contract state...');
  const publicDataProvider = buildStateProvider(networkConfig);

  try {
    const contractState = await publicDataProvider.queryContractState(address);

    if (!contractState) {
      spinner.stop(red('✗') + ' Not found');
      throw new Error(`No contract found at address ${address} on ${network}`);
    }

    spinner.stop(green('✓') + ' State retrieved');

    const stateData = contractState.data ?? contractState;

    if (jsonMode) {
      writeJsonResult({
        subcommand: 'state',
        address,
        network,
        state: stateData,
      });
    } else {
      process.stderr.write(bold('  Ledger State') + '\n');
      if (typeof stateData === 'object' && stateData !== null) {
        for (const [key, value] of Object.entries(stateData)) {
          const display = typeof value === 'bigint' ? value.toString() : JSON.stringify(value);
          process.stderr.write(`    ${key}: ${display}\n`);
        }
      } else {
        process.stderr.write(dim('    (raw state — use --json for full data)') + '\n');
        process.stderr.write(`    ${JSON.stringify(stateData).slice(0, 200)}\n`);
      }
      process.stderr.write('\n');
    }
  } catch (err) {
    if ((err as Error).message.includes('No contract found')) throw err;
    spinner.stop(red('✗') + ' Query failed');
    throw err;
  }
}
