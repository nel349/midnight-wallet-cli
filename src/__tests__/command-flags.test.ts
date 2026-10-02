// Unknown-flag rejection. mn used to ignore any flag it didn't recognise, so a
// malformed argument (an unsplit "--network x --node y" string) was dropped
// and the command fell back to default endpoints, landing a transaction on
// the wrong chain. These tests pin the rejection, and keep the registry of
// accepted flags in lockstep with the flags each command's code really reads.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from '../lib/argv.ts';
import { UsageError } from '../lib/errors.ts';
import { COMMAND_FLAGS, GLOBAL_FLAGS, findUnknownFlags, assertKnownFlags } from '../lib/command-flags.ts';

describe('assertKnownFlags', () => {
  it('rejects an unsplit multi-flag argument (one token containing spaces), before anything runs', () => {
    const args = parseArgs([
      'airdrop', '100', '--shielded', '--wallet', 'alice',
      '--network undeployed --node ws://localhost:9944 --indexer-ws ws://localhost:8088/api/v4/graphql/ws',
    ]);
    let err: unknown;
    try { assertKnownFlags(args); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UsageError);
    expect((err as Error).message).toContain('--network undeployed --node ws://localhost:9944');
    expect((err as Error).message).toContain('midnight help airdrop');
  });

  it('accepts every flag a command really reads', () => {
    const args = parseArgs([
      'airdrop', '100', '--shielded', '--wallet', 'alice', '--network', 'undeployed',
      '--node', 'ws://n', '--indexer-ws', 'ws://i', '--proof-server', 'http://p', '--verbose', '--json',
    ]);
    expect(() => assertKnownFlags(args)).not.toThrow();
  });

  it('accepts the global flags on every command', () => {
    for (const command of Object.keys(COMMAND_FLAGS)) {
      const args = parseArgs([command, ...GLOBAL_FLAGS.map((f) => (f.length === 1 ? `-${f}` : `--${f}`))]);
      expect(findUnknownFlags(args), command).toEqual([]);
    }
  });

  it('rejects a real flag on a command that does not use it, and names every unknown flag', () => {
    const args = parseArgs(['localnet', 'up', '--seed', 'abc', '--node', 'ws://n']);
    expect(findUnknownFlags(args)).toEqual(['seed', 'node']);
    expect(() => assertKnownFlags(args)).toThrow(/--seed.*--node|--node.*--seed/s);
  });

  it('leaves an unknown command to the dispatcher, which reports it by name', () => {
    expect(findUnknownFlags(parseArgs(['no-such-command', '--anything']))).toEqual([]);
  });
});

describe('COMMAND_FLAGS matches the code', () => {
  // A flag a command reads but the registry lacks would be rejected even
  // though it works; a registry entry no code reads would be accepted and
  // silently ignored (the bug this guards against). Derive each command's
  // flags from its source and require equality.
  const COMMANDS_DIR = join(import.meta.dirname, '..', 'commands');
  const LITERAL_READ = /(?:getFlag|hasFlag|requireFlag)\(\s*\w+\s*,\s*['"]([a-z0-9-]+)['"]/g;
  // Shared helpers that read flags on the command's behalf.
  const HELPER_FLAGS: Record<string, string[]> = {
    'resolveNetwork(': ['network'],
    'resolveNetworkName(': ['network'],
    'resolveSeedSource(': ['seed', 'wallet'],
    'resolveSeed(': ['seed', 'wallet'],
    'isVerbose(': ['verbose'],
    'rejectNoCacheForWrites(': ['no-cache'],
  };

  function flagsReadBy(source: string): Set<string> {
    const flags = new Set<string>();
    for (const m of source.matchAll(LITERAL_READ)) flags.add(m[1]!);
    for (const [call, implied] of Object.entries(HELPER_FLAGS)) {
      if (source.includes(call)) implied.forEach((f) => flags.add(f));
    }
    for (const g of GLOBAL_FLAGS) flags.delete(g);
    return flags;
  }

  const commandFiles = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.ts'));

  it('has an entry for every command file, and no entry without one', () => {
    expect(Object.keys(COMMAND_FLAGS).sort()).toEqual(commandFiles.map((f) => f.replace(/\.ts$/, '')).sort());
  });

  it.each(commandFiles.map((f) => f.replace(/\.ts$/, '')))('%s: registry equals the flags its code reads', (command) => {
    const source = readFileSync(join(COMMANDS_DIR, `${command}.ts`), 'utf-8');
    expect([...COMMAND_FLAGS[command]!].sort()).toEqual([...flagsReadBy(source)].sort());
  });
});
