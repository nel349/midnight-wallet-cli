import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadWalletConfig, saveWalletConfig, type WalletConfig } from '../lib/wallet-config.ts';

const TEST_DIR = path.join(os.tmpdir(), `midnight-wallet-test-${process.pid}`);

const VALID_CONFIG: WalletConfig = {
  seed: 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233',
  network: 'preprod',
  address: 'mn_addr_preprod1qqqqqqtest',
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
    expect(parsed.network).toBe(VALID_CONFIG.network);
    expect(parsed.address).toBe(VALID_CONFIG.address);
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

  it('sets restrictive file permissions (0o600)', () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(VALID_CONFIG, filePath);
    const stat = fs.statSync(filePath);
    // mode includes file type bits; mask to get permission bits only
    const permissions = stat.mode & 0o777;
    expect(permissions).toBe(0o600);
  });

  it('overwrites existing file completely', () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(VALID_CONFIG, filePath);

    const updated: WalletConfig = {
      seed: '1111111111111111111111111111111111111111111111111111111111111111',
      network: 'preview',
      address: 'mn_addr_preview1newaddress',
      createdAt: '2026-02-26T00:00:00.000Z',
    };
    saveWalletConfig(updated, filePath);

    const loaded = loadWalletConfig(filePath);
    expect(loaded.seed).toBe(updated.seed);
    expect(loaded.network).toBe(updated.network);
    expect(loaded.address).toBe(updated.address);
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
    expect(loaded.network).toBe(VALID_CONFIG.network);
    expect(loaded.address).toBe(VALID_CONFIG.address);
    expect(loaded.createdAt).toBe(VALID_CONFIG.createdAt);
  });

  it('throws when file does not exist', () => {
    const filePath = path.join(TEST_DIR, 'nonexistent.json');
    expect(() => loadWalletConfig(filePath)).toThrow('Wallet file not found');
  });

  it('includes actionable recovery guidance in missing file error', () => {
    const filePath = path.join(TEST_DIR, 'nonexistent.json');
    expect(() => loadWalletConfig(filePath)).toThrow('wallet generate');
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
      network: 'preprod',
      address: 'mn_addr_preprod1test',
      createdAt: '2025-01-01T00:00:00.000Z',
    }));
    expect(() => loadWalletConfig(filePath)).toThrow('missing required fields');
  });

  it('throws when network is missing', () => {
    const filePath = path.join(TEST_DIR, 'incomplete.json');
    fs.writeFileSync(filePath, JSON.stringify({
      seed: 'aabb',
      address: 'mn_addr_preprod1test',
      createdAt: '2025-01-01T00:00:00.000Z',
    }));
    expect(() => loadWalletConfig(filePath)).toThrow('missing required fields');
  });

  it('throws when address is missing', () => {
    const filePath = path.join(TEST_DIR, 'incomplete.json');
    fs.writeFileSync(filePath, JSON.stringify({
      seed: 'aabb',
      network: 'preprod',
      createdAt: '2025-01-01T00:00:00.000Z',
    }));
    expect(() => loadWalletConfig(filePath)).toThrow('missing required fields');
  });

  it('accepts config without optional mnemonic', () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(VALID_CONFIG, filePath);
    const loaded = loadWalletConfig(filePath);
    expect(loaded.mnemonic).toBeUndefined();
  });
});

describe('round-trip', () => {
  it('save then load preserves all fields including mnemonic', () => {
    const filePath = path.join(TEST_DIR, 'roundtrip.json');
    const original: WalletConfig = {
      seed: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      network: 'undeployed',
      address: 'mn_addr_undeployed1qqqqqqtest',
      createdAt: '2026-02-26T12:00:00.000Z',
    };
    saveWalletConfig(original, filePath);
    const loaded = loadWalletConfig(filePath);
    expect(loaded).toEqual(original);
  });

  it('save then load preserves config without mnemonic', () => {
    const filePath = path.join(TEST_DIR, 'roundtrip.json');
    saveWalletConfig(VALID_CONFIG, filePath);
    const loaded = loadWalletConfig(filePath);
    expect(loaded).toEqual(VALID_CONFIG);
  });
});
