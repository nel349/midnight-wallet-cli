import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import generateCommand from '../commands/generate.ts';
import { loadWalletConfig } from '../lib/wallet-config.ts';
import { parseArgs } from '../lib/argv.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `midnight-generate-cmd-test-${process.pid}`);
const TEST_SEED = '0000000000000000000000000000000000000000000000000000000000000002';

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

describe('generate command — random mode', () => {
  it('creates a wallet file with random mnemonic', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'undeployed', '--output', walletFile]);
    await generateCommand(args);

    expect(fs.existsSync(walletFile)).toBe(true);
    const config = loadWalletConfig(walletFile);
    expect(config.network).toBe('undeployed');
    expect(config.mnemonic).toBeDefined();
    expect(config.mnemonic!.split(' ').length).toBe(24);
    expect(config.address.startsWith('mn_addr_undeployed1')).toBe(true);
    expect(config.seed.length).toBe(64);
    expect(config.createdAt).toBeDefined();
  });

  it('outputs address to stdout', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'undeployed', '--output', walletFile]);
    await generateCommand(args);

    const lines = io.stdout().trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith('mn_addr_undeployed1')).toBe(true);
  });

  it('shows mnemonic and seed warnings on stderr', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'undeployed', '--output', walletFile]);
    await generateCommand(args);

    const err = io.stderr();
    expect(err).toContain('MNEMONIC');
    expect(err).toContain('SEED');
    expect(err).toContain('Wallet Generated');
    expect(err).toContain('Wallet saved');
  });
});

describe('generate command — seed mode', () => {
  it('creates a wallet from an explicit seed', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'preprod', '--seed', TEST_SEED, '--output', walletFile]);
    await generateCommand(args);

    const config = loadWalletConfig(walletFile);
    expect(config.seed).toBe(TEST_SEED);
    expect(config.network).toBe('preprod');
    expect(config.mnemonic).toBeUndefined();
    expect(config.address.startsWith('mn_addr_preprod1')).toBe(true);
  });

  it('produces deterministic address from same seed', async () => {
    const file1 = path.join(TEST_DIR, 'wallet1.json');
    const file2 = path.join(TEST_DIR, 'wallet2.json');

    await generateCommand(parseArgs(['generate', '--network', 'preprod', '--seed', TEST_SEED, '--output', file1]));
    io.clearStdout();
    await generateCommand(parseArgs(['generate', '--network', 'preprod', '--seed', TEST_SEED, '--output', file2]));

    const config1 = loadWalletConfig(file1);
    const config2 = loadWalletConfig(file2);
    expect(config1.address).toBe(config2.address);
    expect(config1.seed).toBe(config2.seed);
  });

  it('does not include mnemonic in seed mode', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    await generateCommand(parseArgs(['generate', '--network', 'preprod', '--seed', TEST_SEED, '--output', walletFile]));

    const err = io.stderr();
    expect(err).not.toContain('MNEMONIC');
  });

  it('accepts 0x-prefixed seed', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    await generateCommand(parseArgs(['generate', '--network', 'preprod', '--seed', '0x' + TEST_SEED, '--output', walletFile]));

    const config = loadWalletConfig(walletFile);
    expect(config.seed).toBe(TEST_SEED);
  });
});

describe('generate command — mnemonic mode', () => {
  // Known valid 24-word mnemonic
  const VALID_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

  it('creates a wallet from a mnemonic', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'preview', '--mnemonic', VALID_MNEMONIC, '--output', walletFile]);
    await generateCommand(args);

    const config = loadWalletConfig(walletFile);
    expect(config.network).toBe('preview');
    expect(config.mnemonic).toBe(VALID_MNEMONIC);
    expect(config.address.startsWith('mn_addr_preview1')).toBe(true);
  });

  it('produces deterministic address from same mnemonic', async () => {
    const file1 = path.join(TEST_DIR, 'wallet1.json');
    const file2 = path.join(TEST_DIR, 'wallet2.json');

    await generateCommand(parseArgs(['generate', '--network', 'preview', '--mnemonic', VALID_MNEMONIC, '--output', file1]));
    await generateCommand(parseArgs(['generate', '--network', 'preview', '--mnemonic', VALID_MNEMONIC, '--output', file2]));

    const config1 = loadWalletConfig(file1);
    const config2 = loadWalletConfig(file2);
    expect(config1.address).toBe(config2.address);
    expect(config1.seed).toBe(config2.seed);
  });
});

describe('generate command — error handling', () => {
  it('throws for invalid seed (wrong length)', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'preprod', '--seed', 'aabb', '--output', walletFile]);
    await expect(generateCommand(args)).rejects.toThrow('64-character hex string');
  });

  it('throws for non-hex seed', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'preprod', '--seed', 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', '--output', walletFile]);
    await expect(generateCommand(args)).rejects.toThrow('64-character hex string');
  });

  it('throws for invalid mnemonic', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'preprod', '--mnemonic', 'not a valid mnemonic phrase', '--output', walletFile]);
    await expect(generateCommand(args)).rejects.toThrow('Invalid BIP-39 mnemonic');
  });

  it('throws when both --seed and --mnemonic are specified', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs([
      'generate', '--network', 'preprod',
      '--seed', TEST_SEED,
      '--mnemonic', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
      '--output', walletFile,
    ]);
    await expect(generateCommand(args)).rejects.toThrow('Cannot specify both --seed and --mnemonic');
  });
});

describe('generate command — overwrite protection', () => {
  it('throws when wallet file already exists without --force', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    // Create the file first
    await generateCommand(parseArgs(['generate', '--network', 'undeployed', '--output', walletFile]));
    io.clearStdout();

    // Attempt to generate again without --force
    const args = parseArgs(['generate', '--network', 'undeployed', '--output', walletFile]);
    await expect(generateCommand(args)).rejects.toThrow('Wallet file already exists');
    await expect(generateCommand(args)).rejects.toThrow('--force');
  });

  it('overwrites when --force is specified', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    // Create the file first
    await generateCommand(parseArgs(['generate', '--network', 'undeployed', '--seed', TEST_SEED, '--output', walletFile]));
    const config1 = loadWalletConfig(walletFile);
    io.clearStdout();

    // Generate again with --force and a different seed
    const newSeed = '0000000000000000000000000000000000000000000000000000000000000003';
    await generateCommand(parseArgs(['generate', '--network', 'undeployed', '--seed', newSeed, '--force', '--output', walletFile]));
    const config2 = loadWalletConfig(walletFile);

    expect(config2.seed).toBe(newSeed);
    expect(config2.seed).not.toBe(config1.seed);
  });
});
