// config command — get/set persistent CLI config
// config get <key> → stdout
// config set <key> <value> → success message on stderr

import { type ParsedArgs } from '../lib/argv.ts';
import { getConfigValue, setConfigValue, getValidConfigKeys } from '../lib/cli-config.ts';
import { green } from '../ui/colors.ts';

export default async function configCommand(args: ParsedArgs): Promise<void> {
  const action = args.subcommand;

  if (!action || (action !== 'get' && action !== 'set')) {
    throw new Error(
      `Usage: midnight config <get|set> <key> [value]\n` +
      `Valid keys: ${getValidConfigKeys().join(', ')}`
    );
  }

  const key = args.positionals[0];
  if (!key) {
    throw new Error(
      `Missing config key.\n` +
      `Valid keys: ${getValidConfigKeys().join(', ')}`
    );
  }

  if (action === 'get') {
    const value = getConfigValue(key);
    process.stdout.write(value + '\n');
  } else {
    const value = args.positionals[1];
    if (value === undefined) {
      throw new Error(`Missing value for config set.\nUsage: midnight config set ${key} <value>`);
    }
    setConfigValue(key, value);
    process.stderr.write(green('✓') + ` ${key} = ${value}\n`);
  }
}
