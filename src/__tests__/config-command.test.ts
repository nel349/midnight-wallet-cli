import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import configCommand from '../commands/config.ts';
import { parseArgs } from '../lib/argv.ts';
import { loadCliConfig } from '../lib/cli-config.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';

let io: CapturedOutput;

// Save the original config value before tests, restore after
let originalNetwork: string;

beforeEach(() => {
  process.env.NO_COLOR = '';
  originalNetwork = loadCliConfig().network;
  io = captureOutput();
});

afterEach(async () => {
  delete process.env.NO_COLOR;
  io.restore();
  // Restore original config to avoid side effects
  if (loadCliConfig().network !== originalNetwork) {
    const restoreIo = captureOutput();
    await configCommand(parseArgs(['config', 'set', 'network', originalNetwork]));
    restoreIo.restore();
  }
});

describe('config command — error handling', () => {
  it('throws when no subcommand (get/set) provided', async () => {
    const args = parseArgs(['config']);
    await expect(configCommand(args)).rejects.toThrow('Usage:');
    await expect(configCommand(args)).rejects.toThrow('get|set');
  });

  it('throws for invalid subcommand', async () => {
    const args = parseArgs(['config', 'delete', 'network']);
    await expect(configCommand(args)).rejects.toThrow('Usage:');
  });

  it('throws when key is missing for get', async () => {
    const args = parseArgs(['config', 'get']);
    await expect(configCommand(args)).rejects.toThrow('Missing config key');
    await expect(configCommand(args)).rejects.toThrow('Valid keys:');
  });

  it('throws when key is missing for set', async () => {
    const args = parseArgs(['config', 'set']);
    await expect(configCommand(args)).rejects.toThrow('Missing config key');
  });

  it('throws when value is missing for set', async () => {
    const args = parseArgs(['config', 'set', 'network']);
    await expect(configCommand(args)).rejects.toThrow('Missing value');
  });

  it('throws for unknown config key on get', async () => {
    const args = parseArgs(['config', 'get', 'bogus']);
    await expect(configCommand(args)).rejects.toThrow('Unknown config key');
  });

  it('throws for invalid network value on set', async () => {
    const args = parseArgs(['config', 'set', 'network', 'mainnet']);
    await expect(configCommand(args)).rejects.toThrow('Invalid network');
  });
});

describe('config command — get', () => {
  it('outputs network value to stdout', async () => {
    const args = parseArgs(['config', 'get', 'network']);
    await configCommand(args);
    const out = io.stdout();
    expect(out).toMatch(/^(preprod|preview|undeployed)\n$/);
  });
});

describe('config command — set + get round-trip', () => {
  it('set persists value that get reads back', async () => {
    // Set to preprod
    const setArgs = parseArgs(['config', 'set', 'network', 'preprod']);
    await configCommand(setArgs);
    const err = io.stderr();
    expect(err).toContain('network = preprod');
    expect(err).toContain('✓');

    // Get should return preprod
    io.clearStdout();
    const getArgs = parseArgs(['config', 'get', 'network']);
    await configCommand(getArgs);
    expect(io.stdout()).toBe('preprod\n');
  });
});
