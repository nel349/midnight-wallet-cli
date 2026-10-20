import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadWalletConfig, matchWalletAddress, unlockWallet, writeSealedWallet, type WalletInfo } from '../lib/wallet-config.ts';
import { PASSPHRASE_ENV, establishPassphrase } from '../lib/passphrase.ts';
import { saveWalletConfig, type PlainWalletConfig as WalletConfig } from './helpers/plain-wallet.ts';
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

const PASSPHRASE = 'correct horse battery staple';
// Unlocking in the test's own home, a plain-text wallet's warning kept out of the output.
const UNLOCK = { home: TEST_DIR, source: { env: { [PASSPHRASE_ENV]: PASSPHRASE }, isTTY: false }, warn: () => {} };

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  establishPassphrase(TEST_DIR, PASSPHRASE);
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('writeSealedWallet', () => {
  const PUBLIC = { addresses: VALID_ADDRESSES, createdAt: VALID_CONFIG.createdAt };

  it('creates the file at the specified path, holding the addresses and no seed', () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    expect(writeSealedWallet(filePath, PUBLIC, { seed: VALID_SEED }, PASSPHRASE)).toBe(filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(parsed.addresses).toEqual(VALID_ADDRESSES);
    expect(parsed.createdAt).toBe(VALID_CONFIG.createdAt);
    expect(parsed.seed).toBeUndefined();
    expect(parsed.mnemonic).toBeUndefined();
  });

  it('creates missing parent directories owner-only, and the file owner-only', () => {
    const filePath = path.join(TEST_DIR, 'secure', 'nested', 'wallet.json');
    writeSealedWallet(filePath, PUBLIC, { seed: VALID_SEED }, PASSPHRASE);
    expect(fs.statSync(path.join(TEST_DIR, 'secure')).mode & 0o777).toBe(DIR_MODE);
    expect(fs.statSync(filePath).mode & 0o777).toBe(FILE_MODE);
  });

  it('replaces an existing wallet completely when told to (--force)', async () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    writeSealedWallet(filePath, PUBLIC, { seed: VALID_SEED, mnemonic: 'abandon abandon abandon' }, PASSPHRASE);
    const otherSeed = '1111111111111111111111111111111111111111111111111111111111111111';
    const otherAddresses = deriveAllAddresses(Buffer.from(otherSeed, 'hex'));
    writeSealedWallet(filePath, { addresses: otherAddresses, createdAt: '2026-02-26T00:00:00.000Z' }, { seed: otherSeed }, PASSPHRASE, { overwrite: true });
    const loaded = await unlockWallet(filePath, UNLOCK);
    expect(loaded.seed).toBe(otherSeed);
    expect(loaded.mnemonic).toBeUndefined();
    expect(loaded.addresses).toEqual(otherAddresses);
    expect(loaded.createdAt).toBe('2026-02-26T00:00:00.000Z');
  });
});

describe('loadWalletConfig', () => {
  it('loads a plain-text wallet an earlier mn wrote, without its secrets', () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(VALID_CONFIG, filePath);
    const loaded = loadWalletConfig(filePath);
    expect(loaded).not.toHaveProperty('seed');
    expect(loaded.isSealed).toBe(false);
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

  it('accepts config without optional mnemonic', async () => {
    const filePath = path.join(TEST_DIR, 'wallet.json');
    saveWalletConfig(VALID_CONFIG, filePath);
    expect((await unlockWallet(filePath, UNLOCK)).mnemonic).toBeUndefined();
  });
});

describe('round-trip', () => {
  it('a plain-text wallet unlocks to all it holds, mnemonic included', async () => {
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
    expect(await unlockWallet(filePath, UNLOCK)).toEqual({ ...original, isSealed: false });
  });

  it('a sealed wallet unlocks to all it was written with', async () => {
    const filePath = path.join(TEST_DIR, 'roundtrip.json');
    const shieldedAddresses = deriveAllShieldedAddresses(Buffer.from(VALID_SEED, 'hex'));
    writeSealedWallet(filePath, { addresses: VALID_ADDRESSES, shieldedAddresses, createdAt: VALID_CONFIG.createdAt }, { seed: VALID_SEED }, PASSPHRASE);
    expect(await unlockWallet(filePath, UNLOCK)).toEqual({ ...VALID_CONFIG, shieldedAddresses, isSealed: true });
  });
});

describe('matchWalletAddress', () => {
  const shieldedAddresses = deriveAllShieldedAddresses(Buffer.from(VALID_SEED, 'hex'));
  const SEED_2 = '1111111111111111111111111111111111111111111111111111111111111111';

  const alice: WalletInfo = {
    name: 'alice',
    addresses: VALID_ADDRESSES,
    shieldedAddresses,
    isActive: true,
    file: '/wallets/alice.json',
  };
  const bob: WalletInfo = {
    name: 'bob',
    addresses: deriveAllAddresses(Buffer.from(SEED_2, 'hex')),
    isActive: false,
    file: '/wallets/bob.json',
  };

  it('matches an unshielded address to its wallet and network', () => {
    const result = matchWalletAddress([alice, bob], VALID_ADDRESSES.undeployed);
    expect(result?.wallet.name).toBe('alice');
    expect(result?.network).toBe('undeployed');
  });

  it('matches a shielded address to its wallet and network', () => {
    const result = matchWalletAddress([alice, bob], shieldedAddresses.preprod);
    expect(result?.wallet.name).toBe('alice');
    expect(result?.network).toBe('preprod');
  });

  it('returns undefined for an address no wallet owns', () => {
    const stranger = deriveAllAddresses(Buffer.from(
      '0000000000000000000000000000000000000000000000000000000000000099', 'hex',
    )).undeployed;
    expect(matchWalletAddress([alice, bob], stranger)).toBeUndefined();
  });

  it('returns undefined against an empty wallet list', () => {
    expect(matchWalletAddress([], VALID_ADDRESSES.undeployed)).toBeUndefined();
  });
});
