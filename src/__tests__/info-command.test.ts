import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import infoCommand from '../commands/info.ts';
import { parseArgs } from '../lib/argv.ts';
import { saveWalletConfig, type WalletConfig } from '../lib/wallet-config.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `midnight-info-cmd-test-${process.pid}`);

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

describe('info command — stdout (pipeable data)', () => {
  it('outputs bare address to stdout', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile]);
    await infoCommand(args);
    const out = io.stdout().trim();
    expect(out).toBe('mn_addr_preprod1qqqqqqtest');
  });
});

describe('info command — stderr (formatted details)', () => {
  it('displays wallet address', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile]);
    await infoCommand(args);
    const err = io.stderr();
    expect(err).toContain('mn_addr_preprod1qqqqqqtest');
  });

  it('displays wallet network', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile]);
    await infoCommand(args);
    const err = io.stderr();
    expect(err).toContain('preprod');
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
