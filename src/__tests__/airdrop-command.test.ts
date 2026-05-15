import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import airdropCommand from '../commands/airdrop.ts';
import { parseArgs } from '../lib/argv.ts';
import { saveWalletConfig, type WalletConfig } from '../lib/wallet-config.ts';
import { deriveAllAddresses } from '../lib/derive-address.ts';
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
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
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
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
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
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
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
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '-5', '--wallet', walletFile]);
    await expect(airdropCommand(args)).rejects.toThrow('Missing amount');
  });

  it('throws when no wallet file exists', async () => {
    // --network undeployed pinned so the test passes regardless of the
    // developer's ~/.midnight/config.json (resolveNetwork reads the real
    // config dir; the airdrop entry-point bails out on non-undeployed
    // networks BEFORE attempting to load the wallet file).
    const args = parseArgs(['airdrop', '100', '--wallet', path.join(TEST_DIR, 'nonexistent.json'), '--network', 'undeployed']);
    await expect(airdropCommand(args)).rejects.toThrow('Wallet file not found');
  });
});

describe('airdrop command — network restriction', () => {
  it('rejects airdrop on preprod network', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '100', '--wallet', walletFile, '--network', 'preprod']);
    await expect(airdropCommand(args)).rejects.toThrow('only available on the "undeployed" network');
  });

  it('rejects airdrop on preview network', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '100', '--wallet', walletFile, '--network', 'preview']);
    await expect(airdropCommand(args)).rejects.toThrow('only available on the "undeployed" network');
  });

  it('includes current network name in rejection message', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '100', '--wallet', walletFile, '--network', 'preprod']);
    await expect(airdropCommand(args)).rejects.toThrow('"preprod"');
  });
});

describe('airdrop command — address as destination', () => {
  // --network undeployed pinned on each test so they pass regardless of the
  // developer's ~/.midnight/config.json (resolveNetwork reads the real config
  // dir; without the pin, a preprod-default config short-circuits these tests
  // at the network-restriction check before address validation runs).

  it('rejects a shielded address when --shielded is not passed', async () => {
    const args = parseArgs([
      'airdrop',
      '100',
      '--wallet',
      'mn_shield-addr_undeployed1abcdef',
      '--network', 'undeployed',
    ]);
    await expect(airdropCommand(args)).rejects.toThrow(/shielded address but --shielded was not passed/);
  });

  it('rejects an unshielded address when --shielded is passed', async () => {
    const args = parseArgs([
      'airdrop',
      '100',
      '--shielded',
      '--wallet',
      'mn_addr_undeployed1abcdef',
      '--network', 'undeployed',
    ]);
    await expect(airdropCommand(args)).rejects.toThrow(/--shielded was passed but --wallet is an unshielded address/);
  });

  it('rejects an address whose prefix does not match the resolved network', async () => {
    const args = parseArgs([
      'airdrop',
      '100',
      '--wallet',
      'mn_addr_preprod1abcdef',
      '--network', 'undeployed',
    ]);
    await expect(airdropCommand(args)).rejects.toThrow(/does not match network "undeployed"/);
  });

  it('rejects an unshielded address when running against preprod', async () => {
    // The "only on undeployed" rule fires before address validation
    const args = parseArgs([
      'airdrop',
      '100',
      '--wallet',
      'mn_addr_preprod1abcdef',
      '--network',
      'preprod',
    ]);
    await expect(airdropCommand(args)).rejects.toThrow('only available on the "undeployed" network');
  });
});

describe('airdrop command — shielded flag', () => {
  it('rejects shielded airdrop on preprod', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '100', '--shielded', '--wallet', walletFile, '--network', 'preprod']);
    await expect(airdropCommand(args)).rejects.toThrow('only available on the "undeployed" network');
  });

  it('throws when no amount given with --shielded', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: TEST_SEED,
      addresses: deriveAllAddresses(Buffer.from(TEST_SEED, 'hex')),
      createdAt: new Date().toISOString(),
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['airdrop', '--shielded', '--wallet', walletFile]);
    await expect(airdropCommand(args)).rejects.toThrow('Missing amount');
  });
});
