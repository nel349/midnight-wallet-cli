import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import helpCommand, { COMMAND_SPECS } from '../commands/help.ts';
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

describe('help command — general help', () => {
  it('displays the logo on stderr', async () => {
    const args = parseArgs(['help']);
    await helpCommand(args);
    const err = io.stderr();
    expect(err).toContain('██████████████');
    expect(err).toContain('m i d n i g h t');
  });

  it('displays command table on stdout', async () => {
    const args = parseArgs(['help']);
    await helpCommand(args);
    const out = io.stdout();
    expect(out).toContain('Commands');
    for (const spec of COMMAND_SPECS) {
      expect(out).toContain(spec.name);
    }
  });

  it('lists all 8 commands', async () => {
    const args = parseArgs(['help']);
    await helpCommand(args);
    const out = io.stdout();
    expect(out).toContain('generate');
    expect(out).toContain('info');
    expect(out).toContain('balance');
    expect(out).toContain('address');
    expect(out).toContain('genesis-address');
    expect(out).toContain('inspect-cost');
    expect(out).toContain('config');
    expect(out).toContain('help');
  });
});

describe('help command — specific command help', () => {
  it('shows usage for balance command', async () => {
    const args = parseArgs(['help', 'balance']);
    await helpCommand(args);
    const out = io.stdout();
    expect(out).toContain('balance');
    expect(out).toContain('Usage:');
    expect(out).toContain('--network');
    expect(out).toContain('Examples:');
  });

  it('shows usage for generate command', async () => {
    const args = parseArgs(['help', 'generate']);
    await helpCommand(args);
    const out = io.stdout();
    expect(out).toContain('generate');
    expect(out).toContain('--seed');
    expect(out).toContain('--mnemonic');
    expect(out).toContain('--output');
  });

  it('shows flags section for commands that have flags', async () => {
    const args = parseArgs(['help', 'address']);
    await helpCommand(args);
    const out = io.stdout();
    expect(out).toContain('Flags:');
    expect(out).toContain('--seed');
    expect(out).toContain('--index');
  });

  it('throws for unknown command with available list', async () => {
    const args = parseArgs(['help', 'nonexistent']);
    await expect(helpCommand(args)).rejects.toThrow('Unknown command');
    await expect(helpCommand(args)).rejects.toThrow('nonexistent');
    await expect(helpCommand(args)).rejects.toThrow('Available commands');
  });
});

describe('COMMAND_SPECS', () => {
  it('every spec has a name and description', () => {
    for (const spec of COMMAND_SPECS) {
      expect(spec.name.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.usage.length).toBeGreaterThan(0);
    }
  });

  it('every spec has at least one example', () => {
    for (const spec of COMMAND_SPECS) {
      expect(spec.examples?.length).toBeGreaterThan(0);
    }
  });
});
