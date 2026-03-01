import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import balanceCommand from '../commands/balance.ts';
import { parseArgs } from '../lib/argv.ts';
import { saveWalletConfig, type WalletConfig } from '../lib/wallet-config.ts';
import { deriveUnshieldedAddress } from '../lib/derive-address.ts';
import { GENESIS_SEED } from '../lib/constants.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Tests that connect to the local indexer require Docker (midnight localnet up).
// GitHub Actions sets CI=true — skip integration tests there.
const HAS_INDEXER = !process.env.CI;

const TEST_DIR = path.join(os.tmpdir(), `midnight-balance-cmd-test-${process.pid}`);

// Derive real valid addresses for testing against the local undeployed indexer
const genesisSeedBuffer = Buffer.from(GENESIS_SEED, 'hex');
const GENESIS_UNDEPLOYED_ADDRESS = deriveUnshieldedAddress(genesisSeedBuffer, 'undeployed');

// A different seed with no balance — used to test "No balance found" path
const EMPTY_SEED = '0000000000000000000000000000000000000000000000000000000000000099';
const EMPTY_ADDRESS = deriveUnshieldedAddress(Buffer.from(EMPTY_SEED, 'hex'), 'undeployed');

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

describe('balance command — address resolution errors', () => {
  it('throws when no address given and wallet file is missing', async () => {
    const args = parseArgs(['balance', '--wallet', path.join(TEST_DIR, 'nonexistent.json')]);
    await expect(balanceCommand(args)).rejects.toThrow('Wallet file not found');
  });
});

describe.skipIf(!HAS_INDEXER)('balance command — reads address from wallet file', () => {
  it('loads address from wallet file and queries local indexer', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const config: WalletConfig = {
      seed: GENESIS_SEED,
      network: 'undeployed',
      address: GENESIS_UNDEPLOYED_ADDRESS,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    saveWalletConfig(config, walletFile);

    const args = parseArgs(['balance', '--wallet', walletFile]);
    await balanceCommand(args);

    const err = io.stderr();
    expect(err).toContain('Balance');
    expect(err).toContain(GENESIS_UNDEPLOYED_ADDRESS);
    expect(err).toContain('undeployed');
    expect(err).toContain('UTXOs');
    expect(err).toContain('Transactions');
  });
});

describe.skipIf(!HAS_INDEXER)('balance command — positional address with local indexer', () => {
  it('checks balance for the genesis address on undeployed', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--network', 'undeployed']);
    await balanceCommand(args);

    const err = io.stderr();
    expect(err).toContain('Balance');
    expect(err).toContain(GENESIS_UNDEPLOYED_ADDRESS);
    expect(err).toContain('undeployed');
    expect(err).toContain('UTXOs');
    expect(err).toContain('Transactions');
  });

  it('auto-detects undeployed network from address prefix', async () => {
    // No --network flag — should detect 'undeployed' from the address prefix
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS]);
    await balanceCommand(args);

    const err = io.stderr();
    expect(err).toContain('undeployed');
  });

  it('outputs NIGHT balance to stdout for genesis address', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--network', 'undeployed']);
    await balanceCommand(args);

    const out = io.stdout();
    // Genesis address on local undeployed should have funds — stdout has bare NIGHT=<amount>
    expect(out).toContain('NIGHT=');
  });

  it('outputs "0" to stdout for an unfunded address', async () => {
    const args = parseArgs(['balance', EMPTY_ADDRESS, '--network', 'undeployed']);
    await balanceCommand(args);

    const out = io.stdout().trim();
    expect(out).toBe('0');
    const err = io.stderr();
    expect(err).toContain('No balance found');
  });
});

describe('balance command — --indexer-ws override', () => {
  it('uses custom indexer WS URL and fails on invalid one', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--indexer-ws', 'ws://localhost:19999']);
    try {
      await balanceCommand(args);
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.message).toContain('WebSocket');
    }
  });
});

describe.skipIf(!HAS_INDEXER)('balance command — JSON output', () => {
  it('outputs valid JSON with all expected fields', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--network', 'undeployed', '--json']);
    await balanceCommand(args);

    const data = JSON.parse(io.stdout().trim());
    expect(data.address).toBe(GENESIS_UNDEPLOYED_ADDRESS);
    expect(data.network).toBe('undeployed');
    expect(data.balances).toBeDefined();
    expect(typeof data.utxoCount).toBe('number');
    expect(typeof data.txCount).toBe('number');
  });

  it('reports NIGHT balance in NIGHT units (not micro-NIGHT)', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--network', 'undeployed', '--json']);
    await balanceCommand(args);

    const data = JSON.parse(io.stdout().trim());
    const nightBalance = data.balances.NIGHT;
    if (nightBalance) {
      // Should contain a decimal point (NIGHT format), not raw micro-NIGHT
      expect(nightBalance).toContain('.');
      // Should have exactly 6 decimal places
      const decimals = nightBalance.split('.')[1];
      expect(decimals.length).toBe(6);
    }
  });

  it('does not write formatted headers/tables to stderr in JSON mode', async () => {
    // Note: spinner output still goes to stderr at the command level.
    // Full stderr suppression happens globally in wallet.ts entry point.
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--network', 'undeployed', '--json']);
    await balanceCommand(args);
    const err = io.stderr();
    // Should NOT contain formatted output (headers, key-value pairs, dividers)
    expect(err).not.toContain('Balance');
    expect(err).not.toContain('Address');
    expect(err).not.toContain('UTXOs');
    expect(err).not.toContain('─');
  });
});

describe.skipIf(!HAS_INDEXER)('balance command — spinner lifecycle', () => {
  it('shows syncing progress on stderr for successful check', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--network', 'undeployed']);
    await balanceCommand(args);

    const err = io.stderr();
    // Spinner should show progress and complete with ✓
    expect(err).toContain('Checking balance');
    expect(err).toContain('✓');
  });

  it('stops spinner with "Failed" on connection error', async () => {
    const args = parseArgs(['balance', GENESIS_UNDEPLOYED_ADDRESS, '--indexer-ws', 'ws://localhost:19999']);
    try {
      await balanceCommand(args);
    } catch {
      const err = io.stderr();
      expect(err).toContain('Failed');
    }
  });
});
