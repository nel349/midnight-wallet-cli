import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadWalletConfig, saveWalletConfig, type WalletConfig } from '../lib/wallet-config.ts';
import { DIR_MODE, FILE_MODE } from '../lib/constants.ts';
import { deriveAllAddresses, deriveAllShieldedAddresses } from '../lib/derive-address.ts';

const TEST_DIR = path.join(os.tmpdir(), `midnight-wallet-test-${process.pid}`);

const VALID_SEED = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const VALID_ADDRESSES = deriveAllAddresses(Buffer.from(VALID_SEED, 'hex'));

const VALID_CONFIG: WalletConfig = {
  seed: VALID_SEED,
  addresses: VALID_ADDRESSES,
  createdAt: '2025-01-01T00:00:00.000Z',
};

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('saveWalletConfig', () => {
  it('creates the file at the specified path', () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    const result = saveWalletConfig(VALID_CONFIG, filePath);
    expect(result).toBe(filePath);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('writes valid JSON with all fields', () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(VALID_CONFIG, filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed.seed).toBe(VALID_CONFIG.seed);
    expect(parsed.addresses).toEqual(VALID_CONFIG.addresses);
    expect(parsed.createdAt).toBe(VALID_CONFIG.createdAt);
  });

  it('creates parent directories if they do not exist', () => {
    const filePath = path.join(TEST_DIR, 'nested', 'deep', 'wallet.json');
    saveWalletConfig(VALID_CONFIG, filePath);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('includes optional mnemonic when present', () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    const withMnemonic = { ...VALID_CONFIG, mnemonic: 'abandon abandon abandon' };
    saveWalletConfig(withMnemonic, filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed.mnemonic).toBe('abandon abandon abandon');
  });

  it('sets restrictive file permissions (FILE_MODE)', () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(VALID_CONFIG, filePath);
    const stat = fs.statSync(filePath);
    // mode includes file type bits; mask to get permission bits only
    const permissions = stat.mode & 0o777;
    expect(permissions).toBe(FILE_MODE);
  });

  it('overwrites existing file completely', () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(VALID_CONFIG, filePath);

    const otherSeed = '1111111111111111111111111111111111111111111111111111111111111111';
    const otherAddresses = deriveAllAddresses(Buffer.from(otherSeed, 'hex'));
    const updated: WalletConfig = {
      seed: otherSeed,
      addresses: otherAddresses,
      createdAt: '2026-02-26T00:00:00.000Z',
    };
    saveWalletConfig(updated, filePath);

    const loaded = loadWalletConfig(filePath);
    expect(loaded.seed).toBe(updated.seed);
    expect(loaded.addresses).toEqual(updated.addresses);
    expect(loaded.createdAt).toBe(updated.createdAt);
    // Ensure old data is gone
    expect(loaded.seed).not.toBe(VALID_CONFIG.seed);
  });
});

