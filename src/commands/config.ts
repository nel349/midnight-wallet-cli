// config command — get/set persistent CLI config
// config get <key> → stdout
// config set <key> <value> → success message on stderr

import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { isValidNetworkName, type NetworkName } from '../lib/network.ts';
import { UsageError } from '../lib/errors.ts';
import { getConfigValue, setConfigValue, unsetConfigValue, getValidConfigKeys } from '../lib/cli-config.ts';
import { green } from '../ui/colors.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function configCommand(args: ParsedArgs): Promise<void> {
  const action = args.subcommand;

  if (!action || !['get', 'set', 'unset'].includes(action)) {
    throw new UsageError(
      `Usage: midnight config <get|set|unset> <key> [value]\n` +
      `Valid keys: ${getValidConfigKeys().join(', ')}`
    );
  }

  const key = args.positionals[0];
  if (!key) {
    throw new UsageError(
      `Missing config key.\n` +
      `Valid keys: ${getValidConfigKeys().join(', ')}`
    );
  }

  // An endpoint key can be read or written for a network other than the selected one.
  const networkFlag = getFlag(args, 'network');
  if (networkFlag !== undefined && !isValidNetworkName(networkFlag)) {
    throw new UsageError(`Invalid network: "${networkFlag}"\nValid networks: preprod, preview, undeployed`);
  }
  const scope = networkFlag as NetworkName | undefined;

  if (action === 'get') {
    const value = getConfigValue(key, undefined, scope);
    if (hasFlag(args, 'json')) {
      writeJsonResult({ action: 'get', key, value });
      return;
    }
    process.stdout.write(value + '\n');
  } else if (action === 'unset') {
    unsetConfigValue(key, undefined, scope);
    const displayValue = key === 'network' ? '(default)' : '(removed)';
    if (hasFlag(args, 'json')) {
      writeJsonResult({ action: 'unset', key, value: displayValue });
      return;
    }
    process.stderr.write(green('✓') + ` ${key} ${displayValue}\n`);
  } else {
    const value = args.positionals[1];
    if (value === undefined) {
      throw new UsageError(`Missing value for config set.\nUsage: midnight config set ${key} <value>`);
    }
    setConfigValue(key, value, undefined, scope);
    if (hasFlag(args, 'json')) {
      writeJsonResult({ action: 'set', key, value });
      return;
    }
    process.stderr.write(green('✓') + ` ${key} = ${value}\n`);
  }
}
