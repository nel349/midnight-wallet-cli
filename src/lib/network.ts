import { execSync } from 'child_process';

export type NetworkName = 'preprod' | 'preview' | 'undeployed';

export interface NetworkConfig {
  indexer: string;
  indexerWS: string;
  node: string;
  proofServer: string;
  networkId: string;
}

const NETWORK_CONFIGS: Record<NetworkName, NetworkConfig> = {
  preprod: {
    indexer: 'https://indexer.preprod.midnight.network/api/v3/graphql',
    indexerWS: 'wss://indexer.preprod.midnight.network/api/v3/graphql/ws',
    node: 'wss://rpc.preprod.midnight.network',
    proofServer: 'http://localhost:6300',
    networkId: 'PreProd',
  },
  preview: {
    indexer: 'https://indexer.preview.midnight.network/api/v3/graphql',
    indexerWS: 'wss://indexer.preview.midnight.network/api/v3/graphql/ws',
    node: 'wss://rpc.preview.midnight.network',
    proofServer: 'http://localhost:6300',
    networkId: 'Preview',
  },
  undeployed: {
    indexer: 'http://localhost:8088/api/v3/graphql',
    indexerWS: 'ws://localhost:8088/api/v3/graphql/ws',
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
    const output = execSync(
      'docker ps --format "{{.Image}}|{{.Ports}}"',
      { encoding: 'utf-8', timeout: 5000 }
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
 * Resolve a full network config, applying testcontainer port overrides for undeployed.
 */
export function resolveNetworkConfig(name: NetworkName): NetworkConfig {
  const config = getNetworkConfig(name);

  if (name === 'undeployed') {
    const detected = detectTestcontainerPorts();

    if (detected.indexerPort) {
      config.indexer = `http://localhost:${detected.indexerPort}/api/v3/graphql`;
      config.indexerWS = `ws://localhost:${detected.indexerPort}/api/v3/graphql/ws`;
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
