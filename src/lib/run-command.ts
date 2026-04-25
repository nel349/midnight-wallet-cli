// Run a command handler and capture its JSON output
// Used by the MCP server to invoke CLI commands programmatically

import { type ParsedArgs, MINIMAL_FLAG } from './argv.ts';
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
 * Stderr is left untouched — chrome/spinners flow to the MCP server's
 * stderr, which clients typically log separately. See lib/json-output.ts
 * header for why monkey-patching process.stderr.write was removed.
 *
 * Also opts every MCP-invoked command into agent-slim mode by injecting
 * `_minimal: true` into args.flags. Handlers that opt in (currently:
 * wallet list) emit a smaller JSON shape for agents while keeping
 * `mn <cmd> --json` (human path) byte-for-byte identical, since humans
 * never go through captureCommand. Tool handlers expose a `full: true`
 * escape hatch by setting `_full: true` in args.flags — handlers treat
 * that as "agent explicitly wants the full shape" and emit the human
 * shape instead.
 *
 * Returns the parsed JSON object. Throws the original error if the
 * handler throws.
 */
export async function captureCommand(
  handler: CommandHandler,
  args: ParsedArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  setCaptureTarget((json) => chunks.push(json));

  try {
    args.flags.json = true;
    if (!(MINIMAL_FLAG in args.flags)) {
      args.flags[MINIMAL_FLAG] = true;
    }
    await handler(args, signal);

    const raw = chunks.join('').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } finally {
    setCaptureTarget(null);
  }
}
