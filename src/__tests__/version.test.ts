import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const entryPoint = resolve(import.meta.dirname, '../wallet.ts');

function run(args: string[]): string {
  return execFileSync('npx', ['tsx', entryPoint, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '' },
  }).trim();
}

// Each test spawns `npx tsx` against the CLI entry point. Cold spawn +
// ts module load on a loaded machine routinely exceeds vitest's 5s default
// (the wall-clock work is real and bounded). Bumping the per-test timeout
// to 15s removes the flake without masking actual regressions.
const SPAWN_TIMEOUT_MS = 15_000;

describe('--version flag', () => {
  it('prints version with --version', () => {
    const output = run(['--version']);
    expect(output).toMatch(/^\d+\.\d+\.\d+$/);
  }, SPAWN_TIMEOUT_MS);

  it('prints version with -v', () => {
    const output = run(['-v']);
    expect(output).toMatch(/^\d+\.\d+\.\d+$/);
  }, SPAWN_TIMEOUT_MS);

  it('prints the version from package.json', () => {
    const { version } = require('../../package.json');
    const output = run(['-v']);
    expect(output).toBe(version);
  }, SPAWN_TIMEOUT_MS);
});
