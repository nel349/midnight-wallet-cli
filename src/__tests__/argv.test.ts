import { describe, it, expect } from 'vitest';
import { parseArgs, getFlag, hasFlag, requireFlag, type ParsedArgs } from '../lib/argv.ts';

describe('parseArgs', () => {
  it('parses command from first positional', () => {
    const result = parseArgs(['help']);
    expect(result.command).toBe('help');
  });

  it('parses subcommand from second positional', () => {
    const result = parseArgs(['config', 'set']);
    expect(result.command).toBe('config');
    expect(result.subcommand).toBe('set');
  });

  it('collects remaining positionals after command and subcommand', () => {
    const result = parseArgs(['config', 'set', 'network', 'preprod']);
    expect(result.command).toBe('config');
    expect(result.subcommand).toBe('set');
    expect(result.positionals).toEqual(['network', 'preprod']);
  });

  it('parses --flag value pairs', () => {
    const result = parseArgs(['generate', '--network', 'preprod']);
    expect(result.command).toBe('generate');
    expect(result.flags.network).toBe('preprod');
  });

  it('parses boolean --flag at end of argv', () => {
    const result = parseArgs(['help', '--verbose']);
    expect(result.flags.verbose).toBe(true);
  });

  it('parses boolean --flag before another --flag', () => {
    const result = parseArgs(['--verbose', '--network', 'preprod']);
    expect(result.flags.verbose).toBe(true);
    expect(result.flags.network).toBe('preprod');
  });

  it('handles empty argv', () => {
    const result = parseArgs([]);
    expect(result.command).toBeUndefined();
    expect(result.subcommand).toBeUndefined();
    expect(result.positionals).toEqual([]);
    expect(result.flags).toEqual({});
  });

  it('parses short flags like -h', () => {
    const result = parseArgs(['-h']);
    expect(result.flags.h).toBe(true);
  });

  it('handles mixed positionals and flags', () => {
    const result = parseArgs(['balance', 'mn_addr_preprod1abc', '--network', 'preprod', '--indexer-ws', 'ws://localhost:8088']);
    expect(result.command).toBe('balance');
    expect(result.subcommand).toBe('mn_addr_preprod1abc');
    expect(result.flags.network).toBe('preprod');
    expect(result.flags['indexer-ws']).toBe('ws://localhost:8088');
  });

  it('handles flag at the very end of argv', () => {
    const result = parseArgs(['generate', '--network']);
    expect(result.command).toBe('generate');
    expect(result.flags.network).toBe(true);
  });

  it('does not consume a short flag as a value for a long flag', () => {
    // --network -h should NOT set network to "-h"
    const result = parseArgs(['--network', '-h']);
    expect(result.flags.network).toBe(true);
    expect(result.flags.h).toBe(true);
  });

  it('does not consume a long flag as a value for another long flag', () => {
    const result = parseArgs(['--verbose', '--network', 'preprod']);
    expect(result.flags.verbose).toBe(true);
    expect(result.flags.network).toBe('preprod');
  });

  it('uses process.argv.slice(2) by default when no argv provided', () => {
    // Just verifying the function signature works without args
    const result = parseArgs(undefined);
    expect(result).toBeDefined();
    expect(result.flags).toBeDefined();
  });
});

describe('getFlag', () => {
  const args: ParsedArgs = {
    command: 'test',
    subcommand: undefined,
    positionals: [],
    flags: { network: 'preprod', verbose: true },
  };

  it('returns string value for a present flag', () => {
    expect(getFlag(args, 'network')).toBe('preprod');
  });

  it('returns undefined for a missing flag', () => {
    expect(getFlag(args, 'missing')).toBeUndefined();
  });

  it('returns undefined for a boolean flag (no value)', () => {
    expect(getFlag(args, 'verbose')).toBeUndefined();
  });
});

describe('hasFlag', () => {
  const args: ParsedArgs = {
    command: 'test',
    subcommand: undefined,
    positionals: [],
    flags: { network: 'preprod', verbose: true },
  };

  it('returns true for a present flag with value', () => {
    expect(hasFlag(args, 'network')).toBe(true);
  });

  it('returns true for a present boolean flag', () => {
    expect(hasFlag(args, 'verbose')).toBe(true);
  });

  it('returns false for a missing flag', () => {
    expect(hasFlag(args, 'missing')).toBe(false);
  });
});

describe('requireFlag', () => {
  const args: ParsedArgs = {
    command: 'test',
    subcommand: undefined,
    positionals: [],
    flags: { network: 'preprod', verbose: true },
  };

  it('returns value for a present flag', () => {
    expect(requireFlag(args, 'network', 'name')).toBe('preprod');
  });

  it('throws for a missing flag with descriptive message', () => {
    expect(() => requireFlag(args, 'seed', 'hex')).toThrow('Missing required flag');
    expect(() => requireFlag(args, 'seed', 'hex')).toThrow('--seed');
    expect(() => requireFlag(args, 'seed', 'hex')).toThrow('<hex>');
  });

  it('throws for a boolean-only flag (no value)', () => {
    expect(() => requireFlag(args, 'verbose', 'level')).toThrow('Missing required flag');
  });
});
