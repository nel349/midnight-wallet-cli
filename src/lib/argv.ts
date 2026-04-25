// Minimal argument parser for process.argv
// No external dependencies — raw argv parsing

export interface ParsedArgs {
  command: string | undefined;
  subcommand: string | undefined;
  positionals: string[];
  flags: Record<string, string | true>;
}

/**
 * Parse process.argv into structured command, subcommand, positionals, and flags.
 * First non-flag arg = command, second = subcommand, rest = positionals.
 * --key value pairs become flags. --key at end of argv becomes boolean true.
 */
export function parseArgs(argv?: string[]): ParsedArgs {
  const args = argv ?? process.argv.slice(2);
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // Short flag like -h
      const key = arg.slice(1);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positionals.push(arg);
      i += 1;
    }
  }

  return {
    command: positionals[0],
    subcommand: positionals[1],
    positionals: positionals.slice(2),
    flags,
  };
}

/**
 * Get a flag value as string, or undefined if not present.
 */
export function getFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  if (value === undefined || value === true) return undefined;
  return value;
}

/**
 * Check if a flag is present (boolean or with value).
 */
export function hasFlag(args: ParsedArgs, name: string): boolean {
  return name in args.flags;
}

/**
 * Check if --verbose flag is present.
 * Note: -v is reserved for --version, so only --verbose enables verbose mode.
 */
export function isVerbose(args: ParsedArgs): boolean {
  return hasFlag(args, 'verbose');
}

/**
 * Internal flag names for the agent-slim JSON contract. See
 * lib/run-command.ts for the full contract.
 *   - MINIMAL_FLAG: captureCommand sets this on every MCP-invoked command
 *     so handlers default to a slim shape for agents.
 *   - FULL_FLAG: an MCP tool sets this when the agent passes `full: true`,
 *     telling the handler to emit the human shape instead.
 * Underscore prefix marks them as internal — humans never set these.
 */
export const MINIMAL_FLAG = '_minimal';
export const FULL_FLAG = '_full';

/**
 * True when the handler should emit the agent-slim JSON shape: an MCP
 * caller asked us through captureCommand AND didn't pass `full: true`.
 */
export function isMinimalMode(args: ParsedArgs): boolean {
  return hasFlag(args, MINIMAL_FLAG) && !hasFlag(args, FULL_FLAG);
}

/**
 * Reject `--no-cache` on commands that don't support it (write commands).
 * The SDK's fresh-sync path is too slow on hosted networks to be viable, so
 * writes always use the cache. Users who want a clean state should
 * `mn cache clear` explicitly.
 */
export function rejectNoCacheForWrites(args: ParsedArgs): void {
  if (hasFlag(args, 'no-cache')) {
    throw new Error(
      '--no-cache is not supported on write commands (transfer, airdrop, dust register, serve).\n' +
      'Writes always use the cache — the SDK\'s fresh-sync is too slow on hosted networks.\n' +
      'To reset: midnight cache clear --wallet <name> --network <name>',
    );
  }
}

/**
 * Require a flag value — throws a descriptive error if missing.
 */
export function requireFlag(args: ParsedArgs, name: string, description: string): string {
  const value = getFlag(args, name);
  if (value === undefined) {
    throw new Error(`Missing required flag: --${name} <${description}>`);
  }
  return value;
}
