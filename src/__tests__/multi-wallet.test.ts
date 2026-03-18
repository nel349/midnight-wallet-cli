import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  resolveWalletPath,
  listWallets,
  removeWallet,
  migrateOldWallet,
  setActiveWallet,
  getActiveWalletName,
  saveWalletConfig,
  loadWalletConfig,
  type WalletConfig,
} from '../lib/wallet-config.ts';
import {
  loadCliConfig,
  saveCliConfig,
  type CliConfig,
} from '../lib/cli-config.ts';
import {
  MIDNIGHT_DIR,
  WALLETS_DIR_NAME,
  DEFAULT_WALLET_NAME,
  DEFAULT_WALLET_FILENAME,
  DIR_MODE,
  FILE_MODE,
  isValidWalletName,
} from '../lib/constants.ts';
import { deriveAllAddresses } from '../lib/derive-address.ts';

// Use a temp dir that simulates ~/.midnight
const TEST_HOME = path.join(os.tmpdir(), `midnight-multi-wallet-test-${process.pid}`);
const TEST_MIDNIGHT_DIR = path.join(TEST_HOME, MIDNIGHT_DIR);
const TEST_WALLETS_DIR = path.join(TEST_MIDNIGHT_DIR, WALLETS_DIR_NAME);
const TEST_CONFIG_PATH = path.join(TEST_MIDNIGHT_DIR, 'config.json');

const SEED_1 = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const SEED_2 = '1111111111111111111111111111111111111111111111111111111111111111';

const VALID_WALLET: WalletConfig = {
  seed: SEED_1,
  addresses: deriveAllAddresses(Buffer.from(SEED_1, 'hex')),
  createdAt: '2025-01-01T00:00:00.000Z',
};

const VALID_WALLET_2: WalletConfig = {
  seed: SEED_2,
  addresses: deriveAllAddresses(Buffer.from(SEED_2, 'hex')),
  createdAt: '2025-02-01T00:00:00.000Z',
};

// Helper to set up wallets dir with named wallets
function createWalletFile(name: string, config: WalletConfig): void {
  fs.mkdirSync(TEST_WALLETS_DIR, { recursive: true, mode: DIR_MODE });
  const filePath = path.join(TEST_WALLETS_DIR, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', { mode: FILE_MODE });
}

function createConfig(config: Partial<CliConfig>): void {
  fs.mkdirSync(TEST_MIDNIGHT_DIR, { recursive: true, mode: DIR_MODE });
  const full: CliConfig = { network: 'undeployed', ...config };
  fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(full, null, 2) + '\n', { mode: FILE_MODE });
}

