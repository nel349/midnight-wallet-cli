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
 * Require a flag value — throws a descriptive error if missing.
 */
export function requireFlag(args: ParsedArgs, name: string, description: string): string {
  const value = getFlag(args, name);
  if (value === undefined) {
    throw new Error(`Missing required flag: --${name} <${description}>`);
  }
  return value;
}
