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
