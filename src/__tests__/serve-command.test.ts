// Tests for the serve command's approval flags (argv only; nothing is loaded or synced).

import { describe, it, expect } from 'vitest';
import serveCommand from '../commands/serve.ts';
import { parseArgs } from '../lib/argv.ts';
import { UsageError } from '../lib/errors.ts';
import { findUnknownFlags } from '../lib/command-flags.ts';

describe('serve --approve-fees', () => {
  it('is a flag serve accepts', () => {
    expect(findUnknownFlags(parseArgs(['serve', '--approve-fees']))).toEqual([]);
  });

  it('refuses to combine with --approve-all, before loading any wallet', async () => {
    const err = await serveCommand(parseArgs(['serve', '--approve-all', '--approve-fees', '--wallet', '/nonexistent/wallet.json']))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain('--approve-all and --approve-fees conflict');
  });
});

describe('serve --max-fee / --max-pending', () => {
  it.each([
    [['--max-fee', '0.5'], /only apply with --approve-fees/],
    [['--max-pending', '3'], /only apply with --approve-fees/],
    [['--approve-fees', '--max-fee', 'lots'], /--max-fee must be a positive DUST amount/],
    [['--approve-fees', '--max-pending', '0'], /--max-pending must be a whole number/],
  ])('rejects %j with a usage error before any wallet loads', async (flags, message) => {
    const err = await serveCommand(parseArgs(['serve', ...flags])).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toMatch(message);
  });
});
