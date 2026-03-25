import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { MIDNIGHT_DIR, DEFAULT_WALLET_FILENAME, WALLETS_DIR_NAME, DEFAULT_WALLET_NAME, DIR_MODE, FILE_MODE, isValidWalletName } from './constants.ts';
import { isValidNetworkName, type NetworkName } from './network.ts';
import { loadCliConfig, saveCliConfig } from './cli-config.ts';
import { deriveAllAddresses } from './derive-address.ts';

export interface WalletConfig {
  seed: string;
  mnemonic?: string;
  addresses: Record<NetworkName, string>;
  shieldedAddress?: string;
  createdAt: string;
}

export interface WalletInfo {
  name: string;
  addresses: Record<NetworkName, string>;
  shieldedAddress?: string;
  isActive: boolean;
}

/**
 * Save shielded address to an existing wallet file.
 * Reads the file, adds shieldedAddress, writes back.
 */
export function saveShieldedAddress(walletPath: string, shieldedAddress: string): void {
  const resolvedPath = path.resolve(walletPath);
  if (!fs.existsSync(resolvedPath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
    raw.shieldedAddress = shieldedAddress;
    fs.writeFileSync(resolvedPath, JSON.stringify(raw, null, 2) + '\n', { mode: FILE_MODE });
  } catch { /* best-effort */ }
}

/**
 * Get the address for a specific network from a wallet config.
 */
export function getAddress(config: WalletConfig, network: NetworkName): string {
  return config.addresses[network];
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
      // Support both old format (address/network) and new format (addresses)
      let addresses: Record<NetworkName, string>;
      if (content.addresses) {
        addresses = content.addresses;
      } else if (content.address && content.seed) {
        // Old format — derive all addresses from seed
        try {
          const seedBuffer = Buffer.from(content.seed, 'hex');
          addresses = deriveAllAddresses(seedBuffer);
        } catch {
          addresses = { undeployed: content.address, preprod: '(unknown)', preview: '(unknown)' } as Record<NetworkName, string>;
        }
      } else {
        addresses = { undeployed: '(unknown)', preprod: '(unknown)', preview: '(unknown)' } as Record<NetworkName, string>;
      }
      return {
        name,
        addresses,
        shieldedAddress: content.shieldedAddress as string | undefined,
        isActive: name === activeName,
      };
    } catch {
      return {
        name,
        addresses: { undeployed: '(invalid)', preprod: '(invalid)', preview: '(invalid)' } as Record<NetworkName, string>,
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

  let raw: any;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in wallet file: ${resolvedPath}`);
  }

  // Check required fields (seed + createdAt are always required)
  if (!raw.seed || !raw.createdAt) {
    // Check for old-format fields too
    const requiredOld = ['seed', 'createdAt'];
    if (!raw.addresses) {
      requiredOld.push('address');
    }
    const missing = requiredOld.filter((f) => !raw[f]);
    if (missing.length > 0) {
      throw new Error(
        `Wallet file is missing required fields (${missing.join(', ')}): ${resolvedPath}`
      );
    }
  }

  if (!/^[0-9a-fA-F]+$/.test(raw.seed)) {
    throw new Error(
      `Invalid seed format in wallet file (expected hex string): ${resolvedPath}`
    );
  }

  // Auto-migrate old format: { address, network } → { addresses }
  if (!raw.addresses) {
    if (!raw.address) {
      throw new Error(
        `Wallet file is missing required fields (address): ${resolvedPath}`
      );
    }
    // Old format — derive all addresses from seed
    const seedBuffer = Buffer.from(raw.seed, 'hex');
    const addresses = deriveAllAddresses(seedBuffer);

    const config: WalletConfig = {
      seed: raw.seed,
      addresses,
      createdAt: raw.createdAt,
    };
    if (raw.mnemonic) config.mnemonic = raw.mnemonic;
    if (raw.shieldedAddress) config.shieldedAddress = raw.shieldedAddress;

    // Write back migrated format (keep old fields for backwards compat)
    const migrated = { ...raw, addresses };
    fs.writeFileSync(resolvedPath, JSON.stringify(migrated, null, 2) + '\n', { mode: FILE_MODE });

    return config;
  }

  // New format — validate addresses map
  if (typeof raw.addresses !== 'object') {
    throw new Error(
      `Wallet file has invalid addresses field: ${resolvedPath}`
    );
  }

  const config: WalletConfig = {
    seed: raw.seed,
    addresses: raw.addresses,
    createdAt: raw.createdAt,
  };
  if (raw.mnemonic) config.mnemonic = raw.mnemonic;
  if (raw.shieldedAddress) config.shieldedAddress = raw.shieldedAddress;

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
