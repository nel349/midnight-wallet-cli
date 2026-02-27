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

describe('--version flag', () => {
  it('prints version with --version', () => {
    const output = run(['--version']);
    expect(output).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints version with -v', () => {
    const output = run(['-v']);
    expect(output).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints the version from package.json', () => {
    const { version } = require('../../package.json');
    const output = run(['-v']);
    expect(output).toBe(version);
  });
});
