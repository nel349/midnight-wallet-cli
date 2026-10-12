// Contract commands — inspect, deploy, call, and query state for compiled Midnight contracts.

import { resolve } from 'node:path';
import { type ParsedArgs, getFlag, hasFlag, requireFlag } from '../lib/argv.ts';
import { UsageError } from '../lib/errors.ts';
import { writeJsonResult } from '../lib/json-output.ts';
import { header, keyValue } from '../ui/format.ts';
import { bold, dim, teal, yellow, green } from '../ui/colors.ts';
import { silentSpinner, start as startSpinner } from '../ui/spinner.ts';
import { assertWalletCanPay, openPayingServe, resolvePayingTarget } from '../lib/paying-wallet.ts';
import { validateContractAddress } from '../lib/contract/validate.ts';
import { resolveContractCallRequest, resolveContractDeployRequest, resolveScanDir } from '../lib/contract/request.ts';
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

// ── Deploy ──

async function handleDeploy(args: ParsedArgs): Promise<void> {
  const jsonMode = hasFlag(args, 'json');
  const { dappDir, info, constructorArgs, privateStateSecretKey } = resolveContractDeployRequest(args);

  const { runDeploy } = await import('../lib/contract/runner.ts');

  if (!jsonMode) {
    process.stderr.write('\n' + header('Contract Deploy') + '\n\n');
  }

  const target = resolvePayingTarget(args, 'contract', 'deploy');
  const { network, networkConfig } = target;

  if (!jsonMode) {
    process.stderr.write(keyValue('Contract', info.name) + '\n');
    process.stderr.write(keyValue('Network', network) + '\n');
    if (constructorArgs.length > 0) {
      process.stderr.write(keyValue('Constructor args', String(constructorArgs.length)) + '\n');
    }
    process.stderr.write('\n');
  }

  // Pre-check: verify wallet has balance and dust before attempting deploy
  await assertWalletCanPay(target, getFlag(args, 'wallet'), jsonMode ? silentSpinner() : startSpinner('Checking wallet...'));

  // Start mn serve (or reuse existing)
  const serve = await openPayingServe(target, getFlag(args, 'wallet'), jsonMode ? silentSpinner() : startSpinner('Starting mn serve...'));

  const spinner = jsonMode ? silentSpinner() : startSpinner('Deploying contract...');

  try {
    const result = await runDeploy({
      dappDir,
      networkConfig,
      managedDir: info.managedDir,
      contractName: info.name,
      servePort: serve.port,
      args: constructorArgs,
      privateStateSecretKey,
      onMessage: (msg) => spinner.update(msg),
    });

    spinner.stop('Contract deployed');

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
  const { dappDir, info, address, circuit, callArgs } = resolveContractCallRequest(args);

  const { runCall } = await import('../lib/contract/runner.ts');

  if (!jsonMode) {
    process.stderr.write('\n' + header('Contract Call') + '\n\n');
  }

  const target = resolvePayingTarget(args, 'contract', 'call');
  const { network, networkConfig } = target;

  if (!jsonMode) {
    process.stderr.write(keyValue('Contract', info.name) + '\n');
    process.stderr.write(keyValue('Circuit', circuit) + '\n');
    process.stderr.write(keyValue('Address', address.slice(0, 20) + '...') + '\n\n');
  }

  await assertWalletCanPay(target, getFlag(args, 'wallet'), jsonMode ? silentSpinner() : startSpinner('Checking wallet...'));

  const serve = await openPayingServe(target, getFlag(args, 'wallet'), jsonMode ? silentSpinner() : startSpinner('Starting mn serve...'));
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

    spinner.stop(`${circuit} called`);

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
  validateContractAddress(address);

  const { runState } = await import('../lib/contract/runner.ts');

  const { network, networkConfig } = resolvePayingTarget(args, 'contract', 'state');

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

    spinner.stop('State retrieved');

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
