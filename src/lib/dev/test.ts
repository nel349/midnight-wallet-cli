// Test runner for `mn dev`'s `t` keystroke.
// Inherits the child's stdout and stderr so test output (Vitest/Jest/whatever)
// streams to the user in real time without buffering.

import { spawn } from 'node:child_process';
import type { ProjectInfo } from './detect-project.ts';

export interface TestResult {
  success: boolean;
  durationMs: number;
  /** Which script ran — e.g. "npm run test:dev" or "npm run test". */
  command: string;
  exitCode: number;
}

export interface TestRunnerOptions {
  project: ProjectInfo;
  signal?: AbortSignal;
  /** Override the resolved command (useful for tests). */
  commandOverride?: { bin: string; args: string[] };
}

/**
 * Run the project's npm test script, inheriting the child's stdout/stderr so
 * the user sees live test output. Does not buffer — long test suites show
 * progress as each test completes. Aborting the signal sends SIGTERM.
 */
export async function runTests(opts: TestRunnerOptions): Promise<TestResult> {
  const { bin, args, label } = resolveCommand(opts);
  const started = Date.now();

  return new Promise<TestResult>((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, {
      cwd: opts.project.projectRoot,
      env: process.env,
      // Inherit stderr/stdout so test output streams directly. Ignore stdin
      // so the child can't steal the parent's raw-mode keystroke buffer.
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    const onAbort = () => { child.kill('SIGTERM'); };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      rejectPromise(new Error(`Failed to spawn "${label}": ${err.message}`));
    });

    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        success: code === 0,
        durationMs: Date.now() - started,
        command: label,
        exitCode: code ?? -1,
      });
    });
  });
}

function resolveCommand(opts: TestRunnerOptions): { bin: string; args: string[]; label: string } {
  if (opts.commandOverride) {
    const { bin, args } = opts.commandOverride;
    return { bin, args, label: [bin, ...args].join(' ') };
  }
  if (!opts.project.testScript) {
    throw new Error(
      'No test script found in package.json.\n' +
      'Add a "test:dev" or "test" script that runs your contract tests\n' +
      '(e.g. "test": "vitest run"), then press t again.',
    );
  }
  const script = opts.project.testScript;
  return { bin: 'npm', args: ['run', script, '--silent'], label: `npm run ${script}` };
}
