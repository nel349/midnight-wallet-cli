import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import addressCommand from '../commands/address.ts';
import { parseArgs } from '../lib/argv.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';

const TEST_SEED = '0000000000000000000000000000000000000000000000000000000000000002';
const TEST_DIR = path.join(os.tmpdir(), `midnight-address-cmd-test-${process.pid}`);

let io: CapturedOutput;

beforeEach(() => {
  process.env.NO_COLOR = '';
  delete process.env.MN_SEED;
  fs.mkdirSync(TEST_DIR, { recursive: true });
  io = captureOutput();
});

afterEach(() => {
  delete process.env.NO_COLOR;
  delete process.env.MN_SEED;
  io.restore();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('address command', () => {
  it('derives address and outputs to stdout', async () => {
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed']);
    await addressCommand(args);
    const out = io.stdout().trim();
    expect(out.startsWith('mn_addr_undeployed1')).toBe(true);
  });

  it('outputs bare address to stdout (single line, pipeable)', async () => {
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'preprod']);
    await addressCommand(args);
    const lines = io.stdout().trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith('mn_addr_preprod1')).toBe(true);
  });

  it('stderr contains metadata', async () => {
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'preprod']);
    await addressCommand(args);
    const err = io.stderr();
    expect(err).toContain('Network');
    expect(err).toContain('preprod');
    expect(err).toContain('Index');
    expect(err).toContain('0');
    expect(err).toContain('Path');
  });

  it('supports --index flag for key derivation', async () => {
    const args0 = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed', '--index', '0']);
    await addressCommand(args0);
    const addr0 = io.stdout().trim();

    io.clearStdout();
    const args1 = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed', '--index', '1']);
    await addressCommand(args1);
    const addr1 = io.stdout().trim();

    expect(addr0).not.toBe(addr1);
    expect(addr1.startsWith('mn_addr_undeployed1')).toBe(true);
  });

  it('stderr shows the correct key index', async () => {
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed', '--index', '3']);
    await addressCommand(args);
    const err = io.stderr();
    expect(err).toContain('3');
    expect(err).toContain('NightExternal/3');
  });

  it('accepts 0x-prefixed seed', async () => {
    const args = parseArgs(['address', '--seed', '0x' + TEST_SEED, '--network', 'undeployed']);
    await addressCommand(args);
    const out = io.stdout().trim();
    expect(out.startsWith('mn_addr_undeployed1')).toBe(true);
  });

  it('resolves the seed from MN_SEED when --seed is absent', async () => {
    const refArgs = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed']);
    await addressCommand(refArgs);
    const fromFlag = io.stdout().trim();

    io.clearStdout();
    process.env.MN_SEED = TEST_SEED;
    const envArgs = parseArgs(['address', '--network', 'undeployed']);
    await addressCommand(envArgs);
    const fromEnv = io.stdout().trim();

    expect(fromEnv).toBe(fromFlag);
  });

  it('lets --seed win over MN_SEED', async () => {
    const otherSeed = '0000000000000000000000000000000000000000000000000000000000000003';
    process.env.MN_SEED = otherSeed;
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed']);
    await addressCommand(args);
    const fromFlag = io.stdout().trim();

    io.clearStdout();
    delete process.env.MN_SEED;
    await addressCommand(parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed']));
    const seedOnly = io.stdout().trim();

    expect(fromFlag).toBe(seedOnly);
  });

  it('derives the address from a saved wallet via --wallet', async () => {
    const walletFile = path.join(TEST_DIR, 'alice.json');
    fs.writeFileSync(walletFile, JSON.stringify({
      seed: TEST_SEED,
      addresses: {},
      createdAt: new Date().toISOString(),
    }));

    const refArgs = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed']);
    await addressCommand(refArgs);
    const fromSeed = io.stdout().trim();

    io.clearStdout();
    const walletArgs = parseArgs(['address', '--wallet', walletFile, '--network', 'undeployed']);
    await addressCommand(walletArgs);
    const fromWallet = io.stdout().trim();

    expect(fromWallet).toBe(fromSeed);
  });
});

describe('address command — error handling', () => {
  it('throws a clear error naming every seed source when none is provided', async () => {
    const args = parseArgs(['address', '--network', 'undeployed']);
    await expect(addressCommand(args)).rejects.toThrow('address needs a seed source');
    await expect(addressCommand(args)).rejects.toThrow('--seed');
    await expect(addressCommand(args)).rejects.toThrow('MN_SEED');
    await expect(addressCommand(args)).rejects.toThrow('--wallet');
  });

  it('throws for an invalid MN_SEED', async () => {
    process.env.MN_SEED = 'aabb';
    const args = parseArgs(['address', '--network', 'undeployed']);
    await expect(addressCommand(args)).rejects.toThrow('64-character hex string');
    await expect(addressCommand(args)).rejects.toThrow('MN_SEED');
  });

  it('throws for non-hex seed', async () => {
    const args = parseArgs(['address', '--seed', 'not-a-hex-string-at-all!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!', '--network', 'undeployed']);
    await expect(addressCommand(args)).rejects.toThrow('64-character hex string');
  });

  it('throws for short seed', async () => {
    const args = parseArgs(['address', '--seed', 'aabb', '--network', 'undeployed']);
    await expect(addressCommand(args)).rejects.toThrow('64-character hex string');
  });

  it('throws for negative key index', async () => {
    // Construct args manually since the parser treats -1 as a flag (starts with -)
    const args = {
      command: 'address' as string | undefined,
      subcommand: undefined,
      positionals: [] as string[],
      flags: { seed: TEST_SEED, network: 'undeployed', index: '-1' } as Record<string, string | true>,
    };
    await expect(addressCommand(args)).rejects.toThrow('non-negative integer');
  });

  it('throws for non-numeric key index', async () => {
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed', '--index', 'abc']);
    await expect(addressCommand(args)).rejects.toThrow('non-negative integer');
  });

  it('throws for float key index', async () => {
    const args = parseArgs(['address', '--seed', TEST_SEED, '--network', 'undeployed', '--index', '2.5']);
    await expect(addressCommand(args)).rejects.toThrow('non-negative integer');
  });
});
