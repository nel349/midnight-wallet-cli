import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import inspectCostCommand from '../commands/inspect-cost.ts';
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

describe('inspect-cost command — stdout (pipeable data)', () => {
  it('outputs all 5 dimensions as key=value pairs', async () => {
    const args = parseArgs(['inspect-cost']);
    await inspectCostCommand(args);
    const out = io.stdout();
    expect(out).toContain('readTime=');
    expect(out).toContain('computeTime=');
    expect(out).toContain('blockUsage=');
    expect(out).toContain('bytesWritten=');
    expect(out).toContain('bytesChurned=');
  });

  it('outputs positive numeric values', async () => {
    const args = parseArgs(['inspect-cost']);
    await inspectCostCommand(args);
    const out = io.stdout();
    const lines = out.trim().split('\n');
    for (const line of lines) {
      const [, value] = line.split('=');
      expect(Number(value)).toBeGreaterThan(0);
    }
  });
});

describe('inspect-cost command — stderr (formatted details)', () => {
  it('displays block limits header', async () => {
    const args = parseArgs(['inspect-cost']);
    await inspectCostCommand(args);
    const err = io.stderr();
    expect(err).toContain('Block Limits');
  });

  it('displays units for each dimension', async () => {
    const args = parseArgs(['inspect-cost']);
    await inspectCostCommand(args);
    const err = io.stderr();
    expect(err).toContain('picoseconds');
    expect(err).toContain('bytes');
  });

  it('includes bytesWritten constraint note', async () => {
    const args = parseArgs(['inspect-cost']);
    await inspectCostCommand(args);
    const err = io.stderr();
    expect(err).toContain('tightest constraint');
  });

  it('mentions LedgerParameters as the source', async () => {
    const args = parseArgs(['inspect-cost']);
    await inspectCostCommand(args);
    const err = io.stderr();
    expect(err).toContain('LedgerParameters');
  });
});
