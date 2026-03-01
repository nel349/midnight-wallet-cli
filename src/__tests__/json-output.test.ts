import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseArgs } from '../lib/argv.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import { classifyError, EXIT_WALLET_NOT_FOUND, EXIT_INVALID_ARGS, EXIT_CANCELLED, EXIT_NETWORK_ERROR, EXIT_INSUFFICIENT_BALANCE, EXIT_TX_REJECTED, EXIT_GENERAL_ERROR, ERROR_CODES } from '../lib/exit-codes.ts';
import { suppressStderr, writeJsonResult, writeJsonError } from '../lib/json-output.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Commands that can be tested without network/Docker
import generateCommand from '../commands/generate.ts';
import infoCommand from '../commands/info.ts';
import addressCommand from '../commands/address.ts';
import genesisAddressCommand from '../commands/genesis-address.ts';
import inspectCostCommand from '../commands/inspect-cost.ts';
import configCommand from '../commands/config.ts';
import helpCommand from '../commands/help.ts';
import { saveWalletConfig, type WalletConfig } from '../lib/wallet-config.ts';
import { loadCliConfig } from '../lib/cli-config.ts';

const TEST_DIR = path.join(os.tmpdir(), `midnight-json-test-${process.pid}`);
const TEST_SEED = '0000000000000000000000000000000000000000000000000000000000000002';

const TEST_CONFIG: WalletConfig = {
  seed: 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233',
  network: 'preprod',
  address: 'mn_addr_preprod1qqqqqqtest',
  createdAt: '2026-01-15T10:30:00.000Z',
};

let io: CapturedOutput;

beforeEach(() => {
  process.env.NO_COLOR = '';
  fs.mkdirSync(TEST_DIR, { recursive: true });
  io = captureOutput();
});

