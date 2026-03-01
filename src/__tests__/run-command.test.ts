import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { captureCommand } from '../lib/run-command.ts';
import { parseArgs, type ParsedArgs } from '../lib/argv.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import generateCommand from '../commands/generate.ts';
import infoCommand from '../commands/info.ts';
import addressCommand from '../commands/address.ts';
import genesisAddressCommand from '../commands/genesis-address.ts';
import inspectCostCommand from '../commands/inspect-cost.ts';
import { saveWalletConfig, type WalletConfig } from '../lib/wallet-config.ts';

const TEST_DIR = path.join(os.tmpdir(), `midnight-run-cmd-test-${process.pid}`);
const TEST_SEED = '0000000000000000000000000000000000000000000000000000000000000002';

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

describe('captureCommand', () => {
  it('captures JSON output from generate command', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    const args = parseArgs(['generate', '--network', 'undeployed', '--output', walletFile]);
    const result = await captureCommand(generateCommand, args);

    expect(result.address).toBeDefined();
    expect((result.address as string).startsWith('mn_addr_undeployed1')).toBe(true);
    expect(result.network).toBe('undeployed');
    expect(result.seed).toBeDefined();
  });

  it('captures JSON output from info command', async () => {
    const walletFile = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(TEST_CONFIG, walletFile);

    const args = parseArgs(['info', '--wallet', walletFile]);
    const result = await captureCommand(infoCommand, args);

    expect(result.address).toBe('mn_addr_preprod1qqqqqqtest');
    expect(result.network).toBe('preprod');
    expect(result.createdAt).toBe('2026-01-15T10:30:00.000Z');
  });

  it('captures JSON output from address command', async () => {
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed']);
    const result = await captureCommand(addressCommand, args);

    expect((result.address as string).startsWith('mn_addr_undeployed1')).toBe(true);
    expect(result.network).toBe('undeployed');
    expect(result.index).toBe(0);
  });

  it('captures JSON output from genesis-address command', async () => {
    const args = parseArgs(['genesis-address', '--network', 'undeployed']);
    const result = await captureCommand(genesisAddressCommand, args);

    expect((result.address as string).startsWith('mn_addr_undeployed1')).toBe(true);
    expect(result.network).toBe('undeployed');
  });

  it('captures JSON output from inspect-cost command', async () => {
    const args = parseArgs(['inspect-cost']);
    const result = await captureCommand(inspectCostCommand, args);

    expect(result.readTime).toBeDefined();
    expect(result.computeTime).toBeDefined();
    expect(result.blockUsage).toBeDefined();
    expect(result.bytesWritten).toBeDefined();
    expect(result.bytesChurned).toBeDefined();
  });

  it('does not leak to real stdout or stderr', async () => {
    const args = parseArgs(['genesis-address', '--network', 'undeployed']);
    await captureCommand(genesisAddressCommand, args);

    // captureOutput intercepts real stdout/stderr — if captureCommand leaked,
    // we'd see output here
    expect(io.stdout()).toBe('');
    expect(io.stderr()).toBe('');
  });

  it('throws original error when handler fails', async () => {
    const args = parseArgs(['info', '--wallet', path.join(TEST_DIR, 'nonexistent.json')]);
    await expect(captureCommand(infoCommand, args)).rejects.toThrow('Wallet file not found');
  });

  it('restores stdout/stderr even when handler throws', async () => {
    const args = parseArgs(['info', '--wallet', path.join(TEST_DIR, 'nonexistent.json')]);
    try { await captureCommand(infoCommand, args); } catch {}

    // Verify stdout/stderr are restored by writing to them
    io.clearStdout();
    io.clearStderr();
    process.stdout.write('test-stdout');
    process.stderr.write('test-stderr');
    expect(io.stdout()).toBe('test-stdout');
    expect(io.stderr()).toBe('test-stderr');
  });
});
