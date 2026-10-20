import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { MIDNIGHT_DIR, DEFAULT_WALLET_FILENAME, WALLETS_DIR_NAME, DEFAULT_WALLET_NAME, DIR_MODE, FILE_MODE, isValidWalletName } from './constants.ts';
import { isValidNetworkName, type NetworkName } from './network.ts';
import { loadCliConfig, saveCliConfig } from './cli-config.ts';
import { deriveAllAddresses, deriveAllShieldedAddresses } from './derive-address.ts';
import { isSealedSecret, openSecret, sealSecret } from './keystore.ts';
import { type PassphraseSource, unlockPassphrase } from './passphrase.ts';

/** What anyone may read of a wallet: its addresses, and whether its secrets are sealed. No secret. */
export interface WalletConfig {
  addresses: Record<NetworkName, string>;
  shieldedAddresses?: Record<NetworkName, string>;
  createdAt: string;
  /** False for a wallet an earlier mn wrote in plain text, until `midnight wallet protect`. */
  isSealed: boolean;
}

/** A wallet's secrets: sealed under mn's passphrase in the file, never in the clear. */
export interface WalletSecrets {
  seed: string;
  mnemonic?: string;
}

/** A wallet's public part, as a new wallet file holds it. */
export type WalletPublic = Omit<WalletConfig, 'isSealed'>;

/** A wallet opened for a command that needs its seed. */
export type UnlockedWallet = WalletConfig & WalletSecrets;

export interface WalletInfo {
  name: string;
  addresses: Record<NetworkName, string>;
  shieldedAddresses?: Record<NetworkName, string>;
  isActive: boolean;
  createdAt?: string;
  file: string;
}

/**
 * Save shielded address for a specific network to an existing wallet file.
 * Reads the file, updates the shieldedAddresses map for that network, writes back.
 * Migrates the legacy singular `shieldedAddress` field if present.
 */
export function saveShieldedAddress(
  walletPath: string,
  network: NetworkName,
  shieldedAddress: string,
): void {
  const resolvedPath = path.resolve(walletPath);
  if (!fs.existsSync(resolvedPath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
    const existing = (raw.shieldedAddresses && typeof raw.shieldedAddresses === 'object')
      ? raw.shieldedAddresses
      : {};
    existing[network] = shieldedAddress;
    raw.shieldedAddresses = existing;
    // Drop the legacy singular field once we have a map entry for the same network
    if (raw.shieldedAddress && raw.shieldedAddress === shieldedAddress) {
      delete raw.shieldedAddress;
    }
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
      // Resolve shielded addresses map — prefer new field, fall back to seed derivation
      let shieldedAddresses: Record<NetworkName, string> | undefined;
      if (content.shieldedAddresses && typeof content.shieldedAddresses === 'object') {
        shieldedAddresses = content.shieldedAddresses;
      } else if (content.seed) {
        try {
          shieldedAddresses = deriveAllShieldedAddresses(Buffer.from(content.seed, 'hex'));
        } catch { /* best-effort */ }
      }
      return {
        name,
        addresses,
        shieldedAddresses,
        isActive: name === activeName,
        createdAt: typeof content.createdAt === 'string' ? content.createdAt : undefined,
        file: filePath,
      };
    } catch {
      return {
        name,
        addresses: { undeployed: '(invalid)', preprod: '(invalid)', preview: '(invalid)' } as Record<NetworkName, string>,
        isActive: name === activeName,
        file: filePath,
      };
    }
  });
}

/**
 * Find which of the given wallets owns an address, and on which network.
 * Matches both the unshielded and shielded address maps. Pure — takes the
 * wallet list so it can be tested without touching the real wallets directory.
 */
export function matchWalletAddress(
  wallets: WalletInfo[],
  address: string,
): { wallet: WalletInfo; network: NetworkName } | undefined {
  for (const wallet of wallets) {
    for (const [network, addr] of Object.entries(wallet.addresses) as [NetworkName, string][]) {
      if (addr === address) return { wallet, network };
    }
    if (wallet.shieldedAddresses) {
      for (const [network, addr] of Object.entries(wallet.shieldedAddresses) as [NetworkName, string][]) {
        if (addr === address) return { wallet, network };
      }
    }
  }
  return undefined;
}

/**
 * Locate the saved wallet that owns an address (across all networks), if any.
 * Convenience wrapper over matchWalletAddress + listWallets.
 */
