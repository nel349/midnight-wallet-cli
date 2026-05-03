// Test scaffold writer — takes a ScaffoldOutput from create.ts and writes
// the four config files into the dApp directory tree. The split keeps
// codegen testable in isolation (pure functions in create.ts) and confines
// all FS interaction to this module.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ScaffoldOutput } from './create.ts';

export interface WriteOptions {
  /** Project root where dapp.test.json lives. */
  dappDir: string;
  /** When true, overwrites existing files; otherwise throws on collision. */
  force?: boolean;
}

export interface WriteResult {
  /** Absolute paths of every file written, in order. */
  written: string[];
  /** dapp.test.json paths we left as-is because the existing file was compatible. */
  preserved: string[];
}

/**
 * Persist the scaffold to disk. Layout depends on strategy:
 *
 *   <dappDir>/dapp.test.json                              (project-level — additive)
 *   <dappDir>/tests/suites/<suiteName>/suite.json
 *   <dappDir>/tests/suites/<suiteName>/actions.json       (cli only)
 *   <dappDir>/tests/suites/<suiteName>/prompt.md          (browser only)
 *   <dappDir>/tests/suites/<suiteName>/assertions.json
 *
 * Collision behaviour:
 * - dapp.test.json (project-level): if it already exists with the same
 *   contract name AND the proposed prep is a subset of what's there, we
 *   leave it alone — the user is adding a new suite to an existing
 *   project, not bootstrapping. Conflict (different name) still fails so
 *   we don't silently scribble over their config.
 * - Suite files: any pre-existing target aborts. The right answer for a
 *   suite-name collision is `--suite <new-name>`, not --force, so the
 *   error message points at that.
 *
 * --force overrides both behaviours: every target is overwritten.
 */
export function writeScaffold(scaffold: ScaffoldOutput, options: WriteOptions): WriteResult {
  const { dappDir, force = false } = options;
  const suiteDir = join(dappDir, 'tests', 'suites', scaffold.suiteName);
  const dappConfigPath = join(dappDir, 'dapp.test.json');

  type Target =
    | { path: string; kind: 'json'; body: unknown }
    | { path: string; kind: 'text'; body: string };

  // Suite-level targets — these collide on a per-suite-name basis. Adding a
  // new suite to a project produces a fresh suite dir, so collision here
  // means the user has already created this suite.
  const suiteTargets: Target[] = [
    { path: join(suiteDir, 'suite.json'), kind: 'json', body: scaffold.suite },
    { path: join(suiteDir, 'assertions.json'), kind: 'json', body: scaffold.assertions },
  ];
  if (scaffold.actions) {
    suiteTargets.push({ path: join(suiteDir, 'actions.json'), kind: 'json', body: scaffold.actions });
  }
  if (scaffold.prompt) {
    suiteTargets.push({ path: join(suiteDir, 'prompt.md'), kind: 'text', body: scaffold.prompt });
  }

  if (!force) {
    const existingSuiteFiles = suiteTargets.filter((t) => existsSync(t.path)).map((t) => t.path);
    if (existingSuiteFiles.length > 0) {
      throw new Error(
        `Suite "${scaffold.suiteName}" already exists at ${suiteDir}.\n` +
        `Pick a different suite name (--suite <name>) or pass --force to overwrite.\n` +
        `Existing files:\n` +
        existingSuiteFiles.map((p) => `  - ${p}`).join('\n'),
      );
    }
  }

  // dapp.test.json is project-level. If it exists, decide additively:
  // compatible (same contract name) → leave it alone; conflicting → throw.
  const dappPolicy = decideDappConfigPolicy(dappConfigPath, scaffold, force);

  mkdirSync(suiteDir, { recursive: true });
  const written: string[] = [];
  const preserved: string[] = [];

  if (dappPolicy.action === 'write') {
    writeFileSync(dappConfigPath, JSON.stringify(scaffold.dappConfig, null, 2) + '\n');
    written.push(dappConfigPath);
  } else {
    preserved.push(dappConfigPath);
  }

  for (const target of suiteTargets) {
    const body = target.kind === 'json'
      ? JSON.stringify(target.body, null, 2) + '\n'
      : target.body;
    writeFileSync(target.path, body);
    written.push(target.path);
  }

  return { written, preserved };
}

/**
 * Decide what to do with an existing dapp.test.json. Three outcomes:
 * - 'write' — file doesn't exist OR --force is set; we write our version.
 * - 'preserve' — exists with a compatible name; we leave it alone (the
 *   user is adding a new suite, not re-bootstrapping the project).
 * - throws — exists but for a different contract; refuses to clobber.
 */
function decideDappConfigPolicy(
  path: string,
  scaffold: ScaffoldOutput,
  force: boolean,
): { action: 'write' | 'preserve' } {
  if (force || !existsSync(path)) return { action: 'write' };

  let existing: { name?: unknown };
  try {
    existing = JSON.parse(readFileSync(path, 'utf-8')) as { name?: unknown };
  } catch (err) {
    // Corrupt JSON — treat as conflicting; user should clean up by hand.
    // Include the parse error so the user sees what's broken (e.g. line/col),
    // not just "not valid JSON".
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${path} exists but is not valid JSON: ${cause}\nFix or remove it (or pass --force to overwrite).`,
    );
  }

  if (existing.name !== scaffold.dappConfig.name) {
    throw new Error(
      `${path} exists with name "${String(existing.name)}" but this scaffold targets "${scaffold.dappConfig.name}". ` +
      `Use --force to overwrite, or run from the right project directory.`,
    );
  }

  return { action: 'preserve' };
}
