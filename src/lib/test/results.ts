// Results — write and read structured JSON test results.
// Results are stored in <dapp>/tests/results/<suite>_<timestamp>.json

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TestRunResult } from './types.ts';

const RESULTS_DIR = 'tests/results';

/**
 * Write a test result to the dApp's results directory.
 * Returns the path to the written file.
 */
export function writeResult(result: TestRunResult, dappDir: string): string {
  const dir = join(dappDir, RESULTS_DIR);
  mkdirSync(dir, { recursive: true });

  const filename = `${result.suite}_${result.timestamp.replace(/[:.]/g, '-')}.json`;
  const filepath = join(dir, filename);

  writeFileSync(filepath, JSON.stringify(result, null, 2) + '\n');
  return filepath;
}

/**
 * Read the latest test result for a given suite (or any suite if not specified).
 */
export function readLatestResult(dappDir: string, suite?: string): TestRunResult | null {
  const results = listResults(dappDir, suite);
  return results.length > 0 ? results[0] : null;
}

/**
 * List all test results, sorted by timestamp descending (newest first).
 * Optionally filter by suite name.
 */
export function listResults(dappDir: string, suite?: string): TestRunResult[] {
  const dir = join(dappDir, RESULTS_DIR);

  if (!existsSync(dir)) {
    return [];
  }

  // The directory also holds files that are not results (the runner's
  // `.contract-cache-<suite>.json`, build and agent logs): hidden files are
  // left out, and so is any JSON that isn't shaped like a result.
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .filter(f => !suite || f.startsWith(suite + '_'));

  const results: TestRunResult[] = [];

  for (const file of files) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      if (isTestRunResult(parsed)) results.push(parsed);
    } catch {
      // Skip corrupt files
    }
  }

  // Sort by timestamp descending
  results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return results;
}

function isTestRunResult(value: unknown): value is TestRunResult {
  const result = value as Partial<TestRunResult> | null;
  return typeof result === 'object' && result !== null
    && typeof result.suite === 'string'
    && typeof result.timestamp === 'string'
    && (result.status === 'pass' || result.status === 'fail')
    && Array.isArray(result.prep)
    && Array.isArray(result.assertions);
}
