import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { MIDNIGHT_DIR, DEFAULT_WALLET_FILENAME, WALLETS_DIR_NAME, DEFAULT_WALLET_NAME, DIR_MODE, FILE_MODE, isValidWalletName } from './constants.ts';
import { isValidNetworkName } from './network.ts';
import { loadCliConfig, saveCliConfig } from './cli-config.ts';

export interface WalletConfig {
  seed: string;
  mnemonic?: string;
  network: string;
  address: string;
  createdAt: string;
}

export interface WalletInfo {
  name: string;
  address: string;
  network: string;
  isActive: boolean;
}

function getMidnightDir(): string {
  return path.join(homedir(), MIDNIGHT_DIR);
}

function getWalletsDir(): string {
  return path.join(getMidnightDir(), WALLETS_DIR_NAME);
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

function ensureWalletsDir(): void {
  ensureMidnightDir();
  const dir = getWalletsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
}

/**
 * Determine if a --wallet value looks like a file path (contains / or .json)
 * versus a wallet name (simple string like "alice").
 */
function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.endsWith('.json');
}

/**
 * Resolve a wallet name or path to an absolute file path.
 *
 * Resolution order:
 * 1. If nameOrPath contains '/' or ends with '.json' → treat as path (backward compat)
 * 2. If nameOrPath is a simple name → resolve to ~/.midnight/wallets/<name>.json
 * 3. If no argument: read active wallet from config → resolve by name
 * 4. If no config: use DEFAULT_WALLET_NAME → ~/.midnight/wallets/default.json
 */
export function resolveWalletPath(nameOrPath?: string): string {
  if (nameOrPath !== undefined) {
    if (looksLikePath(nameOrPath)) {
      return path.resolve(nameOrPath);
    }
    return path.join(getWalletsDir(), `${nameOrPath}.json`);
  }

  // No flag provided — check config for active wallet
  const config = loadCliConfig();
  const activeWallet = config.wallet ?? DEFAULT_WALLET_NAME;
  return path.join(getWalletsDir(), `${activeWallet}.json`);
}

/**
 * Get the active wallet name from config (or default).
 */
export function getActiveWalletName(): string {
  const config = loadCliConfig();
  return config.wallet ?? DEFAULT_WALLET_NAME;
}

/**
 * Set the active wallet in config.
 */
export function setActiveWallet(name: string): void {
  if (!isValidWalletName(name)) {
    throw new Error(
      `Invalid wallet name: "${name}"\nWallet name must be a simple name (no path separators, .json suffix, or special characters).`
    );
  }
  const walletPath = path.join(getWalletsDir(), `${name}.json`);
  if (!fs.existsSync(walletPath)) {
    throw new Error(
      `Wallet "${name}" not found.\nRun "midnight wallet list" to see available wallets.`
    );
  }
  const config = loadCliConfig();
  config.wallet = name;
  saveCliConfig(config);
}

/**
 * List all wallets in ~/.midnight/wallets/.
 */
export function listWallets(): WalletInfo[] {
  const walletsDir = getWalletsDir();
  if (!fs.existsSync(walletsDir)) {
    return [];
  }

  const activeName = getActiveWalletName();
  const files = fs.readdirSync(walletsDir).filter(f => f.endsWith('.json')).sort();

  return files.map(file => {
    const name = file.replace(/\.json$/, '');
    const filePath = path.join(walletsDir, file);
    try {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return {
        name,
        address: content.address ?? '(unknown)',
        network: content.network ?? '(unknown)',
        isActive: name === activeName,
      };
    } catch {
      return {
        name,
        address: '(invalid)',
        network: '(invalid)',
        isActive: name === activeName,
      };
    }
  });
}

/**
 * Remove a named wallet.
 * Refuses if it's the active wallet or the last remaining wallet.
 */
export function removeWallet(name: string): void {
  if (!isValidWalletName(name)) {
    throw new Error(
      `Invalid wallet name: "${name}"\nWallet name must be a simple name (no path separators, .json suffix, or special characters).`
    );
  }
  const walletsDir = getWalletsDir();
  const walletPath = path.join(walletsDir, `${name}.json`);

  if (!fs.existsSync(walletPath)) {
    throw new Error(
      `Wallet "${name}" not found.\nRun "midnight wallet list" to see available wallets.`
    );
  }

  const activeName = getActiveWalletName();
  if (name === activeName) {
    throw new Error(
      `Cannot remove the active wallet "${name}".\n` +
      `Switch to another wallet first: midnight wallet use <other-wallet>`
    );
  }

  const remaining = fs.readdirSync(walletsDir).filter(f => f.endsWith('.json'));
  if (remaining.length <= 1) {
    throw new Error(
      `Cannot remove "${name}" — it is the only wallet.\n` +
      `Create another wallet first: midnight wallet generate <name>`
    );
  }

  fs.unlinkSync(walletPath);
}

/**
 * Migrate old ~/.midnight/wallet.json to ~/.midnight/wallets/default.json.
 * Silent, one-time migration. No-op if wallets/ already has files or old wallet doesn't exist.
 */
export function migrateOldWallet(): void {
  const oldPath = getDefaultWalletPath();
  if (!fs.existsSync(oldPath)) return;

  const walletsDir = getWalletsDir();

  // If wallets/ already has files, don't migrate (user already using multi-wallet)
  if (fs.existsSync(walletsDir)) {
    const existing = fs.readdirSync(walletsDir).filter(f => f.endsWith('.json'));
    if (existing.length > 0) return;
  }

  // Ensure wallets directory exists
  ensureWalletsDir();

  // Move old wallet to wallets/default.json
  const newPath = path.join(walletsDir, `${DEFAULT_WALLET_NAME}.json`);
  fs.copyFileSync(oldPath, newPath);
  fs.chmodSync(newPath, FILE_MODE);
  fs.unlinkSync(oldPath);

  // Set active wallet to default
  const config = loadCliConfig();
  config.wallet = DEFAULT_WALLET_NAME;
  saveCliConfig(config);
}

/**
 * Load wallet config from a file.
 * Throws with an actionable message if file is missing or invalid.
 * Callers should use resolveWalletPath() to get the path first.
 */
export function loadWalletConfig(walletPath?: string): WalletConfig {
  const resolvedPath = walletPath
    ? path.resolve(walletPath)
    : getDefaultWalletPath();

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(
      `Wallet file not found: ${resolvedPath}\n` +
      `Generate a wallet first: midnight wallet generate <name> --network <name>`
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
 * Creates parent directories if they don't exist.
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
