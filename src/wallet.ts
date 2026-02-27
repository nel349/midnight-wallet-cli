// midnight-wallet-cli entry point
// Usage: midnight <command> [args]  (or: mn <command> [args])
// Dispatches to command handlers via dynamic import

import { createRequire } from 'node:module';
import { parseArgs, hasFlag } from './lib/argv.ts';
import { errorBox } from './ui/format.ts';

const args = parseArgs();

// Global --version / -v handling
if (hasFlag(args, 'version') || hasFlag(args, 'v')) {
  const require = createRequire(import.meta.url);
  const { version } = require('../package.json');
  process.stdout.write(version + '\n');
  process.exit(0);
}

// Global --help / -h handling
if (hasFlag(args, 'help') || hasFlag(args, 'h')) {
  args.command = 'help';
}

// Default to help when no command given
const command = args.command ?? 'help';

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
    default:
      throw new Error(
        `Unknown command: "${command}"\n` +
        `Run "midnight help" to see available commands.`
      );
  }
}

run().catch((err: Error) => {
  process.stderr.write('\n' + errorBox(err.message, 'Run "midnight help" for usage information.') + '\n\n');
  process.exit(1);
});
