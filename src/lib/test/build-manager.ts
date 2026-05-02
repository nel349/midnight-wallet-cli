// Build manager — spawn dApp UI build process and wait for the port to be ready.

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import net from 'node:net';
import type { BuildHandle } from './types.ts';

export interface BuildOptions {
  dappDir: string;
  buildCmd: string;
  buildDir?: string;
  port: number;
  url: string;
  logFile: string;
  timeoutMs?: number;
  onMessage?: (msg: string) => void;
}

/**
 * Start the dApp build/serve process and wait for the URL to respond with 200.
 * Returns a handle with stop() for teardown.
 */
export async function startBuild(options: BuildOptions): Promise<BuildHandle> {
  const {
    dappDir,
    buildCmd,
    buildDir = '.',
    port,
    url,
    logFile,
    timeoutMs = 240_000,
    onMessage = () => {},
  } = options;

  // Three cases when the port is taken:
  //   1. It's already serving our URL with 200 → reuse, no rebuild.
  //   2. It's bound but the URL doesn't 200 → unknown process; kill it, then
  //      spawn fresh. (Most likely a stale `npm run dev` from a prior session.)
  //   3. Port is free → spawn fresh.
  // Reuse saves 30–90s of vite startup on repeated test runs.
  if (await isPortInUse(port)) {
    if (await checkUrl(url)) {
      onMessage(`Reusing existing dev server on port ${port} (URL responds 200)`);
      return {
        port,
        // Caller-typed BuildHandle requires `child` and `stop`. We didn't
        // spawn anything, so the child reference is a no-op shim and stop
        // does nothing — we don't tear down processes we didn't start.
        child: { kill: () => true } as unknown as ChildProcess,
        stop() { /* not ours to stop */ },
      };
    }
    onMessage(`Port ${port} in use by an unresponsive process — killing it`);
    await killProcessOnPort(port);
    // Brief pause for port release.
    await new Promise(r => setTimeout(r, 2_000));
  }

  // Spawn the build command
  const cwd = join(dappDir, buildDir);
  const logStream = createWriteStream(logFile, { flags: 'a' });

  const child = spawn('bash', ['-lc', buildCmd], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Pipe output to log file
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  // Track if child exits unexpectedly
  let childExited = false;
  let exitCode: number | null = null;
  child.on('exit', (code) => {
    childExited = true;
    exitCode = code;
  });

  onMessage(`Building (${buildCmd})...`);

  // Wait for the URL to respond with 200
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (childExited) {
      throw new Error(
        `Build process exited with code ${exitCode} before the UI was ready.\n` +
        `Check the build log: ${logFile}`
      );
    }

    if (await checkUrl(url)) {
      onMessage('UI ready');
      return {
        port,
        child,
        stop() {
          if (!childExited) {
            child.kill('SIGTERM');
            // Force kill after 5 seconds
            setTimeout(() => {
              if (!childExited) child.kill('SIGKILL');
            }, 5_000).unref();
          }
          logStream.end();
        },
      };
    }

    await new Promise(r => setTimeout(r, 2_000));
  }

  // Timeout — kill the build process
  child.kill('SIGTERM');
  logStream.end();

  throw new Error(
    `UI did not start within ${Math.round(timeoutMs / 1000)}s at ${url}\n` +
    `Check the build log: ${logFile}`
  );
}

// ── Helpers ──

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1_000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

async function killProcessOnPort(port: number): Promise<void> {
  const { execSync } = await import('node:child_process');
  try {
    const pids = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' }).trim();
    if (pids) {
      execSync(`kill ${pids}`, { stdio: 'pipe' });
    }
  } catch {
    // No process on port or kill failed — that's fine
  }
}

function checkUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3_000 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume(); // drain the response
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}
