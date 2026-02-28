import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import airdropCommand from '../commands/airdrop.ts';
import { parseArgs } from '../lib/argv.ts';
import { saveWalletConfig, type WalletConfig } from '../lib/wallet-config.ts';
import { deriveUnshieldedAddress } from '../lib/derive-address.ts';
import { GENESIS_SEED } from '../lib/constants.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `midnight-airdrop-cmd-test-${process.pid}`);
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

describe('airdrop command — argument validation', () => {
  it('throws when no amount is given', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      network: 'undeployed',
      address: deriveUnshieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'undeployed'),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '--wallet', walletFile]);
    await expect(airdropCommand(args)).rejects.toThrow('Missing amount');
  });

  it('throws for non-numeric amount', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      network: 'undeployed',
      address: deriveUnshieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'undeployed'),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', 'abc', '--wallet', walletFile]);
    await expect(airdropCommand(args)).rejects.toThrow('Invalid amount');
  });

  it('throws for zero amount', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      network: 'undeployed',
      address: deriveUnshieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'undeployed'),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '0', '--wallet', walletFile]);
    await expect(airdropCommand(args)).rejects.toThrow('greater than 0');
  });

  it('throws for negative amount (parsed as flag by argv)', async () => {
    // Note: "-5" starts with "-" so the argv parser treats it as a short flag,
    // making subcommand undefined → "Missing amount" error
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      network: 'undeployed',
      address: deriveUnshieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'undeployed'),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '-5', '--wallet', walletFile]);
    await expect(airdropCommand(args)).rejects.toThrow('Missing amount');
  });

  it('throws when no wallet file exists', async () => {
    const args = parseArgs(['airdrop', '100', '--wallet', path.join(TEST_DIR, 'nonexistent.json')]);
    await expect(airdropCommand(args)).rejects.toThrow('Wallet file not found');
  });
});

describe('airdrop command — network restriction', () => {
  it('rejects airdrop on preprod network', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      network: 'preprod',
      address: deriveUnshieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'preprod'),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '100', '--wallet', walletFile]);
    await expect(airdropCommand(args)).rejects.toThrow('only available on the "undeployed" network');
  });

  it('rejects airdrop on preview network', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      network: 'preview',
      address: deriveUnshieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'preview'),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '100', '--wallet', walletFile]);
    await expect(airdropCommand(args)).rejects.toThrow('only available on the "undeployed" network');
  });

  it('includes current network name in rejection message', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      network: 'preprod',
      address: deriveUnshieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'preprod'),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '100', '--wallet', walletFile]);
    await expect(airdropCommand(args)).rejects.toThrow('"preprod"');
  });
});
