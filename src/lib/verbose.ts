// Verbose logger — writes timestamped diagnostic lines to stderr.
// Enabled per-command via --verbose / -v flag.
// All output goes to stderr so stdout stays pipeable.
//
// `notice` is for the rare line a user should see without asking for it.

import { dim } from '../ui/colors.ts';
import { getActiveSpinner } from '../ui/spinner.ts';

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

const noticesGiven = new Set<string>();

/**
 * Tell the user something once per process, whatever the verbosity: a line on
 * stderr, above the spinner when one is running.
 */
export function notice(message: string): void {
  if (noticesGiven.has(message)) return;
  noticesGiven.add(message);
  const line = `  ${message}`;
  const spinner = getActiveSpinner();
  if (spinner) spinner.log(line);
  else process.stderr.write(line + '\n');
}
