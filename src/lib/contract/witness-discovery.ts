// Witness module discovery — single source of truth for where mn looks
// for compiled witnesses.js. Both the deploy preflight (commands/contract.ts,
// commands/dev.ts) and the runtime loader inside the generated deploy script
// (lib/contract/runner.ts) consume this list, so a project that builds in one
// path is found by all callers.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Relative paths checked, in priority order. .js because the deploy script
 * runs through plain `node` (no tsx) — TypeScript sources are not loaded
 * directly. Both flat (src+dist at root) and nested (contract/src+contract/dist)
 * layouts are supported because mn contract deploy may be invoked from either
 * a workspace root or a contract sub-package.
 */
export const WITNESS_FILE_CANDIDATES = [
  'dist/witnesses.js',
  'src/witnesses.js',
  'contract/dist/witnesses.js',
  'contract/src/witnesses.js',
] as const;

/**
 * TypeScript siblings of the .js candidates. Used to detect the
 * "wrote witnesses.ts but didn't build" case so the error can name the
 * specific source file the user already has.
 */
export const WITNESS_SOURCE_CANDIDATES = [
  'src/witnesses.ts',
  'contract/src/witnesses.ts',
] as const;

/** Returns the first witnesses.js path that exists under projectRoot, or null. */
export function findWitnessFile(projectRoot: string): string | null {
  for (const rel of WITNESS_FILE_CANDIDATES) {
    const full = join(projectRoot, rel);
    if (existsSync(full)) return full;
  }
  return null;
}

/** Returns the first witnesses.ts source path that exists, or null. */
export function findWitnessSource(projectRoot: string): string | null {
  for (const rel of WITNESS_SOURCE_CANDIDATES) {
    const full = join(projectRoot, rel);
    if (existsSync(full)) return full;
  }
  return null;
}

/**
 * Build the actionable error shown when a contract declares witnesses but
 * no compiled witnesses.js was found. Names the .ts source if one exists
 * (the most common cause: forgot to build).
 */
export function buildMissingWitnessError(opts: {
  projectRoot: string;
  witnessNames: string[];
}): string {
  const { projectRoot, witnessNames } = opts;
  const tsSource = findWitnessSource(projectRoot);
  const lines: string[] = [
    `Contract declares ${witnessNames.length} witness(es): ${witnessNames.join(', ')}`,
    `but no compiled witnesses module was found.`,
    ``,
    `Searched (relative to ${projectRoot}):`,
    ...WITNESS_FILE_CANDIDATES.map((p) => `  - ${p}`),
    ``,
  ];
  if (tsSource) {
    lines.push(
      `Found ${tsSource} — looks like it isn't compiled yet.`,
      `Build it (e.g. "npm run build") so a .js exists, then retry.`,
    );
  } else {
    lines.push(
      `Add a witnesses module exporting a "witnesses" object that maps each`,
      `declared name to its implementation. Example: src/witnesses.ts → tsc → dist/witnesses.js.`,
    );
  }
  return lines.join('\n');
}
