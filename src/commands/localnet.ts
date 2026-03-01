// localnet command — manage local Midnight network via Docker Compose
// Subcommands: up, down, status, logs

import { spawn } from 'child_process';
import { type ParsedArgs, hasFlag } from '../lib/argv.ts';
import {
  checkDockerAvailable,
  ensureComposeFile,
  dockerCompose,
  getServiceStatus,
  waitForHealthy,
  getComposePath,
  removeConflictingContainers,
} from '../lib/localnet.ts';
import { header, divider } from '../ui/format.ts';
import { bold, green, red, dim, yellow } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';
import { writeJsonResult } from '../lib/json-output.ts';

const VALID_SUBCOMMANDS = ['up', 'stop', 'down', 'status', 'logs', 'clean'] as const;
type Subcommand = typeof VALID_SUBCOMMANDS[number];

function isValidSubcommand(s: string): s is Subcommand {
  return (VALID_SUBCOMMANDS as readonly string[]).includes(s);
}

function formatServiceTable(services: ReturnType<typeof getServiceStatus>): string {
  const lines: string[] = [];
  for (const svc of services) {
    const stateColor = svc.state === 'running' ? green : red;
    const healthStr = svc.health ? ` (${svc.health})` : '';
    const portStr = svc.port ? `:${svc.port}` : '';
    lines.push(`  ${svc.name.padEnd(16)}${stateColor(svc.state)}${dim(healthStr)}${dim(portStr)}`);
  }
  return lines.join('\n');
}

async function handleUp(jsonMode: boolean): Promise<void> {
  const wrote = ensureComposeFile();
  if (wrote) {
    process.stderr.write(dim(`  Wrote compose.yml to ${getComposePath()}`) + '\n');
  }

  const spinner = startSpinner('Starting local network...');

  try {
    dockerCompose('up -d');
    spinner.update('Waiting for services to be healthy...');

    const healthy = waitForHealthy(120_000);

    if (!healthy) {
      spinner.stop(yellow('Services started but not all healthy yet'));
      process.stderr.write('\n' + dim('  Tip: run ') + bold('midnight localnet logs') + dim(' to check for errors') + '\n');
    } else {
      spinner.stop('Local network is running');
    }
  } catch (err) {
    spinner.stop(red('Failed to start local network'));
    if (err instanceof Error) {
      if (err.message.includes('is already in use by container')) {
        throw new Error(
          'Container name conflict — containers with the same names already exist\n' +
          '(likely from a previous midnight-local-network setup).\n\n' +
          'Run "midnight localnet clean" to remove them, then try again.'
        );
      }
      if (err.message.includes('address already in use')) {
        throw new Error(
          'Port conflict detected — another process is using a required port.\n' +
          'Check ports 9944, 8088, and 6300, then try again.'
        );
      }
    }
    throw err;
  }

  // Show status table
  const services = getServiceStatus();

  if (jsonMode) {
    writeJsonResult({
      subcommand: 'up',
      services: services.map(s => ({ name: s.name, state: s.state, port: s.port, health: s.health })),
    });
    return;
  }

  if (services.length > 0) {
    process.stderr.write('\n' + formatServiceTable(services) + '\n');
  }

  // Machine-readable output to stdout
  for (const svc of services) {
    process.stdout.write(`${svc.name}=${svc.state}:${svc.port}\n`);
  }

  process.stderr.write('\n' + dim('  Next: ') + bold('midnight generate --network undeployed') + '\n');
}

async function handleStop(jsonMode: boolean): Promise<void> {
  const spinner = startSpinner('Stopping local network...');

  try {
    dockerCompose('stop');
    spinner.stop('Local network stopped (containers preserved)');
    if (jsonMode) {
      writeJsonResult({ subcommand: 'stop', status: 'stopped' });
      return;
    }
  } catch (err) {
    spinner.stop(red('Failed to stop local network'));
    throw err;
  }
}

