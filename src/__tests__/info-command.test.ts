import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import infoCommand from '../commands/info.ts';
import { parseArgs } from '../lib/argv.ts';
import { saveWalletConfig, type WalletConfig } from '../lib/wallet-config.ts';
import { deriveAllAddresses } from '../lib/derive-address.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `midnight-info-cmd-test-${process.pid}`);

const TEST_SEED = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const TEST_ADDRESSES = deriveAllAddresses(Buffer.from(TEST_SEED, 'hex'));

const TEST_CONFIG: WalletConfig = {
  seed: TEST_SEED,
  addresses: TEST_ADDRESSES,
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

describe('info command — stdout (pipeable data)', () => {
  it('outputs bare address to stdout', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile, '--network', 'undeployed']);
    await infoCommand(args);
    const out = io.stdout().trim();
    expect(out).toBe(TEST_ADDRESSES.undeployed);
  });
});

describe('info command — stderr (formatted details)', () => {
  it('displays wallet address', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile]);
    await infoCommand(args);
    const err = io.stderr();
    expect(err).toContain(TEST_ADDRESSES.undeployed);
  });

  it('displays active network', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile]);
    await infoCommand(args);
    const err = io.stderr();
    expect(err).toContain('(active)');
    expect(err).toContain('undeployed');
  });

  it('displays creation date', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile]);
    await infoCommand(args);
    const err = io.stderr();
    expect(err).toContain('2026-01-15T10:30:00.000Z');
  });

  it('displays file path', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile]);
    await infoCommand(args);
    const err = io.stderr();
    expect(err).toContain(walletFile);
  });

  it('includes header', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile]);
    await infoCommand(args);
    const err = io.stderr();
    expect(err).toContain('Wallet Info');
  });

  it('does NOT show seed (no secrets)', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile]);
    await infoCommand(args);
    const out = io.stdout();
    const err = io.stderr();
    expect(out).not.toContain(TEST_CONFIG.seed);
    expect(err).not.toContain(TEST_CONFIG.seed);
  });
});

describe('info command — error handling', () => {
  it('throws when wallet file does not exist', async () => {
    const args = parseArgs(['info', '--wallet', path.join(TEST_DIR, 'nonexistent.json')]);
    await expect(infoCommand(args)).rejects.toThrow('Wallet file not found');
  });
});
