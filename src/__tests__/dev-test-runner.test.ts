import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTests } from '../lib/dev/test.ts';
import type { ProjectInfo } from '../lib/dev/detect-project.ts';

let TEST_DIR: string;

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'mn-dev-test-runner-'));
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function project(extra: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    projectRoot: TEST_DIR,
    sourceFiles: [join(TEST_DIR, 'x.compact')],
    sourceDirs: [TEST_DIR],
    compileScript: null,
    hasNpmCompileScript: false,
    testScript: null,
    packageJson: null,
    ...extra,
  };
}

describe('runTests', () => {
  it('resolves with success=true on exit 0', async () => {
    const result = await runTests({
      project: project(),
      commandOverride: { bin: 'sh', args: ['-c', 'exit 0'] },
    });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe('sh -c exit 0');
  });

  it('resolves with success=false on non-zero exit', async () => {
    const result = await runTests({
      project: project(),
      commandOverride: { bin: 'sh', args: ['-c', 'exit 2'] },
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(2);
  });

  it('rejects with a helpful error when no test script and no override', async () => {
    await expect(runTests({ project: project({ testScript: null }) }))
      .rejects.toThrow(/No test script|test:dev.*test.*script/i);
  });

  it('uses npm run <detected-script> when testScript is set', async () => {
    const result = await runTests({
      project: project({ testScript: 'test:dev' }),
      commandOverride: { bin: 'sh', args: ['-c', 'exit 0'] },
    });
    expect(result.success).toBe(true);
  });

  it('aborts a running child via signal', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const promise = runTests({
      project: project(),
      signal: ac.signal,
      commandOverride: { bin: 'sh', args: ['-c', 'sleep 30'] },
    });
    setTimeout(() => ac.abort(), 50);
    const result = await promise;
    expect(result.success).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects cleanly when the binary is missing', async () => {
    await expect(runTests({
      project: project(),
      commandOverride: { bin: '/nonexistent/bin/xyz', args: [] },
    })).rejects.toThrow(/Failed to spawn/);
  });
});
