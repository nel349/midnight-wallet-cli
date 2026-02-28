import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import dustCommand from '../commands/dust.ts';
import { parseArgs } from '../lib/argv.ts';
import { saveWalletConfig, type WalletConfig } from '../lib/wallet-config.ts';
import { deriveUnshieldedAddress } from '../lib/derive-address.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `midnight-dust-cmd-test-${process.pid}`);
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

describe('dust command — subcommand validation', () => {
  it('throws when no subcommand is given', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      network: 'undeployed',
      address: deriveUnshieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'undeployed'),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['dust', '--wallet', walletFile]);
    await expect(dustCommand(args)).rejects.toThrow('Missing or invalid subcommand');
  });

  it('throws for an unknown subcommand', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      network: 'undeployed',
      address: deriveUnshieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'undeployed'),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['dust', 'foobar', '--wallet', walletFile]);
    await expect(dustCommand(args)).rejects.toThrow('Missing or invalid subcommand');
  });

  it('shows available subcommands in error message', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      network: 'undeployed',
      address: deriveUnshieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'undeployed'),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['dust', '--wallet', walletFile]);
    try {
      await dustCommand(args);
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('register');
      expect(err.message).toContain('status');
    }
  });

  it('throws when no wallet file exists', async () => {
    const args = parseArgs(['dust', 'status', '--wallet', path.join(TEST_DIR, 'nonexistent.json')]);
    await expect(dustCommand(args)).rejects.toThrow('Wallet file not found');
  });
});