async function handleDown(jsonMode: boolean): Promise<void> {
  const spinner = startSpinner('Tearing down local network...');

  try {
    dockerCompose('down --volumes');
    spinner.stop('Local network removed (containers, networks, volumes)');
    if (jsonMode) {
      writeJsonResult({ subcommand: 'down', status: 'removed' });
      return;
    }
  } catch (err) {
    spinner.stop(red('Failed to tear down local network'));
    throw err;
  }
}

async function handleStatus(jsonMode: boolean): Promise<void> {
  const services = getServiceStatus();

  if (jsonMode) {
    writeJsonResult({
      subcommand: 'status',
      services: services.map(s => ({ name: s.name, state: s.state, port: s.port, health: s.health })),
    });
    return;
  }

  if (services.length === 0) {
    process.stderr.write('\n' + header('Localnet Status') + '\n\n');
    process.stderr.write(dim('  No services running.') + '\n');
    process.stderr.write(dim('  Run ') + bold('midnight localnet up') + dim(' to start.') + '\n\n');
    return;
  }

  process.stderr.write('\n' + header('Localnet Status') + '\n\n');
  process.stderr.write(formatServiceTable(services) + '\n');
  process.stderr.write('\n' + divider() + '\n\n');

  // Machine-readable output to stdout
  for (const svc of services) {
    process.stdout.write(`${svc.name}=${svc.state}:${svc.port}\n`);
  }
}

async function handleClean(jsonMode: boolean): Promise<void> {
  const spinner = startSpinner('Removing conflicting containers...');

  try {
    // First try compose down to clean up any compose-managed resources
    try { dockerCompose('down'); } catch { /* may fail if compose file doesn't match */ }

    // Force-remove containers by name regardless of origin
    const removed = removeConflictingContainers();

    if (removed.length > 0) {
      spinner.stop(`Removed ${removed.length} container${removed.length > 1 ? 's' : ''}: ${removed.join(', ')}`);
    } else {
      spinner.stop('No conflicting containers found');
    }

    if (jsonMode) {
      writeJsonResult({ subcommand: 'clean', status: 'cleaned', removed });
      return;
    }
  } catch (err) {
    spinner.stop(red('Failed to clean up'));
    throw err;
  }
}

async function handleLogs(): Promise<void> {
  const composePath = getComposePath();

  // Stream logs directly to terminal via spawn with inherited stdio
  const child = spawn('docker', ['compose', '-f', composePath, 'logs', '-f'], {
    stdio: 'inherit',
  });

  // Wait for the child to exit (user will Ctrl+C)
  return new Promise<void>((resolve, reject) => {
    child.on('close', (code) => {
      // Exit code 130 = SIGINT (Ctrl+C), which is normal
      if (code === 0 || code === 130 || code === null) {
        resolve();
      } else {
        reject(new Error(`docker compose logs exited with code ${code}`));
      }
    });
    child.on('error', reject);
  });
}

export default async function localnetCommand(args: ParsedArgs): Promise<void> {
  const subcommand = args.subcommand;

  if (!subcommand || !isValidSubcommand(subcommand)) {
    throw new Error(
      `Usage: midnight localnet <${VALID_SUBCOMMANDS.join('|')}>\n\n` +
      `Subcommands:\n` +
      `  up        Start the local network\n` +
      `  stop      Stop containers (preserves state)\n` +
      `  down      Remove containers, networks, volumes\n` +
      `  status    Show service status\n` +
      `  logs      Stream service logs\n` +
      `  clean     Remove conflicting containers\n\n` +
      `Example: midnight localnet up`
    );
  }

  // Check Docker is available before any operation
  checkDockerAvailable();

  const jsonMode = hasFlag(args, 'json');

  process.stderr.write('\n' + header('Localnet') + '\n\n');

  switch (subcommand) {
    case 'up':
      return handleUp(jsonMode);
    case 'stop':
      return handleStop(jsonMode);
    case 'down':
      return handleDown(jsonMode);
    case 'status':
      return handleStatus(jsonMode);
    case 'logs':
      return handleLogs();
    case 'clean':
      return handleClean(jsonMode);
  }
}