export function findWalletByAddress(
  address: string,
): { wallet: WalletInfo; network: NetworkName } | undefined {
  return matchWalletAddress(listWallets(), address);
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

  if (isSealedSecret(raw.sealed)) {
    if (!raw.addresses || typeof raw.addresses !== 'object' || typeof raw.createdAt !== 'string') {
      throw new Error(`Wallet file is missing required fields (addresses, createdAt): ${resolvedPath}`);
    }
    const sealedConfig: WalletConfig = { addresses: raw.addresses, createdAt: raw.createdAt, isSealed: true };
    if (raw.shieldedAddresses && typeof raw.shieldedAddresses === 'object') sealedConfig.shieldedAddresses = raw.shieldedAddresses;
    return sealedConfig;
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
      addresses,
      createdAt: raw.createdAt,
      isSealed: false,
    };
    const shieldedAddresses = resolveShieldedAddresses(raw, seedBuffer);
    if (shieldedAddresses) config.shieldedAddresses = shieldedAddresses;

    // Write back migrated format (keep old fields for backwards compat)
    const migrated = { ...raw, addresses };
    if (shieldedAddresses) {
      migrated.shieldedAddresses = shieldedAddresses;
      delete migrated.shieldedAddress;
    }
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
    addresses: raw.addresses,
    createdAt: raw.createdAt,
    isSealed: false,
  };

  const seedBuffer = Buffer.from(raw.seed, 'hex');
  const shieldedAddresses = resolveShieldedAddresses(raw, seedBuffer);
  if (shieldedAddresses) config.shieldedAddresses = shieldedAddresses;

  // One-time backfill: if the file is missing shieldedAddresses (or only has
  // the legacy singular shieldedAddress), persist the full map so `mn wallet
  // info` shows all three networks without requiring `mn balance --shielded`.
  const needsBackfill = shieldedAddresses && (
    !raw.shieldedAddresses ||
    typeof raw.shieldedAddresses !== 'object' ||
    Object.keys(raw.shieldedAddresses).length < Object.keys(shieldedAddresses).length
  );
  if (needsBackfill) {
    try {
      const updated = { ...raw, shieldedAddresses };
      delete updated.shieldedAddress;
      fs.writeFileSync(resolvedPath, JSON.stringify(updated, null, 2) + '\n', { mode: FILE_MODE });
    } catch { /* best-effort */ }
  }

  return config;
}

/**
 * Resolve shielded addresses from a raw wallet JSON object.
 *
 * Stored entries win, derivation fills the gaps. Stored values are deterministic
 * functions of the seed, so they should already match derivation — but if a
 * future seed format ever changes encoding without changing the seed itself,
 * preferring stored values protects external tools that read the file directly.
 */
function resolveShieldedAddresses(
  raw: any,
  seedBuffer: Buffer,
): Record<NetworkName, string> | undefined {
  let derived: Record<NetworkName, string> | undefined;
  try {
    derived = deriveAllShieldedAddresses(seedBuffer);
  } catch { /* derivation can fail on malformed seeds */ }

  const storedRaw = raw.shieldedAddresses;
  const stored = (storedRaw && typeof storedRaw === 'object') ? storedRaw as Record<string, string> : null;
  const validStored = stored
    ? Object.fromEntries(Object.entries(stored).filter(([, v]) => typeof v === 'string' && v.length > 0))
    : {};

  if (!derived) {
    return Object.keys(validStored).length > 0 ? validStored as Record<NetworkName, string> : undefined;
  }
  return { ...derived, ...validStored } as Record<NetworkName, string>;
}

/** Writes `value` to `file` whole or not at all: a temporary file, then a rename over it. */
function writeFileAtomically(file: string, value: unknown, flag: 'w' | 'wx' = 'w'): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if (flag === 'wx' && fs.existsSync(file)) throw new Error(`Wallet file already exists: ${file}`);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', FILE_MODE);
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

const sealedSecretsOf = (secrets: WalletSecrets, passphrase: string) =>
  sealSecret(Buffer.from(JSON.stringify(secrets.mnemonic === undefined ? { seed: secrets.seed } : secrets), 'utf8'), passphrase, 'wallet');

/**
 * Writes a new wallet: its public part readable, its seed and mnemonic sealed
 * under `passphrase`. Never over an existing file unless `overwrite` says so
 * (`--force`), and then in one rename, so the old file is never half replaced.
 */
