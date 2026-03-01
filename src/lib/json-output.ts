// JSON output utilities for --json mode
// Handles stderr suppression, structured JSON output, and JSON error formatting

import { type ErrorCode } from './exit-codes.ts';

/**
 * Replace process.stderr.write with a no-op to suppress all stderr output
 * (spinners, headers, animations, formatted details).
 * Returns a function that restores the original stderr.write.
 */
export function suppressStderr(): () => void {
  const original = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  return () => { process.stderr.write = original; };
}

// ── Capture target ───────────────────────────────────────
// When set, writeJsonResult sends output to this callback instead of stdout.
// Used by captureCommand (MCP server) to avoid hijacking process.stdout.write,
// which would conflict with StdioServerTransport.
let captureTarget: ((json: string) => void) | null = null;

/**
 * Redirect writeJsonResult output to a callback instead of stdout.
 * Pass null to restore normal stdout behavior.
 */
export function setCaptureTarget(fn: ((json: string) => void) | null): void {
  captureTarget = fn;
}

/**
 * Write a structured JSON result to stdout.
 * Always outputs a single line of JSON followed by a newline.
 * If a capture target is set, output goes there instead.
 */
export function writeJsonResult(data: Record<string, unknown>): void {
  const json = JSON.stringify(data) + '\n';
  if (captureTarget) {
    captureTarget(json);
  } else {
    process.stdout.write(json);
  }
}

/**
 * Write a structured JSON error to stdout.
 * Format: { "error": true, "code": "ERROR_CODE", "message": "..." }
 */
export function writeJsonError(err: Error, errorCode: ErrorCode, exitCode: number): void {
  process.stdout.write(JSON.stringify({
    error: true,
    code: errorCode,
    message: err.message,
    exitCode,
  }) + '\n');
}
