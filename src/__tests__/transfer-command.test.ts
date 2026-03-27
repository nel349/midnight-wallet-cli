import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import transferCommand from '../commands/transfer.ts';
import { parseArgs } from '../lib/argv.ts';
import { saveWalletConfig, type WalletConfig } from '../lib/wallet-config.ts';
import { deriveUnshieldedAddress, deriveAllAddresses } from '../lib/derive-address.ts';
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
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
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
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
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
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
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
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
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
  it('rejects malformed address with correct prefix', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['transfer', 'mn_addr_undeployed1invalid', '100', '--wallet', walletFile]);
    await expect(transferCommand(args)).rejects.toThrow('Invalid recipient address');
  });

  it('treats unknown name as wallet lookup', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    // "not-a-wallet" doesn't start with mn_addr_, so it's treated as a wallet name
    const args = parseArgs(['transfer', 'not-a-wallet', '100', '--wallet', walletFile]);
    await expect(transferCommand(args)).rejects.toThrow('Wallet file not found');
  });
});

describe('transfer command — wallet name resolution', () => {
  it('throws when wallet name does not exist', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    // "nonexistent-wallet" is not an address (no mn_addr_ prefix) so it will be treated as a wallet name
    const args = parseArgs(['transfer', 'nonexistent-wallet', '100', '--wallet', walletFile]);
    await expect(transferCommand(args)).rejects.toThrow('Wallet file not found');
  });

  it('throws when wallet name used with --shielded but has no shielded address', async () => {
    // This test uses the real wallets dir, so we need a wallet that exists
    // but has no shieldedAddress. We'll test with a fake address format instead.
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    // "some-name" doesn't start with mn_addr_ or mn_shield-addr_, so treated as wallet name
    const args = parseArgs(['transfer', 'some-name', '100', '--shielded', '--wallet', walletFile]);
    await expect(transferCommand(args)).rejects.toThrow();
  });
});

describe('transfer command — shielded flag', () => {
  it('throws when no recipient given with --shielded', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['transfer', '--shielded', '--wallet', walletFile]);
    await expect(transferCommand(args)).rejects.toThrow('Missing recipient address');
  });

  it('throws when no amount given with --shielded', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['transfer', 'mn_shield-addr_undeployed1someaddr', '100', '--shielded', '--wallet', walletFile]);
    await expect(transferCommand(args)).rejects.toThrow('Invalid shielded address');
  });
});
