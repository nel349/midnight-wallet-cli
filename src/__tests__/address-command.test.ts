import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import addressCommand from '../commands/address.ts';
import { parseArgs } from '../lib/argv.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';

const TEST_SEED = '0000000000000000000000000000000000000000000000000000000000000002';

let io: CapturedOutput;

beforeEach(() => {
  process.env.NO_COLOR = '';
  io = captureOutput();
});

afterEach(() => {
  delete process.env.NO_COLOR;
  io.restore();
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
});

describe('address command — error handling', () => {
  it('throws when --seed is missing', async () => {
    const args = parseArgs(['address', '--network', 'undeployed']);
    await expect(addressCommand(args)).rejects.toThrow('Missing required flag');
    await expect(addressCommand(args)).rejects.toThrow('--seed');
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
