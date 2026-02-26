import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { MIDNIGHT_DIR, DEFAULT_WALLET_FILENAME } from './constants.ts';

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
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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

  if (!config.seed || !config.network || !config.address) {
    throw new Error(
      `Wallet file is missing required fields (seed, network, address): ${resolvedPath}`
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
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  fs.writeFileSync(resolvedPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return resolvedPath;
}
