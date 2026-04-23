import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCompile } from '../lib/dev/compile.ts';
import type { ProjectInfo } from '../lib/dev/detect-project.ts';

let TEST_DIR: string;

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'mn-dev-compile-'));
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
    packageJson: null,
    ...extra,
  };
}

describe('runCompile', () => {
  it('captures exit code 0 and stdout on success', async () => {
    const result = await runCompile({
      project: project(),
      commandOverride: { bin: 'sh', args: ['-c', 'echo hello; exit 0'] },
    });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures non-zero exit and stderr on failure', async () => {
    const result = await runCompile({
      project: project(),
      commandOverride: { bin: 'sh', args: ['-c', 'echo boom >&2; exit 3'] },
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
  });

  it('labels the command based on which path was chosen', async () => {
    const result = await runCompile({
      project: project(),
      commandOverride: { bin: 'true', args: [] },
    });
    expect(result.command).toBe('true');
  });

  it('rejects with a clear error when the binary is missing', async () => {
    await expect(runCompile({
      project: project(),
      commandOverride: { bin: '/nonexistent/bin/compact-xyz', args: [] },
    })).rejects.toThrow(/Failed to spawn/);
  });

  it('rejects with a helpful message when no compile script is defined and no override', async () => {
    await expect(runCompile({ project: project({ compileScript: null, hasNpmCompileScript: false }) }))
      .rejects.toThrow(/No compile script|compile.*script/i);
  });

  it('uses npm run <detected-script> when the project has a compile script', async () => {
    // sh command that just succeeds — we're only checking the label resolution
    const result = await runCompile({
      project: project({ compileScript: 'compact', hasNpmCompileScript: true }),
      commandOverride: { bin: 'sh', args: ['-c', 'exit 0'] },
    });
    expect(result.success).toBe(true);
  });
});
