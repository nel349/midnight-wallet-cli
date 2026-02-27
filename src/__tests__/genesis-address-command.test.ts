import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import genesisAddressCommand from '../commands/genesis-address.ts';
import { parseArgs } from '../lib/argv.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';

let io: CapturedOutput;

beforeEach(() => {
  process.env.NO_COLOR = '';
  io = captureOutput();
});

afterEach(() => {
  delete process.env.NO_COLOR;
  io.restore();
});

describe('genesis-address command', () => {
  it('outputs undeployed genesis address to stdout', async () => {
    const args = parseArgs(['genesis-address', '--network', 'undeployed']);
    await genesisAddressCommand(args);
    const out = io.stdout().trim();
    expect(out.startsWith('mn_addr_undeployed1')).toBe(true);
  });

  it('outputs preprod genesis address to stdout', async () => {
    const args = parseArgs(['genesis-address', '--network', 'preprod']);
    await genesisAddressCommand(args);
    const out = io.stdout().trim();
    expect(out.startsWith('mn_addr_preprod1')).toBe(true);
  });

  it('outputs preview genesis address to stdout', async () => {
    const args = parseArgs(['genesis-address', '--network', 'preview']);
    await genesisAddressCommand(args);
    const out = io.stdout().trim();
    expect(out.startsWith('mn_addr_preview1')).toBe(true);
  });

  it('stdout contains only the bare address (pipeable)', async () => {
    const args = parseArgs(['genesis-address', '--network', 'undeployed']);
    await genesisAddressCommand(args);
    const lines = io.stdout().trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith('mn_addr_')).toBe(true);
  });

  it('stderr contains metadata (network, address, seed)', async () => {
    const args = parseArgs(['genesis-address', '--network', 'preprod']);
    await genesisAddressCommand(args);
    const err = io.stderr();
    expect(err).toContain('Network');
    expect(err).toContain('preprod');
    expect(err).toContain('Address');
    expect(err).toContain('genesis');
  });

  it('same network always produces the same genesis address', async () => {
    const args1 = parseArgs(['genesis-address', '--network', 'undeployed']);
    await genesisAddressCommand(args1);
    const addr1 = io.stdout().trim();

    io.clearStdout();
    const args2 = parseArgs(['genesis-address', '--network', 'undeployed']);
    await genesisAddressCommand(args2);
    const addr2 = io.stdout().trim();

    expect(addr1).toBe(addr2);
  });

  it('different networks produce different genesis addresses', async () => {
    const args1 = parseArgs(['genesis-address', '--network', 'undeployed']);
    await genesisAddressCommand(args1);
    const addr1 = io.stdout().trim();

    io.clearStdout();
    const args2 = parseArgs(['genesis-address', '--network', 'preprod']);
    await genesisAddressCommand(args2);
    const addr2 = io.stdout().trim();

    expect(addr1).not.toBe(addr2);
  });
});
