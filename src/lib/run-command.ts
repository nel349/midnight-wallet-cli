// Run a command handler and capture its JSON output
// Used by the MCP server to invoke CLI commands programmatically

import { type ParsedArgs } from './argv.ts';
import { setCaptureTarget } from './json-output.ts';

type CommandHandler = (args: ParsedArgs, signal?: AbortSignal) => Promise<void>;

/**
 * Execute a command handler with --json mode, capturing the JSON result.
 *
 * Uses the json-output capture target mechanism so that writeJsonResult()
 * sends output to an in-memory buffer instead of process.stdout.
 * This avoids hijacking process.stdout.write, which would conflict with
 * the MCP StdioServerTransport that also writes to stdout.
 *
 * Suppresses all stderr (spinners, formatting).
 * Returns the parsed JSON object.
 * Throws the original error if the handler throws.
 */
export async function captureCommand(
  handler: CommandHandler,
  args: ParsedArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const chunks: string[] = [];

  // Redirect writeJsonResult output to our buffer
  setCaptureTarget((json) => chunks.push(json));

  // Suppress stderr (spinners, headers, etc.)
  const originalStderr = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;

  try {
    // Inject --json flag
    args.flags.json = true;
    await handler(args, signal);

    const raw = chunks.join('').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } finally {
    setCaptureTarget(null);
    process.stderr.write = originalStderr;
  }
}