afterEach(() => {
  delete process.env.NO_COLOR;
  io.restore();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// ── Helper: parse stdout as JSON ──────────────────────────
function parseJsonOutput(): Record<string, unknown> {
  const raw = io.stdout().trim();
  return JSON.parse(raw);
}

// ── classifyError ─────────────────────────────────────────
describe('classifyError', () => {
  it('classifies wallet not found', () => {
    const { exitCode, errorCode } = classifyError(new Error('Wallet file not found: /foo/bar'));
    expect(exitCode).toBe(EXIT_WALLET_NOT_FOUND);
    expect(errorCode).toBe(ERROR_CODES.WALLET_NOT_FOUND);
  });

  it('classifies missing required flag as invalid args', () => {
    const { exitCode, errorCode } = classifyError(new Error('Missing required flag: --seed'));
    expect(exitCode).toBe(EXIT_INVALID_ARGS);
    expect(errorCode).toBe(ERROR_CODES.INVALID_ARGS);
  });

  it('classifies unknown command as invalid args', () => {
    const { exitCode, errorCode } = classifyError(new Error('Unknown command: "bogus"'));
    expect(exitCode).toBe(EXIT_INVALID_ARGS);
    expect(errorCode).toBe(ERROR_CODES.INVALID_ARGS);
  });

  it('classifies cancelled operations', () => {
    const { exitCode, errorCode } = classifyError(new Error('Operation cancelled'));
    expect(exitCode).toBe(EXIT_CANCELLED);
    expect(errorCode).toBe(ERROR_CODES.CANCELLED);
  });

  it('classifies connection errors', () => {
    const { exitCode, errorCode } = classifyError(new Error('ECONNREFUSED 127.0.0.1:9944'));
    expect(exitCode).toBe(EXIT_NETWORK_ERROR);
    expect(errorCode).toBe(ERROR_CODES.NETWORK_ERROR);
  });

  it('classifies insufficient balance', () => {
    const { exitCode, errorCode } = classifyError(new Error('Insufficient balance for transfer'));
    expect(exitCode).toBe(EXIT_INSUFFICIENT_BALANCE);
    expect(errorCode).toBe(ERROR_CODES.INSUFFICIENT_BALANCE);
  });

  it('classifies transaction rejected', () => {
    const { exitCode, errorCode } = classifyError(new Error('Transaction rejected by the node'));
    expect(exitCode).toBe(EXIT_TX_REJECTED);
    expect(errorCode).toBe(ERROR_CODES.TX_REJECTED);
  });

  it('classifies stale UTXO', () => {
    const { exitCode, errorCode } = classifyError(new Error('Stale UTXO detected'));
    expect(exitCode).toBe(EXIT_TX_REJECTED);
    expect(errorCode).toBe(ERROR_CODES.STALE_UTXO);
  });

  it('classifies dust errors', () => {
    const { exitCode, errorCode } = classifyError(new Error('No dust available for fee payment'));
    expect(exitCode).toBe(EXIT_INSUFFICIENT_BALANCE);
    expect(errorCode).toBe(ERROR_CODES.DUST_REQUIRED);
  });

  it('returns unknown for unrecognized errors', () => {
    const { exitCode, errorCode } = classifyError(new Error('Something unexpected happened'));
    expect(exitCode).toBe(EXIT_GENERAL_ERROR);
    expect(errorCode).toBe(ERROR_CODES.UNKNOWN);
  });
});

// ── suppressStderr ────────────────────────────────────────
describe('suppressStderr', () => {
  it('suppresses stderr writes', () => {
    io.restore(); // Need real stderr for this test
    const realIo = captureOutput();
    const restore = suppressStderr();
    process.stderr.write('should be suppressed');
    restore();
    // After restore, the captureOutput mock was removed by suppressStderr
    // so we verify the suppression happened by checking that
    // the stderr captured nothing while suppressed
    expect(realIo.stderr()).toBe('');
    realIo.restore();
    io = captureOutput(); // Re-capture for afterEach
  });

  it('restores stderr when called', () => {
    io.restore();
    const restore = suppressStderr();
    restore();
    const realIo = captureOutput();
    process.stderr.write('after restore');
    expect(realIo.stderr()).toBe('after restore');
    realIo.restore();
    io = captureOutput();
  });
});

// ── writeJsonResult ───────────────────────────────────────
describe('writeJsonResult', () => {
  it('writes valid JSON to stdout', () => {
    writeJsonResult({ foo: 'bar', num: 42 });
    const data = parseJsonOutput();
    expect(data.foo).toBe('bar');
    expect(data.num).toBe(42);
  });

  it('outputs a single line ending with newline', () => {
    writeJsonResult({ key: 'value' });
    const raw = io.stdout();
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.trim().split('\n')).toHaveLength(1);
  });
});

// ── writeJsonError ────────────────────────────────────────
describe('writeJsonError', () => {
  it('writes structured error JSON', () => {
    writeJsonError(new Error('test error'), ERROR_CODES.UNKNOWN, 1);
    const data = parseJsonOutput();
    expect(data.error).toBe(true);
    expect(data.code).toBe('UNKNOWN');
    expect(data.message).toBe('test error');
    expect(data.exitCode).toBe(1);
  });
});

// ── generate --json ───────────────────────────────────────
describe('generate --json', () => {
  it('outputs valid JSON with all expected fields', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'undeployed', '--output', walletFile, '--json']);
    await generateCommand(args);
    const data = parseJsonOutput();

    expect(data.address).toBeDefined();
    expect((data.address as string).startsWith('mn_addr_undeployed1')).toBe(true);
    expect(data.network).toBe('undeployed');
    expect(data.seed).toBeDefined();
    expect((data.seed as string).length).toBe(64);
    expect(data.mnemonic).toBeDefined();
    expect((data.mnemonic as string).split(' ').length).toBe(24);
    expect(data.file).toBe(walletFile);
    expect(data.createdAt).toBeDefined();
  });

  it('omits mnemonic in seed mode', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'preprod', '--seed', TEST_SEED, '--output', walletFile, '--json']);
    await generateCommand(args);
    const data = parseJsonOutput();

    expect(data.mnemonic).toBeUndefined();
    expect(data.seed).toBe(TEST_SEED);
  });

  it('produces no stderr output', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'undeployed', '--output', walletFile, '--json']);
    await generateCommand(args);
    expect(io.stderr()).toBe('');
  });
});

// ── info --json ───────────────────────────────────────────
describe('info --json', () => {
  it('outputs valid JSON with wallet info', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile, '--json']);
    await infoCommand(args);
    const data = parseJsonOutput();

    expect(data.address).toBe('mn_addr_preprod1qqqqqqtest');
    expect(data.network).toBe('preprod');
    expect(data.createdAt).toBe('2026-01-15T10:30:00.000Z');
    expect(data.file).toContain(walletFile);
  });

  it('does not include seed in JSON output', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile, '--json']);
    await infoCommand(args);
    const raw = io.stdout();
    expect(raw).not.toContain(TEST_CONFIG.seed);
  });

  it('produces no stderr output', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile, '--json']);
    await infoCommand(args);
    expect(io.stderr()).toBe('');
  });
});

// ── address --json ────────────────────────────────────────
describe('address --json', () => {
  it('outputs valid JSON with address details', async () => {
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed', '--json']);
    await addressCommand(args);
    const data = parseJsonOutput();

    expect((data.address as string).startsWith('mn_addr_undeployed1')).toBe(true);
    expect(data.network).toBe('undeployed');
    expect(data.index).toBe(0);
    expect(data.path).toBe("m/44'/2400'/0'/NightExternal/0");
  });

  it('respects --index flag', async () => {
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed', '--index', '3', '--json']);
    await addressCommand(args);
    const data = parseJsonOutput();

    expect(data.index).toBe(3);
    expect(data.path).toBe("m/44'/2400'/0'/NightExternal/3");
  });

  it('produces no stderr output', async () => {
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed', '--json']);
    await addressCommand(args);
    expect(io.stderr()).toBe('');
  });
});

