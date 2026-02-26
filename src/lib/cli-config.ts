import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { MIDNIGHT_DIR, DEFAULT_CONFIG_FILENAME, DIR_MODE, FILE_MODE } from './constants.ts';
import { type NetworkName, isValidNetworkName } from './network.ts';

export interface CliConfig {
  network: NetworkName;
}

const DEFAULT_CLI_CONFIG: CliConfig = {
  network: 'undeployed',
};

const VALID_CONFIG_KEYS: readonly string[] = ['network'] as const;

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

  return {
    network: parsed.network && isValidNetworkName(parsed.network)
      ? parsed.network
      : DEFAULT_CLI_CONFIG.network,
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
 */
export function getConfigValue(key: string, configDir?: string): string {
  const config = loadCliConfig(configDir);

  if (key === 'network') return config.network;

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
