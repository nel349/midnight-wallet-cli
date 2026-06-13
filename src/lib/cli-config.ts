import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { MIDNIGHT_DIR, DEFAULT_CONFIG_FILENAME, DIR_MODE, FILE_MODE, isValidWalletName } from './constants.ts';
import { type NetworkName, isValidNetworkName } from './network.ts';

/** Endpoint overrides for one network. Keys mirror the flag/config names. */
export interface NetworkEndpointOverrides {
  'proof-server'?: string;
  node?: string;
  'indexer-ws'?: string;
}

export interface CliConfig {
  network: NetworkName;
  /**
   * Per-network endpoint overrides — the canonical home for custom URLs.
   * Endpoints are inherently network-specific; scoping them prevents a
   * preprod node URL from leaking into `--network undeployed` runs.
   */
  networks?: Partial<Record<NetworkName, NetworkEndpointOverrides>>;
  /**
   * Legacy flat overrides (pre-scoping). Still read for backward
   * compatibility, but they only apply when the resolved network matches
   * the config's pinned `network` — the network they were set under.
   * New writes go to `networks.<name>.*`.
   */
  'proof-server'?: string;
  node?: string;
  'indexer-ws'?: string;
  wallet?: string;
}

const DEFAULT_CLI_CONFIG: CliConfig = {
  network: 'undeployed',
};

const VALID_CONFIG_KEYS: readonly string[] = ['network', 'proof-server', 'node', 'indexer-ws', 'wallet'] as const;

/**
 * Aliases mapped to canonical config keys. Keeps integrations that learned
 * a different name working without forcing them to update. Add carefully —
 * each entry is a permanent compatibility surface.
 *   network-id → network: midnight-expert's setup-test-wallets skill
 *     instructs agents to read `network-id`. Resolve transparently so their
 *     flow doesn't error at step 1.
 */
const CONFIG_KEY_ALIASES: Readonly<Record<string, string>> = {
  'network-id': 'network',
};

function resolveConfigKey(key: string): string {
  return CONFIG_KEY_ALIASES[key] ?? key;
}

const ENDPOINT_KEYS = new Set(['proof-server', 'node', 'indexer-ws']);

function isValidUrl(value: string): boolean {
  return /^(https?|wss?):\/\/\S+/.test(value);
}

function getConfigDir(configDir?: string): string {
  return configDir ?? path.join(homedir(), MIDNIGHT_DIR);
}

function getConfigPath(configDir?: string): string {
  return path.join(getConfigDir(configDir), DEFAULT_CONFIG_FILENAME);
}

function ensureConfigDir(configDir?: string): void {
  const dir = getConfigDir(configDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
}

/**
 * Load CLI config from ~/.midnight/config.json.
 * Returns defaults if the file doesn't exist.
 */
export function loadCliConfig(configDir?: string): CliConfig {
  const configPath = getConfigPath(configDir);

  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CLI_CONFIG };
  }

  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return { ...DEFAULT_CLI_CONFIG };
  }

  let parsed: Partial<CliConfig>;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ...DEFAULT_CLI_CONFIG };
  }

  const config: CliConfig = {
    network: parsed.network && isValidNetworkName(parsed.network)
      ? parsed.network
      : DEFAULT_CLI_CONFIG.network,
  };

  if (parsed['proof-server'] && typeof parsed['proof-server'] === 'string') {
    config['proof-server'] = parsed['proof-server'];
  }
  if (parsed.node && typeof parsed.node === 'string') {
    config.node = parsed.node;
  }
  if (parsed['indexer-ws'] && typeof parsed['indexer-ws'] === 'string') {
    config['indexer-ws'] = parsed['indexer-ws'];
  }
  if (parsed.wallet && typeof parsed.wallet === 'string') {
    config.wallet = parsed.wallet;
  }

  // Per-network endpoint overrides: keep only valid network names and
  // string-valued endpoint keys; drop anything else silently (config files
  // are user-edited — tolerate junk rather than crash every command).
  if (parsed.networks && typeof parsed.networks === 'object') {
    const networks: Partial<Record<NetworkName, NetworkEndpointOverrides>> = {};
    for (const [name, overrides] of Object.entries(parsed.networks)) {
      if (!isValidNetworkName(name) || !overrides || typeof overrides !== 'object') continue;
      const scoped: NetworkEndpointOverrides = {};
      for (const key of ENDPOINT_KEYS) {
        const value = (overrides as Record<string, unknown>)[key];
        if (value && typeof value === 'string') {
          scoped[key as keyof NetworkEndpointOverrides] = value;
        }
      }
      if (Object.keys(scoped).length > 0) networks[name] = scoped;
    }
    if (Object.keys(networks).length > 0) config.networks = networks;
  }

  return config;
}

/**
 * Endpoint overrides that apply to `networkName`, resolved with scoping rules:
 *   scoped (`networks.<name>.*`) wins over legacy flat keys, and flat keys
 *   only apply when `networkName` is the config's pinned network — the
 *   network they were set under. This is what stops a preprod node URL in
 *   the config from hijacking `--network undeployed` runs.
 */
