import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import helpCommand from '../commands/help.ts';
import { parseArgs } from '../lib/argv.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';

let io: CapturedOutput;
let savedIsTTY: boolean | undefined;

beforeEach(() => {
  process.env.NO_COLOR = '';
  savedIsTTY = process.stderr.isTTY;
  Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
  io = captureOutput();
});

afterEach(() => {
  delete process.env.NO_COLOR;
  Object.defineProperty(process.stderr, 'isTTY', { value: savedIsTTY, configurable: true });
  io.restore();
});

describe('help --agent', () => {
  it('outputs comprehensive agent manual to stdout', async () => {
    const args = parseArgs(['help', '--agent']);
    await helpCommand(args);
    const out = io.stdout();

    expect(out).toContain('AI Agent & MCP Reference');
    expect(out).toContain('STRUCTURED JSON OUTPUT');
    expect(out).toContain('--json');
  });

  it('documents all commands', async () => {
    const args = parseArgs(['help', '--agent']);
    await helpCommand(args);
    const out = io.stdout();

    expect(out).toContain('generate');
    expect(out).toContain('info');
    expect(out).toContain('balance');
    expect(out).toContain('address');
    expect(out).toContain('genesis-address');
    expect(out).toContain('inspect-cost');
    expect(out).toContain('airdrop');
    expect(out).toContain('transfer');
    expect(out).toContain('dust');
    expect(out).toContain('config');
    expect(out).toContain('localnet');
  });

  it('documents error codes', async () => {
    const args = parseArgs(['help', '--agent']);
    await helpCommand(args);
    const out = io.stdout();

    expect(out).toContain('ERROR CODES');
    expect(out).toContain('INVALID_ARGS');
    expect(out).toContain('WALLET_NOT_FOUND');
    expect(out).toContain('NETWORK_ERROR');
    expect(out).toContain('TX_REJECTED');
    expect(out).toContain('CANCELLED');
  });

  it('documents exit codes', async () => {
    const args = parseArgs(['help', '--agent']);
    await helpCommand(args);
    const out = io.stdout();

    expect(out).toContain('EXIT CODES');
    expect(out).toContain('Success');
    expect(out).toContain('Invalid arguments');
    expect(out).toContain('Wallet not found');
  });

  it('documents MCP server setup', async () => {
    const args = parseArgs(['help', '--agent']);
    await helpCommand(args);
    const out = io.stdout();

    expect(out).toContain('MCP SERVER');
    expect(out).toContain('midnight-mcp');
    expect(out).toContain('mcpServers');
  });

  it('includes example workflow', async () => {
    const args = parseArgs(['help', '--agent']);
    await helpCommand(args);
    const out = io.stdout();

    expect(out).toContain('EXAMPLE WORKFLOW');
    expect(out).toContain('midnight generate');
    expect(out).toContain('midnight balance');
    expect(out).toContain('midnight airdrop');
  });

  it('documents capability manifest', async () => {
    const args = parseArgs(['help', '--agent']);
    await helpCommand(args);
    const out = io.stdout();

    expect(out).toContain('CAPABILITY MANIFEST');
    expect(out).toContain('midnight help --json');
  });
});

describe('help screen — mentions --json and --agent', () => {
  it('TTY help mentions --json flag', async () => {
    const args = parseArgs(['help']);
    await helpCommand(args);
    const err = io.stderr();

    expect(err).toContain('--json');
  });

  it('TTY help mentions --agent manual', async () => {
    const args = parseArgs(['help']);
    await helpCommand(args);
    const err = io.stderr();

    expect(err).toContain('--agent');
  });

  it('non-TTY help mentions --json flag', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: undefined, configurable: true });
    const args = parseArgs(['help']);
    await helpCommand(args);
    const err = io.stderr();

    expect(err).toContain('--json');
  });

  it('non-TTY help mentions --agent manual', async () => {
    Object.defineProperty(process.stderr, 'isTTY', { value: undefined, configurable: true });
    const args = parseArgs(['help']);
    await helpCommand(args);
    const err = io.stderr();

    expect(err).toContain('--agent');
  });
});