export function writeSealedWallet(walletPath: string, wallet: WalletPublic, secrets: WalletSecrets, passphrase: string, { overwrite = false }: { overwrite?: boolean } = {}): string {
  const resolvedPath = path.resolve(walletPath);
  if (!/^[0-9a-fA-F]+$/.test(secrets.seed)) throw new Error('A wallet seed is hex.');
  writeFileAtomically(resolvedPath, { ...wallet, sealed: sealedSecretsOf(secrets, passphrase) }, overwrite ? 'w' : 'wx');
  return resolvedPath;
}

/**
 * Seals a plain-text wallet in place under `passphrase`, keeping every other
 * field it holds. What was sealed is opened again before the file is
 * replaced, so a wallet is never left unreadable. A sealed wallet is left as it is.
 */
export function sealWalletInPlace(walletPath: string, passphrase: string): boolean {
  const resolvedPath = path.resolve(walletPath);
  const config = loadWalletConfig(resolvedPath);
  if (config.isSealed) return false;
  const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
  const secrets: WalletSecrets = typeof raw.mnemonic === 'string' ? { seed: raw.seed, mnemonic: raw.mnemonic } : { seed: raw.seed };
  const sealed = sealedSecretsOf(secrets, passphrase);
  const reopened = JSON.parse(openSecret(sealed, passphrase, 'wallet').toString('utf8')) as WalletSecrets;
  if (reopened.seed !== secrets.seed || reopened.mnemonic !== secrets.mnemonic) throw new Error(`Sealing ${resolvedPath} did not round-trip; the file is unchanged.`);
  const { seed: _seed, mnemonic: _mnemonic, address: _address, ...kept } = raw;
  writeFileAtomically(resolvedPath, { ...kept, addresses: config.addresses, ...(config.shieldedAddresses ? { shieldedAddresses: config.shieldedAddresses } : {}), sealed });
  return true;
}

/** What `midnight wallet protect` did to one wallet: sealed it now, or found it sealed already. */
export interface ProtectedWallet {
  name: string;
  file: string;
  sealedNow: boolean;
}

/** Seals every wallet under `home` that is still in plain text, under `passphrase`, in name order. */
export function protectAllWallets(home: string, passphrase: string): ProtectedWallet[] {
  const walletsDir = path.join(home, MIDNIGHT_DIR, WALLETS_DIR_NAME);
  const files = fs.existsSync(walletsDir) ? fs.readdirSync(walletsDir).filter((f) => f.endsWith('.json')).sort() : [];
  // A wallet from before named wallets, if it was never moved into wallets/.
  const legacy = path.join(home, MIDNIGHT_DIR, DEFAULT_WALLET_FILENAME);
  const entries = files.map((f) => ({ name: f.replace(/\.json$/, ''), file: path.join(walletsDir, f) }));
  if (fs.existsSync(legacy)) entries.push({ name: DEFAULT_WALLET_FILENAME.replace(/\.json$/, ''), file: legacy });
  return entries.map(({ name, file }) => ({ name, file, sealedNow: sealWalletInPlace(file, passphrase) }));
}

/** How a wallet is unlocked: whose home holds mn's passphrase check, where the passphrase comes from, and where a warning goes. */
export interface UnlockOptions {
  home?: string;
  source?: PassphraseSource;
  warn?: (line: string) => void;
}

// Each plain-text wallet is warned about once per run.
const warnedPlain = new Set<string>();

/** A wallet with its secrets: opened with mn's passphrase, or read as it is from a plain-text file an earlier mn wrote. */
export async function unlockWallet(walletPath: string, options: UnlockOptions = {}): Promise<UnlockedWallet> {
  const resolvedPath = path.resolve(walletPath);
  const config = loadWalletConfig(resolvedPath);
  const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
  if (!config.isSealed) {
    if (!warnedPlain.has(resolvedPath) || options.warn !== undefined) {
      warnedPlain.add(resolvedPath);
      (options.warn ?? ((line: string) => process.stderr.write(line + '\n')))(
        `Warning: wallet ${resolvedPath} is not protected: its seed is in plain text. Encrypt it with: midnight wallet protect`,
      );
    }
    return typeof raw.mnemonic === 'string' ? { ...config, seed: raw.seed, mnemonic: raw.mnemonic } : { ...config, seed: raw.seed };
  }
  const passphrase = await unlockPassphrase(options.home ?? homedir(), options.source);
  const secrets = JSON.parse(openSecret(raw.sealed, passphrase, 'wallet').toString('utf8')) as WalletSecrets;
  return { ...config, ...secrets };
}
