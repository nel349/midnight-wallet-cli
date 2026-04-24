// JSON output utilities for --json mode
// Structured JSON result/error output to stdout. Stderr stays untouched:
// spinners and chrome continue to flow to stderr under --json, which matches
// the UNIX convention (stdout = data, stderr = chrome/progress) and lets
// pipes like `cmd --json | jq` work without extra wiring.
//
// An earlier version monkey-patched process.stderr.write to hide chrome in
// --json mode. That violated Node's stream.write() callback contract in
// subtle ways (libraries awaiting writes could hang) and provided no real
// benefit — stderr output doesn't pollute the stdout JSON that consumers
// actually read. Simpler to not suppress stderr at all.

import { type ErrorCode } from './exit-codes.ts';

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
  const json = JSON.stringify({
    error: true,
    code: errorCode,
    message: err.message,
    exitCode,
  }) + '\n';
  if (captureTarget) {
    captureTarget(json);
  } else {
    process.stdout.write(json);
  }
}
