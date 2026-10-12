import { execSync } from 'child_process';
import { blockfrostEndpoints, usesBlockfrost } from './blockfrost.ts';
import { loadCliConfig, getEndpointOverridesForNetwork } from './cli-config.ts';
import { INDEXER_GRAPHQL_PATH, INDEXER_GRAPHQL_WS_PATH } from './constants.ts';

export type NetworkName = 'preprod' | 'preview' | 'undeployed';

export interface NetworkConfig {
  indexer: string;
  indexerWS: string;
  node: string;
  proofServer: string;
  networkId: string;
}

const NETWORK_CONFIGS: Record<NetworkName, NetworkConfig> = {
  // Served by Blockfrost since Midnight shut its own preprod indexer down
  // (2026-10-09). These carry no project id: `resolveNetworkConfig` adds it.
  preprod: {
    ...blockfrostEndpoints('preprod', undefined),
    proofServer: 'http://localhost:6300',
    networkId: 'PreProd',
  },
  preview: {
    indexer: `https://indexer.preview.midnight.network${INDEXER_GRAPHQL_PATH}`,
    indexerWS: `wss://indexer.preview.midnight.network${INDEXER_GRAPHQL_WS_PATH}`,
    node: 'wss://rpc.preview.midnight.network',
    proofServer: 'http://localhost:6300',
    networkId: 'Preview',
  },
  undeployed: {
    indexer: `http://localhost:8088${INDEXER_GRAPHQL_PATH}`,
    indexerWS: `ws://localhost:8088${INDEXER_GRAPHQL_WS_PATH}`,
    node: 'ws://localhost:9944',
    proofServer: 'http://localhost:6300',
    networkId: 'Undeployed',
  },
};

const VALID_NETWORK_NAMES: readonly NetworkName[] = ['preprod', 'preview', 'undeployed'] as const;

export function isValidNetworkName(name: string): name is NetworkName {
  return VALID_NETWORK_NAMES.includes(name as NetworkName);
}

export function getNetworkConfig(name: NetworkName): NetworkConfig {
  return { ...NETWORK_CONFIGS[name] };
}

export function getValidNetworkNames(): readonly string[] {
  return VALID_NETWORK_NAMES;
}

/**
 * Detect network from a Midnight bech32m address prefix.
 * Returns null if the prefix doesn't match any known network.
 */
export function detectNetworkFromAddress(address: string): NetworkName | null {
  if (address.startsWith('mn_addr_preprod1')) return 'preprod';
  if (address.startsWith('mn_addr_preview1')) return 'preview';
  if (address.startsWith('mn_addr_undeployed1')) return 'undeployed';
  return null;
}

interface TestcontainerPorts {
  indexerPort?: number;
  nodePort?: number;
  proofServerPort?: number;
}

/**
 * Auto-detect testcontainer ports by querying `docker ps`.
 * Looks for running midnight-node, indexer-standalone, and proof-server containers.
 */
export function detectTestcontainerPorts(): TestcontainerPorts {
  try {
    // Docker's own complaint when it isn't running is not the user's business: stderr is dropped.
    const output = execSync(
      'docker ps --format "{{.Image}}|{{.Ports}}"',
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    );

    const result: TestcontainerPorts = {};

    for (const line of output.trim().split('\n')) {
      if (!line) continue;
      const [image, ports] = line.split('|');

      const extractHostPort = (containerPort: number): number | undefined => {
        const regex = new RegExp(`0\\.0\\.0\\.0:(\\d+)->${containerPort}/tcp`);
        const match = ports?.match(regex);
        return match ? parseInt(match[1], 10) : undefined;
      };

      if (image.includes('indexer-standalone') || image.includes('indexer')) {
        const port = extractHostPort(8088);
        if (port) result.indexerPort = port;
      }
      if (image.includes('midnight-node')) {
        const port = extractHostPort(9944);
        if (port) result.nodePort = port;
      }
      if (image.includes('proof-server')) {
        const port = extractHostPort(6300);
        if (port) result.proofServerPort = port;
      }
    }

    return result;
  } catch {
    return {};
  }
}

/**
 * Resolve a full network config: the Blockfrost project id on a network
 * Blockfrost serves, testcontainer port overrides on undeployed.
 */
export function resolveNetworkConfig(name: NetworkName, blockfrostProjectId?: string): NetworkConfig {
  const config = getNetworkConfig(name);
  if (usesBlockfrost(name)) Object.assign(config, blockfrostEndpoints(name, blockfrostProjectId));

  if (name === 'undeployed') {
    const detected = detectTestcontainerPorts();

    if (detected.indexerPort) {
      config.indexer = `http://localhost:${detected.indexerPort}${INDEXER_GRAPHQL_PATH}`;
      config.indexerWS = `ws://localhost:${detected.indexerPort}${INDEXER_GRAPHQL_WS_PATH}`;
    }
    if (detected.nodePort) {
      config.node = `ws://localhost:${detected.nodePort}`;
    }
    if (detected.proofServerPort) {
      config.proofServer = `http://localhost:${detected.proofServerPort}`;
    }
  }

  return config;
}

export interface EndpointOverrides {
  proofServer?: string;
  node?: string;
  indexerWS?: string;
}

/**
 * Apply endpoint overrides to a network config.
 * Priority: flag overrides > persistent config (scoped to `networkName`) >
 * network defaults. Config overrides are network-scoped because endpoints
 * are inherently network-specific — a preprod node URL must never apply to
 * an `--network undeployed` run. See `getEndpointOverridesForNetwork` for
 * the scoping rules, including legacy flat-key compatibility.
 * Mutates and returns the config for convenience.
 */
export function applyEndpointOverrides(
  config: NetworkConfig,
  flagOverrides: EndpointOverrides,
  networkName: NetworkName,
  configDir?: string,
): NetworkConfig {
  const cliConfig = loadCliConfig(configDir);
  const scoped = getEndpointOverridesForNetwork(cliConfig, networkName);

  config.proofServer = flagOverrides.proofServer ?? scoped['proof-server'] ?? config.proofServer;
  config.node = flagOverrides.node ?? scoped.node ?? config.node;
  config.indexerWS = flagOverrides.indexerWS ?? scoped['indexer-ws'] ?? config.indexerWS;

  // Keep indexer HTTP in sync if indexer WS was overridden
  if (flagOverrides.indexerWS ?? scoped['indexer-ws']) {
    config.indexer = indexerHttpFromWs(config.indexerWS);
  }

  return config;
}

/**
 * The indexer's HTTP GraphQL URL for its WebSocket URL: the protocol changed
 * and the path's trailing `/ws` dropped. A query string (a Blockfrost project
 * id) stays where it is.
 */
export function indexerHttpFromWs(wsUrl: string): string {
  const queryAt = wsUrl.indexOf('?');
  const [base, query] = queryAt === -1 ? [wsUrl, ''] : [wsUrl.slice(0, queryAt), wsUrl.slice(queryAt)];
  return base.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/ws$/, '') + query;
}
