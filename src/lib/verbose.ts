// Verbose logger — writes timestamped diagnostic lines to stderr.
// Enabled per-command via --verbose / -v flag.
// All output goes to stderr so stdout stays pipeable.

import { dim } from '../ui/colors.ts';

let enabled = false;

export function enableVerbose(): void {
  enabled = true;
}

/**
 * Log a verbose diagnostic message to stderr.
 * No-op when verbose mode is disabled.
 */
export function verbose(phase: string, message: string): void {
  if (!enabled) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  process.stderr.write(dim(`  [${ts}] ${phase}: ${message}`) + '\n');
}
