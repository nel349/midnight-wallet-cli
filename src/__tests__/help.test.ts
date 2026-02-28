import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import helpCommand, { COMMAND_SPECS } from '../commands/help.ts';
import { parseArgs } from '../lib/argv.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';

let io: CapturedOutput;
let savedIsTTY: boolean | undefined;

beforeEach(() => {
  process.env.NO_COLOR = '';
  savedIsTTY = process.stderr.isTTY;
  // Ensure the horizontal layout path runs (not the plain-text agent path)
  Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
  io = captureOutput();
});

afterEach(() => {
  delete process.env.NO_COLOR;
  Object.defineProperty(process.stderr, 'isTTY', { value: savedIsTTY, configurable: true });
  io.restore();
});

describe('help command — general help', () => {
  it('displays the logo and commands on stderr (horizontal layout)', async () => {
    const args = parseArgs(['help']);
    await helpCommand(args);
    const err = io.stderr();
    expect(err).toContain('██████████████');
    expect(err).toContain('m i d n i g h t');
    expect(err).toContain('Commands');
  });

  it('lists commands on stderr (limited by logo height)', async () => {
    const args = parseArgs(['help']);
    await helpCommand(args);
    const err = io.stderr();
    // The horizontal layout can show at most ~10 side-content lines
    // (10 logo lines + 1 wordmark line). With 11+ commands,
    // the last briefs may be pushed beyond the visible area.
    expect(err).toContain('generate');
    expect(err).toContain('info');
    expect(err).toContain('balance');
    expect(err).toContain('address');
    expect(err).toContain('genesis-address');
    expect(err).toContain('inspect-cost');
    expect(err).toContain('airdrop');
    expect(err).toContain('transfer');
    expect(err).toContain('dust');
    expect(err).toContain('config');
  });

  it('outputs plain text when stderr is not a TTY (agent-friendly)', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: undefined, configurable: true });
    const args = parseArgs(['help']);
    await helpCommand(args);
    const err = io.stderr();
    // No logo animation
    expect(err).not.toContain('██████████████');
    // Has command list
    expect(err).toContain('Commands');
    expect(err).toContain('generate');
    expect(err).toContain('balance');
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

  it('shows usage for airdrop command', async () => {
    const args = parseArgs(['help', 'airdrop']);
    await helpCommand(args);
    const out = io.stdout();
    expect(out).toContain('airdrop');
    expect(out).toContain('Usage:');
    expect(out).toContain('amount');
    expect(out).toContain('Examples:');
  });

  it('shows usage for transfer command', async () => {
    const args = parseArgs(['help', 'transfer']);
    await helpCommand(args);
    const out = io.stdout();
    expect(out).toContain('transfer');
    expect(out).toContain('Usage:');
    expect(out).toContain('to');
    expect(out).toContain('amount');
    expect(out).toContain('Examples:');
  });

  it('shows usage for dust command', async () => {
    const args = parseArgs(['help', 'dust']);
    await helpCommand(args);
    const out = io.stdout();
    expect(out).toContain('dust');
    expect(out).toContain('Usage:');
    expect(out).toContain('register');
    expect(out).toContain('status');
    expect(out).toContain('Examples:');
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