// ── genesis-address --json ────────────────────────────────
describe('genesis-address --json', () => {
  it('outputs valid JSON with genesis address', async () => {
    const args = parseArgs(['genesis-address', '--network', 'undeployed', '--json']);
    await genesisAddressCommand(args);
    const data = parseJsonOutput();

    expect((data.address as string).startsWith('mn_addr_undeployed1')).toBe(true);
    expect(data.network).toBe('undeployed');
  });

  it('produces no stderr output', async () => {
    const args = parseArgs(['genesis-address', '--network', 'undeployed', '--json']);
    await genesisAddressCommand(args);
    expect(io.stderr()).toBe('');
  });
});

// ── inspect-cost --json ───────────────────────────────────
describe('inspect-cost --json', () => {
  it('outputs valid JSON with all 5 dimensions', async () => {
    const args = parseArgs(['inspect-cost', '--json']);
    await inspectCostCommand(args);
    const data = parseJsonOutput();

    expect(data.readTime).toBeDefined();
    expect(data.computeTime).toBeDefined();
    expect(data.blockUsage).toBeDefined();
    expect(data.bytesWritten).toBeDefined();
    expect(data.bytesChurned).toBeDefined();

    // All values should be positive numbers
    for (const key of ['readTime', 'computeTime', 'blockUsage', 'bytesWritten', 'bytesChurned']) {
      expect(data[key]).toBeGreaterThan(0);
    }
  });

  it('produces no stderr output', async () => {
    const args = parseArgs(['inspect-cost', '--json']);
    await inspectCostCommand(args);
    expect(io.stderr()).toBe('');
  });
});

// ── config --json ─────────────────────────────────────────
describe('config --json', () => {
  let originalNetwork: string;

  beforeEach(() => {
    originalNetwork = loadCliConfig().network;
  });

  afterEach(async () => {
    // Restore original config
    if (loadCliConfig().network !== originalNetwork) {
      io.restore();
      const restoreIo = captureOutput();
      await configCommand(parseArgs(['config', 'set', 'network', originalNetwork]));
      restoreIo.restore();
      io = captureOutput();
    }
  });

  it('config get outputs JSON', async () => {
    const args = parseArgs(['config', 'get', 'network', '--json']);
    await configCommand(args);
    const data = parseJsonOutput();

    expect(data.action).toBe('get');
    expect(data.key).toBe('network');
    expect(data.value).toBeDefined();
  });

  it('config set outputs JSON', async () => {
    const args = parseArgs(['config', 'set', 'network', 'preprod', '--json']);
    await configCommand(args);
    const data = parseJsonOutput();

    expect(data.action).toBe('set');
    expect(data.key).toBe('network');
    expect(data.value).toBe('preprod');
  });
});

// ── help --json ───────────────────────────────────────────
describe('help --json', () => {
  it('outputs valid JSON capability manifest', async () => {
    const args = parseArgs(['help', '--json']);
    await helpCommand(args);
    const data = parseJsonOutput();

    expect(data.cli).toBeDefined();
    const cli = data.cli as Record<string, unknown>;
    expect(cli.name).toBe('midnight-wallet-cli');
    expect(cli.version).toBeDefined();
    expect(cli.bin).toEqual(['midnight', 'mn']);
  });

  it('includes all commands in manifest', async () => {
    const args = parseArgs(['help', '--json']);
    await helpCommand(args);
    const data = parseJsonOutput();

    const commands = data.commands as Array<Record<string, unknown>>;
    const names = commands.map(c => c.name);
    expect(names).toContain('generate');
    expect(names).toContain('info');
    expect(names).toContain('balance');
    expect(names).toContain('address');
    expect(names).toContain('genesis-address');
    expect(names).toContain('inspect-cost');
    expect(names).toContain('airdrop');
    expect(names).toContain('transfer');
    expect(names).toContain('dust');
    expect(names).toContain('config');
    expect(names).toContain('localnet');
    expect(names).toContain('help');
  });

  it('includes global flags', async () => {
    const args = parseArgs(['help', '--json']);
    await helpCommand(args);
    const data = parseJsonOutput();

    const globalFlags = data.globalFlags as Array<Record<string, string>>;
    const flagNames = globalFlags.map(f => f.name);
    expect(flagNames).toContain('--json');
    expect(flagNames).toContain('--wallet <file>');
    expect(flagNames).toContain('--network <name>');
  });

  it('every command has jsonFields', async () => {
    const args = parseArgs(['help', '--json']);
    await helpCommand(args);
    const data = parseJsonOutput();

    const commands = data.commands as Array<Record<string, unknown>>;
    for (const cmd of commands) {
      expect(cmd.jsonFields).toBeDefined();
      expect(Object.keys(cmd.jsonFields as object).length).toBeGreaterThan(0);
    }
  });
});
