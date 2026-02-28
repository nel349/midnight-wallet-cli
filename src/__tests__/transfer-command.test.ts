import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import transferCommand from '../commands/transfer.ts';
import { parseArgs } from '../lib/argv.ts';
import { saveWalletConfig, type WalletConfig } from '../lib/wallet-config.ts';
import { deriveUnshieldedAddress } from '../lib/derive-address.ts';
import { GENESIS_SEED } from '../lib/constants.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TEST_DIR = path.join(os.tmpdir(), `midnight-transfer-cmd-test-${process.pid}`);
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

describe('transfer command — argument validation', () => {
  it('throws when no recipient address is given', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      network: 'undeployed',
      address: deriveUnshieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'undeployed'),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['transfer', '--wallet', walletFile]);
    await expect(transferCommand(args)).rejects.toThrow('Missing recipient address');
  });

  it('throws when no amount is given', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      network: 'undeployed',
      address: deriveUnshieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'undeployed'),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const recipientAddr = deriveUnshieldedAddress(Buffer.from(GENESIS_SEED, 'hex'), 'undeployed');
    const args = parseArgs(['transfer', recipientAddr, '--wallet', walletFile]);
    await expect(transferCommand(args)).rejects.toThrow('Missing amount');
  });

  it('throws for invalid amount', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      network: 'undeployed',
      address: deriveUnshieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'undeployed'),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const recipientAddr = deriveUnshieldedAddress(Buffer.from(GENESIS_SEED, 'hex'), 'undeployed');
    const args = parseArgs(['transfer', recipientAddr, 'notanumber', '--wallet', walletFile]);
    await expect(transferCommand(args)).rejects.toThrow('Invalid amount');
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

    const recipientAddr = deriveUnshieldedAddress(Buffer.from(GENESIS_SEED, 'hex'), 'undeployed');
    const args = parseArgs(['transfer', recipientAddr, '0', '--wallet', walletFile]);
    await expect(transferCommand(args)).rejects.toThrow('greater than 0');
  });

  it('throws when no wallet file exists', async () => {
    const recipientAddr = deriveUnshieldedAddress(Buffer.from(GENESIS_SEED, 'hex'), 'undeployed');
    const args = parseArgs(['transfer', recipientAddr, '100', '--wallet', path.join(TEST_DIR, 'nonexistent.json')]);
    await expect(transferCommand(args)).rejects.toThrow('Wallet file not found');
  });
});

describe('transfer command — address validation errors', () => {
  it('rejects garbage recipient address', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      network: 'undeployed',
      address: deriveUnshieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'undeployed'),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    // This will fail at validateRecipientAddress inside executeTransfer
    // but the transfer command catches the --wallet flag parsing first, then
    // shows the header, starts the spinner, then calls executeTransfer which validates
    const args = parseArgs(['transfer', 'not-a-valid-address', '100', '--wallet', walletFile]);
    await expect(transferCommand(args)).rejects.toThrow('Invalid recipient address');
  });

  it('rejects address for wrong network', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      network: 'undeployed',
      address: deriveUnshieldedAddress(Buffer.from(TEST_SEED, 'hex'), 'undeployed'),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    // Preprod address on undeployed network
    const preprodAddr = deriveUnshieldedAddress(Buffer.from(GENESIS_SEED, 'hex'), 'preprod');
    const args = parseArgs(['transfer', preprodAddr, '100', '--wallet', walletFile]);
    await expect(transferCommand(args)).rejects.toThrow('Invalid recipient address');
  });
});
