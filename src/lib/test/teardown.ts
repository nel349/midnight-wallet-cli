// Teardown — coordinated cleanup of all test resources in reverse order.

import { execSync } from 'node:child_process';
import type { PrepContext } from './types.ts';

/**
 * Run all registered cleanup functions in reverse order (LIFO).
 * Each cleanup is best-effort — errors are logged but don't prevent subsequent cleanups.
 */
export async function runTeardown(ctx: PrepContext, log?: (msg: string) => void): Promise<void> {
  // Stop build process first (fastest, prevents new connections)
  if (ctx.buildHandle) {
    try {
      ctx.buildHandle.stop();
      log?.('Stopped build process');
    } catch {
      log?.('Failed to stop build process (may have already exited)');
    }
  }

  // Stop serve (closes RPC server, disposes connector, stops facade)
  if (ctx.serveHandle) {
    try {
      await ctx.serveHandle.stop();
      log?.('Stopped mn serve');
    } catch {
      log?.('Failed to stop mn serve');
    }
  }

  // Run registered cleanups in reverse order
  for (const cleanup of ctx.cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      // best-effort
    }
  }

  // Close Chrome tabs on the test port (macOS, best-effort)
  if (ctx.buildHandle?.port) {
    closeChromeTabsForPort(ctx.buildHandle.port, log);
  }
}

/**
 * Close Chrome tabs matching localhost:<port> using AppleScript (macOS only).
 */
function closeChromeTabsForPort(port: number, log?: (msg: string) => void): void {
  try {
    execSync(`osascript -e 'tell application "Google Chrome"
      repeat with theWindow in every window
        repeat with theTab in every tab of theWindow
          if URL of theTab contains "localhost:${port}" then
            close theTab
          end if
        end repeat
      end repeat
    end tell'`, { timeout: 5_000, stdio: 'pipe' });
    log?.(`Closed Chrome tabs for localhost:${port}`);
  } catch {
    // Chrome may not be running or no matching tabs — that's fine
  }
}
