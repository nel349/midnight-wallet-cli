// midnight-wallet-cli entry point
// Usage: midnight <command> [args]  (or: mn <command> [args])
// Dispatches to command handlers via dynamic import
// Also supports: midnight --mcp (starts MCP server for AI agent integration)

import { parseArgs, hasFlag } from './lib/argv.ts';
import { errorBox, usageBox } from './ui/format.ts';
import { classifyError, EXIT_INVALID_ARGS } from './lib/exit-codes.ts';
import { UsageError, isUsageError } from './lib/errors.ts';
import { writeJsonError } from './lib/json-output.ts';
import { PKG_VERSION } from './lib/pkg.ts';
import { migrateOldWallet } from './lib/wallet-config.ts';

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

// Auto-migrate old ~/.midnight/wallet.json → wallets/default.json (silent, one-time)
migrateOldWallet();

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
    case 'wallet': {
      const { default: handler } = await import('./commands/wallet.ts');
      return handler(args);
    }
    case 'generate': {
      process.stderr.write(
        '\n  Note: "midnight generate" is deprecated.\n' +
        '  Use "midnight wallet generate <name>" instead.\n\n'
      );
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
    case 'cache': {
      const { default: handler } = await import('./commands/cache.ts');
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
    case 'status':
      throw new Error('The "status" command is currently being reworked. Check back soon.');
    case 'serve': {
      const { default: handler } = await import('./commands/serve.ts');
      return handler(args, signal);
    }
    case 'test': {
      const { default: handler } = await import('./commands/test.ts');
      return handler(args, signal);
    }
    case 'contract': {
      const { default: handler } = await import('./commands/contract.ts');
      return handler(args, signal);
    }
    case 'dev': {
      const { default: handler } = await import('./commands/dev.ts');
      return handler(args, signal);
    }
    default:
      throw new UsageError(
        `Unknown command: "${command}"\n` +
        `Run "midnight help" to see available commands.`
      );
  }
}

// Commands that start a WalletFacade leave WebSocket connections in the event loop.
// facade.stop() doesn't fully drain them, so we must exit explicitly.
// `dev` is in here because it provisions wallets internally (airdrop + dust register)
// which start facades whose WS handles aren't reliably reclaimed.
const FACADE_COMMANDS = new Set(['airdrop', 'transfer', 'dust', 'balance', 'serve', 'test', 'contract', 'dev']);

run().then(() => {
  if (FACADE_COMMANDS.has(command)) {
    process.exit(0);
  }
}).catch((err: Error) => {
  // Usage errors (missing/unknown subcommand, bad args) render in yellow
  // with a softer "Usage" framing. They are the user's prompt to fix and
  // retry, not a system failure. Exit code 2 (INVALID_ARGS).
  const message = err.message;
  if (isUsageError(err)) {
    if (jsonMode) {
      writeJsonError(err, 'INVALID_ARGS', EXIT_INVALID_ARGS);
    } else {
      process.stderr.write('\n' + usageBox(message, 'Run "midnight help" for full usage.') + '\n\n');
    }
    process.exit(EXIT_INVALID_ARGS);
  } else if (jsonMode) {
    const { exitCode, errorCode } = classifyError(err);
    writeJsonError(err, errorCode, exitCode);
    process.exit(exitCode);
  } else {
    process.stderr.write('\n' + errorBox(message, 'Run "midnight help" for usage information.') + '\n\n');
    const { exitCode } = classifyError(err);
    process.exit(exitCode);
  }
});

}
