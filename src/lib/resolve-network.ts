// Network resolution chain — implements the 5-step priority from DESIGN.md
// 1. --network flag (explicit)
// 2. Wallet file's stored network
// 3. Auto-detect from address prefix
// 4. Default from ~/.midnight/config.json
// 5. Fallback: 'undeployed'

import { type ParsedArgs, getFlag } from './argv.ts';
import {
  type NetworkName,
  type NetworkConfig,
  isValidNetworkName,
  getValidNetworkNames,
  resolveNetworkConfig,
  detectNetworkFromAddress,
} from './network.ts';
import { loadCliConfig } from './cli-config.ts';

export interface NetworkResolutionContext {
  args: ParsedArgs;
  walletNetwork?: string;
  address?: string;
  configDir?: string;
}

/**
 * Resolve the network name using the 5-step priority chain.
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

  // 2. Wallet file's stored network
  if (ctx.walletNetwork && isValidNetworkName(ctx.walletNetwork)) {
    return ctx.walletNetwork;
  }

  // 3. Auto-detect from address prefix
  if (ctx.address) {
    const detected = detectNetworkFromAddress(ctx.address);
    if (detected) return detected;
  }

  // 4. Default from ~/.midnight/config.json
  const cliConfig = loadCliConfig(ctx.configDir);
  if (cliConfig.network && isValidNetworkName(cliConfig.network)) {
    return cliConfig.network;
  }

  // 5. Fallback
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
