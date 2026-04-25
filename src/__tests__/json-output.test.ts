import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseArgs } from '../lib/argv.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import { classifyError, EXIT_WALLET_NOT_FOUND, EXIT_INVALID_ARGS, EXIT_CANCELLED, EXIT_NETWORK_ERROR, EXIT_INSUFFICIENT_BALANCE, EXIT_TX_REJECTED, EXIT_GENERAL_ERROR, ERROR_CODES } from '../lib/exit-codes.ts';
import { writeJsonResult, writeJsonError } from '../lib/json-output.ts';
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
import { deriveAllAddresses } from '../lib/derive-address.ts';
import { loadCliConfig } from '../lib/cli-config.ts';

const TEST_DIR = path.join(os.tmpdir(), `midnight-json-test-${process.pid}`);
const TEST_SEED = '0000000000000000000000000000000000000000000000000000000000000002';

const TEST_CONFIG_SEED = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const TEST_CONFIG: WalletConfig = {
  seed: TEST_CONFIG_SEED,
  addresses: deriveAllAddresses(Buffer.from(TEST_CONFIG_SEED, 'hex')),
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

  it('classifies "Failed to prove transaction" as PROOF_FAILURE', () => {
    const { exitCode, errorCode } = classifyError(new Error('Failed to prove transaction'));
    expect(exitCode).toBe(EXIT_TX_REJECTED);
    expect(errorCode).toBe(ERROR_CODES.PROOF_FAILURE);
  });

  it('classifies "Custom error 170" as INVALID_DUST_PROOF', () => {
    const { exitCode, errorCode } = classifyError(new Error('Transaction failed: error 170 InvalidDustSpendProof'));
    expect(exitCode).toBe(EXIT_TX_REJECTED);
    expect(errorCode).toBe(ERROR_CODES.INVALID_DUST_PROOF);
  });

  it('classifies stale-cache messages as STALE_CACHE', () => {
    const { exitCode, errorCode } = classifyError(new Error('Stale cache: applied > highest'));
    expect(exitCode).toBe(EXIT_TX_REJECTED);
    expect(errorCode).toBe(ERROR_CODES.STALE_CACHE);
  });

  it('classifies "Wallet sync timed out" as SYNC_TIMEOUT', () => {
    const { exitCode, errorCode } = classifyError(new Error('Wallet sync timed out'));
    expect(exitCode).toBe(EXIT_NETWORK_ERROR);
    expect(errorCode).toBe(ERROR_CODES.SYNC_TIMEOUT);
  });

  it('classifies "Timed out waiting for dust tokens" as SYNC_TIMEOUT', () => {
    const { exitCode, errorCode } = classifyError(new Error('Timed out waiting for dust tokens'));
    expect(exitCode).toBe(EXIT_NETWORK_ERROR);
    expect(errorCode).toBe(ERROR_CODES.SYNC_TIMEOUT);
  });

  it('classifies "did not respond within 30s" (proof-server gate) as SYNC_TIMEOUT', () => {
    const { exitCode, errorCode } = classifyError(new Error('Proof server at http://localhost:6300/ did not respond within 30s'));
    expect(exitCode).toBe(EXIT_NETWORK_ERROR);
    expect(errorCode).toBe(ERROR_CODES.SYNC_TIMEOUT);
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

    expect(data.addresses).toBeDefined();
    const addrs = data.addresses as Record<string, string>;
    expect(addrs.undeployed.startsWith('mn_addr_undeployed1')).toBe(true);
    expect(addrs.preprod.startsWith('mn_addr_preprod1')).toBe(true);
    expect(addrs.preview.startsWith('mn_addr_preview1')).toBe(true);
    expect(data.activeNetwork).toBe('undeployed');
    expect(data.activeAddress).toBe(addrs.undeployed);
    expect(data.seed).toBeDefined();
    expect((data.seed as string).length).toBe(128); // 64 bytes from mnemonicToSeedSync (Lace-compatible)
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

    const args = parseArgs(['info', '--wallet', walletFile, '--network', 'undeployed', '--json']);
    await infoCommand(args);
    const data = parseJsonOutput();

    expect(data.addresses).toBeDefined();
    expect(data.activeNetwork).toBe('undeployed');
    expect(data.activeAddress).toBe(TEST_CONFIG.addresses.undeployed);
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
    expect(flagNames).toContain('--wallet <name|file>');
    expect(flagNames).toContain('--network <name>');
  });

  it('every command has jsonFields', async () => {
    const args = parseArgs(['help', '--json']);
    await helpCommand(args);
    const data = parseJsonOutput();

    const commands = data.commands as Array<Record<string, unknown>>;
    // Interactive commands (dev) don't emit structured JSON output.
    const COMMANDS_WITHOUT_JSON = new Set(['dev']);
    for (const cmd of commands) {
      if (COMMANDS_WITHOUT_JSON.has(cmd.name as string)) continue;
      expect(cmd.jsonFields, `command "${cmd.name}" is missing jsonFields`).toBeDefined();
      expect(Object.keys(cmd.jsonFields as object).length).toBeGreaterThan(0);
    }
  });
});
