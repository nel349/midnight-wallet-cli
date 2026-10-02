import { execSync } from 'child_process';
import { ProtocolVersion } from '@midnightntwrk/wallet-sdk';
import { loadCliConfig, getEndpointOverridesForNetwork } from './cli-config.ts';
import { INDEXER_GRAPHQL_PATH, INDEXER_GRAPHQL_WS_PATH } from './constants.ts';

export type NetworkName = 'preprod' | 'preview' | 'undeployed';

/**
 * Where ledger-v9 starts reading each chain, by protocol version. The SDK picks
 * the ledger version from this, and a wrong value doesn't degrade gracefully:
 * it makes the wrong ledger read the chain.
 *
 * This build targets ledger-9-native chains (the localnet reports protocol
 * version 2001000). wallet-sdk 2.0 can't sync against today's ledger-8
 * indexers anyway: it needs the 4.4 indexer schema.
 *
 * When preview/preprod fork to ledger 9, their schedule needs the version
 * the hand-over is enacted at. A chain with ledger-8 history doesn't use
 * the v9-native schedule.
 */
export const FORK_SCHEDULE: ProtocolVersion.ForkSchedule = ProtocolVersion.V9NativeForkSchedule;

export interface NetworkConfig {
  indexer: string;
  indexerWS: string;
  node: string;
  proofServer: string;
  networkId: string;
}

const NETWORK_CONFIGS: Record<NetworkName, NetworkConfig> = {
  preprod: {
    indexer: `https://indexer.preprod.midnight.network${INDEXER_GRAPHQL_PATH}`,
    indexerWS: `wss://indexer.preprod.midnight.network${INDEXER_GRAPHQL_WS_PATH}`,
    node: 'wss://rpc.preprod.midnight.network',
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

/** Host ports of each Midnight component running locally, distinct and sorted. */
export interface LocalStackPorts {
  node: number[];
  indexer: number[];
  proofServer: number[];
}

/**
 * Collect the host ports of local Midnight containers from
 * `docker ps --format "{{.Image}}|{{.Ports}}"` output.
 */
export function parseLocalStacks(dockerPsOutput: string): LocalStackPorts {
  const found = { node: new Set<number>(), indexer: new Set<number>(), proofServer: new Set<number>() };
  for (const line of dockerPsOutput.split('\n')) {
    if (!line) continue;
    const [image = '', ports = ''] = line.split('|');
    const hostPorts = (containerPort: number): number[] =>
      [...ports.matchAll(new RegExp(`:(\\d+)->${containerPort}/tcp`, 'g'))].map((m) => parseInt(m[1]!, 10));
    if (image.includes('indexer')) hostPorts(8088).forEach((p) => found.indexer.add(p));
    if (image.includes('midnight-node')) hostPorts(9944).forEach((p) => found.node.add(p));
    if (image.includes('proof-server')) hostPorts(6300).forEach((p) => found.proofServer.add(p));
  }
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  return { node: sorted(found.node), indexer: sorted(found.indexer), proofServer: sorted(found.proofServer) };
}

export class AmbiguousLocalStacksError extends Error {
  readonly code = 'AMBIGUOUS_LOCAL_STACKS';
  constructor(found: LocalStackPorts) {
    super(
      `Several local Midnight stacks are running (node ${found.node.join(', ')}; ` +
      `indexer ${found.indexer.join(', ')}; proof-server ${found.proofServer.join(', ')}), ` +
      `and mn won't guess which one to use.\n` +
      `Pick one per command:  --node ws://localhost:<port> --indexer-ws ws://localhost:<port>${INDEXER_GRAPHQL_WS_PATH} --proof-server http://localhost:<port>\n` +
      `or once:               midnight config set network undeployed, then midnight config set node / indexer-ws / proof-server <url>\n` +
      `Commands without endpoint flags (cache, test, dev) use the saved config. MN_NO_LOCAL_DETECT=1 turns detection off.`,
    );
    this.name = 'AmbiguousLocalStacksError';
  }
}

/** Which components still need a port from detection. */
export interface NeededComponents {
  node: boolean;
  indexer: boolean;
  proofServer: boolean;
}

const ALL_COMPONENTS: NeededComponents = { node: true, indexer: true, proofServer: true };

/**
 * The single local stack's ports for the components still needed. Throws
 * AmbiguousLocalStacksError when a needed component runs on more than one
 * port: picking would be a guess, and could mix two stacks. A component the
 * caller already has an endpoint for can't be ambiguous.
 */
export function pickLocalStack(found: LocalStackPorts, need: NeededComponents = ALL_COMPONENTS): TestcontainerPorts {
  if ((need.node && found.node.length > 1) || (need.indexer && found.indexer.length > 1)
      || (need.proofServer && found.proofServer.length > 1)) {
    throw new AmbiguousLocalStacksError(found);
  }
  return {
    nodePort: need.node ? found.node[0] : undefined,
    indexerPort: need.indexer ? found.indexer[0] : undefined,
    proofServerPort: need.proofServer ? found.proofServer[0] : undefined,
  };
}

/**
 * Read the local Midnight containers from docker (empty when docker isn't
 * available, or when MN_NO_LOCAL_DETECT=1 turns detection off and leaves
 * undeployed on its default endpoints).
 */
export function detectLocalStacks(): LocalStackPorts {
  if (process.env.MN_NO_LOCAL_DETECT === '1') return { node: [], indexer: [], proofServer: [] };
  try {
    return parseLocalStacks(execSync('docker ps --format "{{.Image}}|{{.Ports}}"', { encoding: 'utf-8', timeout: 5000 }));
  } catch {
    return { node: [], indexer: [], proofServer: [] };
  }
}

export interface ResolveNetworkConfigOptions {
  /** Endpoints given by flag or config. They win; only the rest are auto-detected. */
  given?: EndpointOverrides;
  /** Local stack detection (tests inject docker output). */
  detect?: () => LocalStackPorts;
}

/**
 * Resolve a full network config: given endpoints first, then (on undeployed)
 * the single running local stack's ports for the components not given, then
 * the network defaults. Refuses when a component it must detect is ambiguous.
 */
export function resolveNetworkConfig(name: NetworkName, options: ResolveNetworkConfigOptions = {}): NetworkConfig {
  const config = getNetworkConfig(name);
  const given = options.given ?? {};

  const need: NeededComponents = {
    node: given.node === undefined,
    indexer: given.indexerWS === undefined,
    proofServer: given.proofServer === undefined,
  };
  if (name === 'undeployed' && (need.node || need.indexer || need.proofServer)) {
    const detected = pickLocalStack((options.detect ?? detectLocalStacks)(), need);

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

  if (given.node !== undefined) config.node = given.node;
  if (given.proofServer !== undefined) config.proofServer = given.proofServer;
  if (given.indexerWS !== undefined) {
    config.indexerWS = given.indexerWS;
    config.indexer = indexerHttpFromWs(given.indexerWS);
  }
  return config;
}

/** The indexer's HTTP GraphQL URL for its WebSocket URL. */
export function indexerHttpFromWs(wsUrl: string): string {
  return wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/ws$/, '');
}

export interface EndpointOverrides {
  proofServer?: string;
  node?: string;
  indexerWS?: string;
}

/** The CLI flags carrying these endpoints, for building parsed args in code. */
export function endpointFlags(e: EndpointOverrides): Record<string, string> {
  const flags: Record<string, string> = {};
  if (e.node !== undefined) flags.node = e.node;
  if (e.indexerWS !== undefined) flags['indexer-ws'] = e.indexerWS;
  if (e.proofServer !== undefined) flags['proof-server'] = e.proofServer;
  return flags;
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
