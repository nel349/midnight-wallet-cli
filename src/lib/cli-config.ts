import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { MIDNIGHT_DIR, DEFAULT_CONFIG_FILENAME, DIR_MODE, FILE_MODE, isValidWalletName } from './constants.ts';
import { type NetworkName, isValidNetworkName } from './network.ts';

export interface CliConfig {
  network: NetworkName;
  'proof-server'?: string;
  node?: string;
  'indexer-ws'?: string;
  wallet?: string;
}

const DEFAULT_CLI_CONFIG: CliConfig = {
  network: 'undeployed',
};

const VALID_CONFIG_KEYS: readonly string[] = ['network', 'proof-server', 'node', 'indexer-ws', 'wallet'] as const;

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

  return config;
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
 */
export function getConfigValue(key: string, configDir?: string): string {
  const config = loadCliConfig(configDir);

  if (key === 'network') return config.network;
  if (key === 'wallet') return config.wallet ?? '(not set)';
  if (ENDPOINT_KEYS.has(key)) {
    const value = config[key as keyof CliConfig];
    return typeof value === 'string' ? value : '(not set)';
  }

  throw new Error(
    `Unknown config key: "${key}"\nValid keys: ${VALID_CONFIG_KEYS.join(', ')}`
  );
}

/**
 * Set a single config value with validation.
 */
export function setConfigValue(key: string, value: string, configDir?: string): void {
  const config = loadCliConfig(configDir);

  if (key === 'network') {
    if (!isValidNetworkName(value)) {
      throw new Error(
        `Invalid network: "${value}"\nValid networks: preprod, preview, undeployed`
      );
    }
    config.network = value;
  } else if (key === 'wallet') {
    if (!isValidWalletName(value)) {
      throw new Error(
        `Invalid wallet name: "${value}"\nWallet name must be a simple name (no path separators, .json suffix, or special characters).`
      );
    }
    config.wallet = value;
  } else if (ENDPOINT_KEYS.has(key)) {
    if (!isValidUrl(value)) {
      throw new Error(
        `Invalid URL for "${key}": "${value}"\nMust start with http://, https://, ws://, or wss://`
      );
    }
    config[key as 'proof-server' | 'node' | 'indexer-ws'] = value;
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
 * For optional keys: removes the key entirely.
 */
export function unsetConfigValue(key: string, configDir?: string): void {
  const config = loadCliConfig(configDir);

  if (key === 'network') {
    config.network = DEFAULT_CLI_CONFIG.network;
  } else if (key === 'wallet') {
    delete config.wallet;
  } else if (ENDPOINT_KEYS.has(key)) {
    delete config[key as 'proof-server' | 'node' | 'indexer-ws'];
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
