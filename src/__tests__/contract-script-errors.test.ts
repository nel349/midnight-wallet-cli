// How a generated contract script reports failure: its prelude turns any
// error (a rejected top-level await included) into one marked stderr line, and
// mn reports that line, not the progress, warnings and source dump around it.
// The prelude runs for real in a child Node process.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCRIPT_PRELUDE, scriptFailureMessage } from '../lib/contract/runner.ts';

function runScript(body: string): { stderr: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'mn-script-'));
  try {
    const file = join(dir, 'script.mjs');
    writeFileSync(file, SCRIPT_PRELUDE + body);
    const r = spawnSync('node', [file], { encoding: 'utf-8' });
    return { stderr: r.stderr, status: r.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('generated script failures', () => {
  it('reports a rejected top-level await as the error alone, without the warning before it', () => {
    const { stderr, status } = runScript(`
process.stderr.write('Warning: No witnesses module found — using vacant witnesses. Searched:\\n  - dist/witnesses.js\\n');
process.stderr.write('Deploying contract...\\n');
await Promise.reject(new TypeError('Expected an input string with byte length of 32, got 4.'));
`);
    expect(status).toBe(1);
    expect(scriptFailureMessage(stderr, status)).toBe('Expected an input string with byte length of 32, got 4.');
  });

  it('reports a thrown error the same way', () => {
    const { stderr, status } = runScript(`throw new Error('No contract found at address ab');`);
    expect(scriptFailureMessage(stderr, status)).toBe('No contract found at address ab');
  });

  it('reads a long error intact (the runner keeps stderr whole, however the pipe split it)', () => {
    const long = 'x'.repeat(5_000);
    const { stderr, status } = runScript(`throw new Error('${long}');`);
    expect(scriptFailureMessage(stderr, status)).toBe(long);
  });

  it('falls back to the whole stderr, then the exit code, when the script reported nothing', () => {
    expect(scriptFailureMessage('Segmentation fault\n', 139)).toBe('Segmentation fault');
    expect(scriptFailureMessage('', 2)).toBe('Script exited with code 2');
  });

});
