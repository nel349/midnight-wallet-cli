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

/**
 * Write a structured JSON result to stdout.
 * Always outputs a single line of JSON followed by a newline.
 */
export function writeJsonResult(data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(data) + '\n');
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