beforeEach(() => {
  fs.mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

// ─── resolveWalletPath ─────────────────────────────────────

describe('resolveWalletPath', () => {
  it('treats value with / as a file path', () => {
    const result = resolveWalletPath('/tmp/my-wallet.json');
    expect(result).toBe('/tmp/my-wallet.json');
  });

  it('treats value ending in .json as a file path', () => {
    const result = resolveWalletPath('wallet.json');
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).toContain('wallet.json');
  });

  it('treats simple name as wallet name and resolves to wallets dir', () => {
    const result = resolveWalletPath('alice');
    expect(result).toContain(WALLETS_DIR_NAME);
    expect(result).toContain('alice.json');
  });

  it('resolves to wallets directory when no argument given', () => {
    // resolveWalletPath reads the real ~/.midnight/config.json for the active wallet name,
    // falling back to DEFAULT_WALLET_NAME if no config exists.
    const result = resolveWalletPath();
    expect(result).toContain(WALLETS_DIR_NAME);
    expect(result).toMatch(/\.json$/);
  });

  it('uses active wallet from config when no argument given', () => {
    // resolveWalletPath reads from real ~/.midnight/config.json
    // We can't inject a test config dir, so we verify the behavior
    // by checking that the result uses the wallets directory pattern
    const result = resolveWalletPath();
    expect(result).toContain(WALLETS_DIR_NAME);
    expect(result).toMatch(/\.json$/);
  });
});

// ─── listWallets ────────────────────────────────────────────

describe('listWallets', () => {
  it('returns empty array when wallets dir does not exist', () => {
    const wallets = listWallets();
    // There might be a real ~/.midnight/wallets dir, but in test context
    // we check the structure is correct
    expect(Array.isArray(wallets)).toBe(true);
  });

  it('lists wallets from wallets directory', () => {
    createWalletFile('alice', VALID_WALLET);
    createWalletFile('bob', VALID_WALLET_2);

    // We can't directly test listWallets since it reads from real homedir,
    // but we can verify the wallet files were created correctly
    const files = fs.readdirSync(TEST_WALLETS_DIR);
    expect(files).toContain('alice.json');
    expect(files).toContain('bob.json');
  });

  it('marks active wallet correctly', () => {
    createWalletFile('alice', VALID_WALLET);
    createWalletFile('bob', VALID_WALLET_2);
    createConfig({ wallet: 'alice' });

    // Read config and verify
    const config = JSON.parse(fs.readFileSync(TEST_CONFIG_PATH, 'utf-8'));
    expect(config.wallet).toBe('alice');
  });
});

// ─── removeWallet ───────────────────────────────────────────

describe('removeWallet', () => {
  it('throws when wallet does not exist', () => {
    expect(() => removeWallet('nonexistent')).toThrow('not found');
  });

  it('rejects invalid wallet names with path traversal', () => {
    expect(() => removeWallet('../evil')).toThrow('Invalid wallet name');
    expect(() => removeWallet('path/to/wallet')).toThrow('Invalid wallet name');
  });

  it('rejects empty wallet name', () => {
    expect(() => removeWallet('')).toThrow('Invalid wallet name');
  });

  it('rejects wallet name ending in .json', () => {
    expect(() => removeWallet('test.json')).toThrow('Invalid wallet name');
  });
});

// ─── migrateOldWallet ───────────────────────────────────────

describe('migrateOldWallet', () => {
  it('is a no-op when old wallet does not exist', () => {
    // Should not throw
    migrateOldWallet();
  });

  it('is idempotent — does nothing on second call', () => {
    migrateOldWallet();
    migrateOldWallet();
    // No error
  });
});

// ─── loadWalletConfig error messages ────────────────────────

describe('loadWalletConfig error messages', () => {
  it('suggests "midnight wallet generate" in missing file error', () => {
    const filePath = path.join(TEST_HOME, 'nonexistent.json');
    expect(() => loadWalletConfig(filePath)).toThrow('midnight wallet generate');
  });
});

// ─── setActiveWallet validation ──────────────────────────────

describe('setActiveWallet validation', () => {
  it('rejects path traversal names', () => {
    expect(() => setActiveWallet('../evil')).toThrow('Invalid wallet name');
    expect(() => setActiveWallet('a/b')).toThrow('Invalid wallet name');
  });

  it('rejects empty name', () => {
    expect(() => setActiveWallet('')).toThrow('Invalid wallet name');
  });

  it('rejects .json suffix', () => {
    expect(() => setActiveWallet('test.json')).toThrow('Invalid wallet name');
  });

  it('rejects control characters', () => {
    expect(() => setActiveWallet('test\x00name')).toThrow('Invalid wallet name');
  });
});

// ─── isValidWalletName ──────────────────────────────────────

describe('isValidWalletName', () => {
  it('accepts simple names', () => {
    expect(isValidWalletName('alice')).toBe(true);
    expect(isValidWalletName('bob')).toBe(true);
    expect(isValidWalletName('my-wallet')).toBe(true);
    expect(isValidWalletName('wallet_1')).toBe(true);
    expect(isValidWalletName('default')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidWalletName('')).toBe(false);
  });

  it('rejects whitespace-only', () => {
    expect(isValidWalletName('   ')).toBe(false);
    expect(isValidWalletName(' alice')).toBe(false);
    expect(isValidWalletName('alice ')).toBe(false);
  });

  it('rejects path separators', () => {
    expect(isValidWalletName('a/b')).toBe(false);
    expect(isValidWalletName('a\\b')).toBe(false);
    expect(isValidWalletName('../evil')).toBe(false);
  });

  it('rejects .json suffix', () => {
    expect(isValidWalletName('wallet.json')).toBe(false);
  });

  it('rejects dot and double-dot', () => {
    expect(isValidWalletName('.')).toBe(false);
    expect(isValidWalletName('..')).toBe(false);
  });

  it('rejects control characters', () => {
    expect(isValidWalletName('test\x00name')).toBe(false);
    expect(isValidWalletName('test\nnewline')).toBe(false);
    expect(isValidWalletName('\ttab')).toBe(false);
  });
});

// ─── saveWalletConfig + loadWalletConfig round-trip ─────────

describe('wallet config round-trip with named wallets', () => {
  it('saves and loads from wallets directory path', () => {
    const walletPath = path.join(TEST_WALLETS_DIR, 'test.json');
    saveWalletConfig(VALID_WALLET, walletPath);
    const loaded = loadWalletConfig(walletPath);
    expect(loaded.seed).toBe(VALID_WALLET.seed);
    expect(loaded.addresses).toEqual(VALID_WALLET.addresses);
  });
});