describe('loadWalletConfig', () => {
  it('loads a previously saved config', () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(VALID_CONFIG, filePath);
    const loaded = loadWalletConfig(filePath);
    expect(loaded.seed).toBe(VALID_CONFIG.seed);
    expect(loaded.addresses).toEqual(VALID_CONFIG.addresses);
    expect(loaded.createdAt).toBe(VALID_CONFIG.createdAt);
  });

  it('throws when file does not exist', () => {
    const filePath = path.join(TEST_DIR, 'nonexistent.json');
    expect(() => loadWalletConfig(filePath)).toThrow('Wallet file not found');
  });

  it('includes actionable recovery guidance in missing file error', () => {
    const filePath = path.join(TEST_DIR, 'nonexistent.json');
    expect(() => loadWalletConfig(filePath)).toThrow('midnight wallet generate');
  });

  it('includes the file path in missing file error', () => {
    const filePath = path.join(TEST_DIR, 'nonexistent.json');
    expect(() => loadWalletConfig(filePath)).toThrow(filePath);
  });

  it('throws on invalid JSON', () => {
    const filePath = path.join(TEST_DIR, 'bad.json');
    fs.writeFileSync(filePath, 'not json at all');
    expect(() => loadWalletConfig(filePath)).toThrow('Invalid JSON');
  });

  it('throws when seed is missing', () => {
    const filePath = path.join(TEST_DIR, 'incomplete.json');
    fs.writeFileSync(filePath, JSON.stringify({
      addresses: VALID_ADDRESSES,
      createdAt: '2025-01-01T00:00:00.000Z',
    }));
    expect(() => loadWalletConfig(filePath)).toThrow('seed');
  });

  it('throws when address and addresses are both missing', () => {
    const filePath = path.join(TEST_DIR, 'incomplete.json');
    fs.writeFileSync(filePath, JSON.stringify({
      seed: VALID_SEED,
      createdAt: '2025-01-01T00:00:00.000Z',
    }));
    expect(() => loadWalletConfig(filePath)).toThrow('address');
  });

  it('throws when createdAt is missing', () => {
    const filePath = path.join(TEST_DIR, 'incomplete.json');
    fs.writeFileSync(filePath, JSON.stringify({
      seed: 'aabb00',
      addresses: VALID_ADDRESSES,
    }));
    expect(() => loadWalletConfig(filePath)).toThrow('createdAt');
  });

  it('throws on non-hex seed', () => {
    const filePath = path.join(TEST_DIR, 'badseed.json');
    fs.writeFileSync(filePath, JSON.stringify({
      seed: 'not-a-hex-string!',
      addresses: VALID_ADDRESSES,
      createdAt: '2025-01-01T00:00:00.000Z',
    }));
    expect(() => loadWalletConfig(filePath)).toThrow('Invalid seed format');
  });

  it('auto-migrates old format with address and network fields', () => {
    const filePath = path.join(TEST_DIR, 'old-format.json');
    fs.writeFileSync(filePath, JSON.stringify({
      seed: VALID_SEED,
      network: 'preprod',
      address: 'mn_addr_preprod1oldaddress',
      createdAt: '2025-01-01T00:00:00.000Z',
    }));
    const loaded = loadWalletConfig(filePath);
    // Should have derived all addresses from the seed
    expect(loaded.addresses).toEqual(VALID_ADDRESSES);
    expect((loaded as any).network).toBeUndefined();
    expect((loaded as any).address).toBeUndefined();
  });

  it('accepts config without optional mnemonic', () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(VALID_CONFIG, filePath);
    const loaded = loadWalletConfig(filePath);
    expect(loaded.mnemonic).toBeUndefined();
  });

  it('sets restrictive permissions on custom parent directories', () => {
    const filePath = path.join(TEST_DIR, 'secure', 'nested', 'wallet.json');
    saveWalletConfig(VALID_CONFIG, filePath);
    const dirStat = fs.statSync(path.join(TEST_DIR, 'secure'));
    const permissions = dirStat.mode & 0o777;
    expect(permissions).toBe(DIR_MODE);
  });
});

describe('round-trip', () => {
  it('save then load preserves all fields including mnemonic', () => {
    const filePath = path.join(TEST_DIR, 'roundtrip.json');
    const seed = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const addresses = deriveAllAddresses(Buffer.from(seed, 'hex'));
    const shieldedAddresses = deriveAllShieldedAddresses(Buffer.from(seed, 'hex'));
    const original: WalletConfig = {
      seed,
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      addresses,
      shieldedAddresses,
      createdAt: '2026-02-26T12:00:00.000Z',
    };
    saveWalletConfig(original, filePath);
    const loaded = loadWalletConfig(filePath);
    expect(loaded).toEqual(original);
  });

  it('save then load preserves config without mnemonic', () => {
    const filePath = path.join(TEST_DIR, 'roundtrip.json');
    const expected: WalletConfig = {
      ...VALID_CONFIG,
      shieldedAddresses: deriveAllShieldedAddresses(Buffer.from(VALID_CONFIG.seed, 'hex')),
    };
    saveWalletConfig(VALID_CONFIG, filePath);
    const loaded = loadWalletConfig(filePath);
    expect(loaded).toEqual(expected);
  });
});
