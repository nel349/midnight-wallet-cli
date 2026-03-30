// Browser test — launch Claude with --chrome in the foreground terminal.
// Must run in foreground (not tmux) because Chrome requires display access.

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { TestSuite } from './types.ts';

export interface BrowserTestOptions {
  suite: TestSuite;
  prompt: string;
  dappDir: string;
  logFile: string;
  onMessage?: (msg: string) => void;
}

export interface BrowserTestResult {
  exitCode: number;
  logFile: string;
  timedOut: boolean;
}

/**
 * Launch Claude with --chrome in the foreground to run a browser-based test.
 * Claude gets direct terminal access (stdin/stdout/stderr inherited) so it can
 * interact with Chrome. Output is also teed to a log file for results capture.
 */
export async function runBrowserTest(options: BrowserTestOptions): Promise<BrowserTestResult> {
  const {
    suite,
    prompt,
    dappDir,
    logFile,
    onMessage = () => {},
  } = options;

  const timeout = (suite.timeout ?? 600) * 1_000;

  // Ensure log directory exists
  mkdirSync(dirname(logFile), { recursive: true });
  const logStream = createWriteStream(logFile);

  const args = [
    '--chrome',
    '--dangerously-skip-permissions',
  ];

  if (suite.model) {
    args.push('--model', suite.model);
  }
  if (suite.effort) {
    args.push('--effort', suite.effort);
  }

  args.push('-p', prompt);

  onMessage(`Launching Claude (model: ${suite.model ?? 'default'}, timeout: ${suite.timeout ?? 600}s)`);

  return new Promise<BrowserTestResult>((resolve) => {
    const child = spawn('claude', args, {
      cwd: dappDir,
      // stdin + stderr inherit for Chrome access and status output
      // stdout piped so we can tee to log file while also showing in terminal
      stdio: ['inherit', 'pipe', 'inherit'],
    });

    let timedOut = false;

    // Tee stdout to both terminal and log file
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    });

    // Timeout handler
    const timer = setTimeout(() => {
      timedOut = true;
      onMessage(`Timeout: test exceeded ${suite.timeout ?? 600}s`);
      child.kill('SIGTERM');
      // Force kill after 10 seconds
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 10_000).unref();
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      logStream.end();
      resolve({
        exitCode: code ?? 1,
        logFile,
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      logStream.end();
      onMessage(`Claude process error: ${err.message}`);
      resolve({
        exitCode: 1,
        logFile,
        timedOut: false,
      });
    });
  });
}
