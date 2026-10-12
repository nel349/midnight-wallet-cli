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
  type EndpointOverrides,
} from './network.ts';
import { checkProjectId, networkOfProjectId, usesBlockfrost } from './blockfrost.ts';
import { getBlockfrostProjectId, loadCliConfig, getEndpointOverridesForNetwork } from './cli-config.ts';

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

/** Where a project id can be given for one run, or to a process that has no config (CI, an MCP server). */
export const BLOCKFROST_PROJECT_ID_ENV = 'MN_BLOCKFROST_PROJECT_ID';

/**
 * The name Midnight's own docs give the variable. Other Blockfrost tools use
 * it too (for another network's id, or another chain's), so a value that is
 * not this network's is passed over, not refused.
 */
export const SHARED_BLOCKFROST_PROJECT_ID_ENV = 'BLOCKFROST_PROJECT_ID';

/**
 * The Blockfrost project id for `name`: the environment's (mn's own variable,
 * then the shared one), else the one set with `midnight config set`.
 * Undefined on a network Blockfrost doesn't serve, and when none is set (a
 * command that then connects is told so). mn's own variable is checked; both
 * are used only for the network their id is for.
 */
export function resolveBlockfrostProjectId(
  name: NetworkName,
  configDir?: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!usesBlockfrost(name)) return undefined;
  const own = env[BLOCKFROST_PROJECT_ID_ENV]?.trim();
  if (own) {
    const { projectId, network } = checkProjectId(own);
    if (network === name) return projectId;
  }
  const shared = env[SHARED_BLOCKFROST_PROJECT_ID_ENV]?.trim();
  if (shared && /^[A-Za-z0-9]+$/.test(shared) && networkOfProjectId(shared) === name) return shared;
  return getBlockfrostProjectId(loadCliConfig(configDir), name);
}

/**
 * Resolve network name + full config in one call. Endpoints come from the
 * command's flags, then the saved config for this network, and only the
 * components given by neither are auto-detected on undeployed (detection
 * refuses when a needed component is ambiguous). Every caller gets the same
 * fully resolved endpoints.
 */
export function resolveNetwork(ctx: NetworkResolutionContext): {
  name: NetworkName;
  config: NetworkConfig;
} {
  const name = resolveNetworkName(ctx);
  const configured = getEndpointOverridesForNetwork(loadCliConfig(ctx.configDir), name);
  const given: EndpointOverrides = {
    node: getFlag(ctx.args, 'node') ?? configured.node,
    indexerWS: getFlag(ctx.args, 'indexer-ws') ?? configured['indexer-ws'],
    proofServer: getFlag(ctx.args, 'proof-server') ?? configured['proof-server'],
  };
  const config = resolveNetworkConfig(name, { given, blockfrostProjectId: resolveBlockfrostProjectId(name, ctx.configDir) });
  return { name, config };
}
