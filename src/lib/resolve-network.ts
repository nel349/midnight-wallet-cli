// Network resolution chain — simplified 3-step priority
// 1. --network flag (explicit)
// 2. Default from ~/.midnight/config.json
// 3. Fallback: 'undeployed'

import { type ParsedArgs, getFlag } from './argv.ts';
import {
  type NetworkName,
  type NetworkConfig,
  isValidNetworkName,
  getValidNetworkNames,
  resolveNetworkConfig,
} from './network.ts';
import { loadCliConfig } from './cli-config.ts';

export interface NetworkResolutionContext {
  args: ParsedArgs;
  configDir?: string;
}

/**
 * Resolve the network name using the 3-step priority chain.
 * Throws if --network flag is provided but invalid.
 */
export function resolveNetworkName(ctx: NetworkResolutionContext): NetworkName {
  // 1. Explicit --network flag
  const flagValue = getFlag(ctx.args, 'network');
  if (flagValue !== undefined) {
    if (!isValidNetworkName(flagValue)) {
      throw new Error(
        `Invalid network: "${flagValue}"\n` +
        `Valid networks: ${getValidNetworkNames().join(', ')}`
      );
    }
    return flagValue;
  }

  // 2. Default from ~/.midnight/config.json
  const cliConfig = loadCliConfig(ctx.configDir);
  if (cliConfig.network && isValidNetworkName(cliConfig.network)) {
    return cliConfig.network;
  }

  // 3. Fallback
  return 'undeployed';
}

/**
 * Resolve network name + full config in one call.
 * Applies testcontainer port detection for undeployed.
 */
export function resolveNetwork(ctx: NetworkResolutionContext): {
  name: NetworkName;
  config: NetworkConfig;
} {
  const name = resolveNetworkName(ctx);
  const config = resolveNetworkConfig(name);
  return { name, config };
}
