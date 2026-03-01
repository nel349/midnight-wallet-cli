// midnight-wallet-cli entry point
// Usage: midnight <command> [args]  (or: mn <command> [args])
// Dispatches to command handlers via dynamic import
// Also supports: midnight --mcp (starts MCP server for AI agent integration)

import { parseArgs, hasFlag } from './lib/argv.ts';
import { errorBox } from './ui/format.ts';
import { classifyError } from './lib/exit-codes.ts';
import { suppressStderr, writeJsonError } from './lib/json-output.ts';
import { PKG_VERSION } from './lib/pkg.ts';

// --mcp: start MCP server instead of CLI (for: npx midnight-wallet-cli --mcp)
if (process.argv.includes('--mcp')) {
  await import('./mcp-server.ts');
} else {

const args = parseArgs();
const jsonMode = hasFlag(args, 'json');

// Global --version / -v handling
if (hasFlag(args, 'version') || hasFlag(args, 'v')) {
  process.stdout.write(PKG_VERSION + '\n');
  process.exit(0);
}

// Global --help / -h handling
if (hasFlag(args, 'help') || hasFlag(args, 'h')) {
  args.command = 'help';
}

// Default to help when no command given
const command = args.command ?? 'help';

// Suppress stderr in JSON mode (spinners, headers, animations)
let restoreStderr: (() => void) | undefined;
if (jsonMode) {
  restoreStderr = suppressStderr();
}

// Global AbortController for clean shutdown on SIGINT/SIGTERM
const abortController = new AbortController();
const { signal } = abortController;

function handleShutdown() {
  abortController.abort();
  // Give active operations a moment to clean up, then force exit
  setTimeout(() => process.exit(130), 5_000).unref();
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

async function run(): Promise<void> {
  switch (command) {
    case 'help': {
      const { default: handler } = await import('./commands/help.ts');
      return handler(args);
    }
    case 'generate': {
      const { default: handler } = await import('./commands/generate.ts');
      return handler(args);
    }
    case 'info': {
      const { default: handler } = await import('./commands/info.ts');
      return handler(args);
    }
    case 'balance': {
      const { default: handler } = await import('./commands/balance.ts');
      return handler(args);
    }
    case 'address': {
      const { default: handler } = await import('./commands/address.ts');
      return handler(args);
    }
    case 'genesis-address': {
      const { default: handler } = await import('./commands/genesis-address.ts');
      return handler(args);
    }
    case 'inspect-cost': {
      const { default: handler } = await import('./commands/inspect-cost.ts');
      return handler(args);
    }
    case 'config': {
      const { default: handler } = await import('./commands/config.ts');
      return handler(args);
    }
    case 'airdrop': {
      const { default: handler } = await import('./commands/airdrop.ts');
      return handler(args, signal);
    }
    case 'transfer': {
      const { default: handler } = await import('./commands/transfer.ts');
      return handler(args, signal);
    }
    case 'dust': {
      const { default: handler } = await import('./commands/dust.ts');
      return handler(args, signal);
    }
    case 'localnet': {
      const { default: handler } = await import('./commands/localnet.ts');
      return handler(args);
    }
    default:
      throw new Error(
        `Unknown command: "${command}"\n` +
        `Run "midnight help" to see available commands.`
      );
  }
}

// Commands that start a WalletFacade leave WebSocket connections in the event loop.
// facade.stop() doesn't fully drain them, so we must exit explicitly.
const FACADE_COMMANDS = new Set(['airdrop', 'transfer', 'dust']);

run().then(() => {
  if (FACADE_COMMANDS.has(command)) {
    process.exit(0);
  }
}).catch((err: Error) => {
  if (jsonMode) {
    // Restore stderr so writeJsonError can work if needed
    restoreStderr?.();
    const { exitCode, errorCode } = classifyError(err);
    writeJsonError(err, errorCode, exitCode);
    process.exit(exitCode);
  } else {
    process.stderr.write('\n' + errorBox(err.message, 'Run "midnight help" for usage information.') + '\n\n');
    const { exitCode } = classifyError(err);
    process.exit(exitCode);
  }
});

}