export function getEndpointOverridesForNetwork(
  config: CliConfig,
  networkName: NetworkName,
): NetworkEndpointOverrides {
  const scoped = config.networks?.[networkName] ?? {};
  const flatApplies = networkName === config.network;
  return {
    'proof-server': scoped['proof-server'] ?? (flatApplies ? config['proof-server'] : undefined),
    node: scoped.node ?? (flatApplies ? config.node : undefined),
    'indexer-ws': scoped['indexer-ws'] ?? (flatApplies ? config['indexer-ws'] : undefined),
  };
}

/**
 * Save CLI config to ~/.midnight/config.json.
 * Creates the directory if it doesn't exist.
 */
export function saveCliConfig(config: CliConfig, configDir?: string): void {
  ensureConfigDir(configDir);
  const configPath = getConfigPath(configDir);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: FILE_MODE });
}

/**
 * Get a single config value.
 * Endpoint keys are network-scoped: returns the value that applies to the
 * currently configured network (scoped entry first, then the legacy flat key).
 */
export function getConfigValue(key: string, configDir?: string): string {
  const canonical = resolveConfigKey(key);
  const config = loadCliConfig(configDir);

  if (canonical === 'network') return config.network;
  if (canonical === 'wallet') return config.wallet ?? '(not set)';
  if (ENDPOINT_KEYS.has(canonical)) {
    const overrides = getEndpointOverridesForNetwork(config, config.network);
    const value = overrides[canonical as keyof NetworkEndpointOverrides];
    return typeof value === 'string' ? value : '(not set)';
  }

  throw new Error(
    `Unknown config key: "${key}"\nValid keys: ${VALID_CONFIG_KEYS.join(', ')}`
  );
}

/**
 * Migrate legacy flat endpoint keys into the scope of `networkName` —
 * the network they were set under. Called before switching networks so a
 * preprod node URL set as a flat key stays a *preprod* override instead of
 * following the user to the next network. Scoped entries win on conflict.
 */
function migrateFlatEndpointsToScope(config: CliConfig, networkName: NetworkName): void {
  const scoped: NetworkEndpointOverrides = { ...(config.networks?.[networkName] ?? {}) };
  let migrated = false;
  for (const key of ENDPOINT_KEYS) {
    const k = key as keyof NetworkEndpointOverrides;
    const flat = config[k];
    if (flat && typeof flat === 'string') {
      if (!scoped[k]) scoped[k] = flat;
      delete config[k];
      migrated = true;
    }
  }
  if (migrated) {
    config.networks = { ...(config.networks ?? {}), [networkName]: scoped };
  }
}

/**
 * Set a single config value with validation.
 * Endpoint keys are written scoped under the currently configured network
 * (`networks.<name>.*`); any legacy flat copy of that key is removed so the
 * two can't diverge. Switching `network` first migrates legacy flat endpoint
 * keys into the old network's scope — they were set while using it.
 */
export function setConfigValue(key: string, value: string, configDir?: string): void {
  const canonical = resolveConfigKey(key);
  const config = loadCliConfig(configDir);

  if (canonical === 'network') {
    if (!isValidNetworkName(value)) {
      throw new Error(
        `Invalid network: "${value}"\nValid networks: preprod, preview, undeployed`
      );
    }
    migrateFlatEndpointsToScope(config, config.network);
    config.network = value;
  } else if (canonical === 'wallet') {
    if (!isValidWalletName(value)) {
      throw new Error(
        `Invalid wallet name: "${value}"\nWallet name must be a simple name (no path separators, .json suffix, or special characters).`
      );
    }
    config.wallet = value;
  } else if (ENDPOINT_KEYS.has(canonical)) {
    if (!isValidUrl(value)) {
      throw new Error(
        `Invalid URL for "${key}": "${value}"\nMust start with http://, https://, ws://, or wss://`
      );
    }
    const k = canonical as keyof NetworkEndpointOverrides;
    const scoped: NetworkEndpointOverrides = { ...(config.networks?.[config.network] ?? {}) };
    scoped[k] = value;
    config.networks = { ...(config.networks ?? {}), [config.network]: scoped };
    delete config[k];
  } else {
    throw new Error(
      `Unknown config key: "${key}"\nValid keys: ${VALID_CONFIG_KEYS.join(', ')}`
    );
  }

  saveCliConfig(config, configDir);
}

/**
 * Unset (reset) a single config value.
 * For 'network': resets to default ('undeployed').
 * For endpoint keys: removes both the current network's scoped entry and the
 * legacy flat key (so one unset reliably clears whatever was applying).
 * For other optional keys: removes the key entirely.
 */
export function unsetConfigValue(key: string, configDir?: string): void {
  const canonical = resolveConfigKey(key);
  const config = loadCliConfig(configDir);

  if (canonical === 'network') {
    config.network = DEFAULT_CLI_CONFIG.network;
  } else if (canonical === 'wallet') {
    delete config.wallet;
  } else if (ENDPOINT_KEYS.has(canonical)) {
    const k = canonical as keyof NetworkEndpointOverrides;
    delete config[k];
    const scoped = config.networks?.[config.network];
    if (scoped) {
      delete scoped[k];
      if (Object.keys(scoped).length === 0) {
        delete config.networks![config.network];
        if (Object.keys(config.networks!).length === 0) delete config.networks;
      }
    }
  } else {
    throw new Error(
      `Unknown config key: "${key}"\nValid keys: ${VALID_CONFIG_KEYS.join(', ')}`
    );
  }

  saveCliConfig(config, configDir);
}

export function getValidConfigKeys(): readonly string[] {
  return VALID_CONFIG_KEYS;
}
