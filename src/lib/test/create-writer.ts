// Test scaffold writer — takes a ScaffoldOutput from create.ts and writes
// the four config files into the dApp directory tree. The split keeps
// codegen testable in isolation (pure functions in create.ts) and confines
// all FS interaction to this module.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
}

/**
 * Persist the scaffold to disk. Layout:
 *   <dappDir>/dapp.test.json
 *   <dappDir>/tests/suites/<suiteName>/suite.json
 *   <dappDir>/tests/suites/<suiteName>/actions.json
 *   <dappDir>/tests/suites/<suiteName>/assertions.json
 *
 * Without --force, any pre-existing target file aborts the write and no
 * files are created (collision is detected up front so we never end up
 * with a partial scaffold).
 */
export function writeScaffold(scaffold: ScaffoldOutput, options: WriteOptions): WriteResult {
  const { dappDir, force = false } = options;
  const suiteDir = join(dappDir, 'tests', 'suites', scaffold.suiteName);

  const targets: { path: string; body: unknown }[] = [
    { path: join(dappDir, 'dapp.test.json'), body: scaffold.dappConfig },
    { path: join(suiteDir, 'suite.json'), body: scaffold.suite },
    { path: join(suiteDir, 'actions.json'), body: scaffold.actions },
    { path: join(suiteDir, 'assertions.json'), body: scaffold.assertions },
  ];

  if (!force) {
    const existing = targets.filter((t) => existsSync(t.path)).map((t) => t.path);
    if (existing.length > 0) {
      throw new Error(
        `Refusing to overwrite existing files (use --force to overwrite):\n` +
        existing.map((p) => `  - ${p}`).join('\n')
      );
    }
  }

  mkdirSync(suiteDir, { recursive: true });
  const written: string[] = [];
  for (const { path, body } of targets) {
    writeFileSync(path, JSON.stringify(body, null, 2) + '\n');
    written.push(path);
  }

  return { written };
}
