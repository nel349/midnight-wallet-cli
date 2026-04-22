// Compile runner for `mn dev`.
// Prefers the project's own `npm run compile` script when defined,
// else falls back to `compact compile` on each source file.

import { spawn } from 'node:child_process';
import type { ProjectInfo } from './detect-project.ts';

export interface CompileResult {
  success: boolean;
  durationMs: number;
  /** Which entrypoint ran — either "npm run compile" or "compact compile". */
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CompileOptions {
  project: ProjectInfo;
  signal?: AbortSignal;
  /** Override the resolved command (useful for tests). */
  commandOverride?: { bin: string; args: string[] };
}

/**
 * Run the project's Compact compiler once and collect the result.
 * Does not throw on compile failure — surfaces exitCode + stderr instead.
 */
export async function runCompile(opts: CompileOptions): Promise<CompileResult> {
  const { bin, args, label } = resolveCommand(opts);
  const started = Date.now();

  return new Promise<CompileResult>((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, {
      cwd: opts.project.projectRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    const onAbort = () => { child.kill('SIGTERM'); };
    if (opts.signal) {
      // If the signal is already aborted, kill the child immediately; the
      // 'close' handler below will still fire and resolve the promise.
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
        stdout,
        stderr,
        exitCode: code ?? -1,
      });
    });
  });
}

function resolveCommand(opts: CompileOptions): { bin: string; args: string[]; label: string } {
  if (opts.commandOverride) {
    const { bin, args } = opts.commandOverride;
    return { bin, args, label: [bin, ...args].join(' ') };
  }
  if (opts.project.hasNpmCompileScript) {
    return { bin: 'npm', args: ['run', 'compile', '--silent'], label: 'npm run compile' };
  }
  // The `compact` CLI is a version manager, not a compiler front-end —
  // the actual compiler (`compactc.bin`) needs source + target args that
  // vary per project. Require the project to define its own compile script.
  throw new Error(
    'No compile entrypoint found.\n' +
    'Add a "compile" script to package.json that invokes the Compact compiler\n' +
    '(e.g. `"compile": "compactc src/my.compact src/managed/my"`).\n' +
    'create-mn-app templates ship with this script already wired.',
  );
}
