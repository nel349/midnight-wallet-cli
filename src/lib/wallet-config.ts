import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { MIDNIGHT_DIR, DEFAULT_WALLET_FILENAME, DIR_MODE, FILE_MODE } from './constants.ts';
import { isValidNetworkName } from './network.ts';

export interface WalletConfig {
  seed: string;
  mnemonic?: string;
  network: string;
  address: string;
  createdAt: string;
}

function getMidnightDir(): string {
  return path.join(homedir(), MIDNIGHT_DIR);
}

function getDefaultWalletPath(): string {
  return path.join(getMidnightDir(), DEFAULT_WALLET_FILENAME);
}

function ensureMidnightDir(): void {
  const dir = getMidnightDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
}

/**
 * Load wallet config from a file.
 * Uses ~/.midnight/wallet.json if no path specified.
 * Throws with an actionable message if file is missing or invalid.
 */
export function loadWalletConfig(walletPath?: string): WalletConfig {
  const resolvedPath = walletPath
    ? path.resolve(walletPath)
    : getDefaultWalletPath();

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Wallet file not found: ${resolvedPath}\n` +
      `Generate a wallet first: wallet generate --network <name>`
    );
  }

  let content: string;
  try {
    content = fs.readFileSync(resolvedPath, 'utf-8');
  } catch (err: any) {
    throw new Error(`Failed to read wallet file: ${resolvedPath}\n${err.message}`);
  }

  let config: WalletConfig;
  try {
    config = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in wallet file: ${resolvedPath}`);
  }

  if (!config.seed || !config.network || !config.address || !config.createdAt) {
    const missing = ['seed', 'network', 'address', 'createdAt'].filter(
      (f) => !config[f as keyof WalletConfig],
    );
    throw new Error(
      `Wallet file is missing required fields (${missing.join(', ')}): ${resolvedPath}`
    );
  }

  if (!/^[0-9a-fA-F]+$/.test(config.seed)) {
    throw new Error(
      `Invalid seed format in wallet file (expected hex string): ${resolvedPath}`
    );
  }

  if (!isValidNetworkName(config.network)) {
    throw new Error(
      `Invalid network "${config.network}" in wallet file: ${resolvedPath}\n` +
      `Valid networks: preprod, preview, undeployed`
    );
  }

  return config;
}

/**
 * Save wallet config to a file.
 * Uses ~/.midnight/wallet.json if no path specified.
 * Creates ~/.midnight/ directory if it doesn't exist.
 */
export function saveWalletConfig(config: WalletConfig, walletPath?: string): string {
  const resolvedPath = walletPath
    ? path.resolve(walletPath)
    : getDefaultWalletPath();

  if (!walletPath) {
    ensureMidnightDir();
  } else {
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    }
  }

  fs.writeFileSync(resolvedPath, JSON.stringify(config, null, 2) + '\n', { mode: FILE_MODE });
  return resolvedPath;
}
