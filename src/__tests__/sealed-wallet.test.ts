// A wallet file as mn writes it: its addresses readable by anyone, its seed
// and mnemonic sealed under mn's passphrase. Nothing secret is in the file in
// the clear; what is sealed opens only with the passphrase; a wallet an
// earlier mn wrote in plain text still works, with a warning, until it is
// sealed in place, keeping everything it held.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WrongPassphraseError } from '../lib/keystore.ts';
import { PASSPHRASE_ENV, establishPassphrase } from '../lib/passphrase.ts';
import { loadWalletConfig, sealWalletInPlace, unlockWallet, writeSealedWallet } from '../lib/wallet-config.ts';
import { deriveAllAddresses, deriveAllShieldedAddresses } from '../lib/derive-address.ts';
import { FILE_MODE } from '../lib/constants.ts';

const SEED = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSPHRASE = 'correct horse battery staple';
const PUBLIC = {
  addresses: deriveAllAddresses(Buffer.from(SEED, 'hex')),
  shieldedAddresses: deriveAllShieldedAddresses(Buffer.from(SEED, 'hex')),
  createdAt: '2026-10-19T00:00:00.000Z',
};

let home: string;
let file: string;
const withPassphrase = (passphrase: string) => ({ home, source: { env: { [PASSPHRASE_ENV]: passphrase }, isTTY: false } });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-sealed-wallet-'));
  file = path.join(home, '.midnight', 'wallets', 'alice.json');
  establishPassphrase(home, PASSPHRASE);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a sealed wallet', () => {
  it('holds no secret in the clear, owner-only', () => {
    writeSealedWallet(file, PUBLIC, { seed: SEED, mnemonic: MNEMONIC }, PASSPHRASE);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(SEED);
    expect(text).not.toContain('abandon');
    expect(fs.statSync(file).mode & 0o777).toBe(FILE_MODE);
  });

  it('shows its addresses without the passphrase', () => {
    writeSealedWallet(file, PUBLIC, { seed: SEED }, PASSPHRASE);
    const config = loadWalletConfig(file);
    expect(config.addresses).toEqual(PUBLIC.addresses);
    expect(config.shieldedAddresses).toEqual(PUBLIC.shieldedAddresses);
    expect(config.isSealed).toBe(true);
    expect(config).not.toHaveProperty('seed');
  });

  it('opens its seed and mnemonic with the passphrase', async () => {
    writeSealedWallet(file, PUBLIC, { seed: SEED, mnemonic: MNEMONIC }, PASSPHRASE);
    const wallet = await unlockWallet(file, withPassphrase(PASSPHRASE));
    expect(wallet.seed).toBe(SEED);
    expect(wallet.mnemonic).toBe(MNEMONIC);
  });

  it('is refused with another passphrase', async () => {
    writeSealedWallet(file, PUBLIC, { seed: SEED }, PASSPHRASE);
    await expect(unlockWallet(file, withPassphrase('not the passphrase'))).rejects.toThrow(WrongPassphraseError);
  });

  it('is never written over an existing wallet', () => {
    writeSealedWallet(file, PUBLIC, { seed: SEED }, PASSPHRASE);
    expect(() => writeSealedWallet(file, PUBLIC, { seed: SEED }, PASSPHRASE)).toThrow(/already exists/);
  });
});

describe('a wallet an earlier mn wrote in plain text', () => {
  const writePlain = (): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ seed: SEED, mnemonic: MNEMONIC, ...PUBLIC }, null, 2), { mode: FILE_MODE });
  };

  it('still opens, saying it is not protected', async () => {
    writePlain();
    const warnings: string[] = [];
    const wallet = await unlockWallet(file, { home, warn: (line) => warnings.push(line) });
    expect(wallet.seed).toBe(SEED);
    expect(loadWalletConfig(file).isSealed).toBe(false);
    expect(warnings.join('\n')).toMatch(/not protected[\s\S]*midnight wallet protect/);
  });

  it('is sealed in place, keeping its seed, mnemonic and addresses, with nothing left in the clear', async () => {
    writePlain();
    sealWalletInPlace(file, PASSPHRASE);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(SEED);
    expect(text).not.toContain('abandon');
    expect(loadWalletConfig(file)).toMatchObject({ ...PUBLIC, isSealed: true });
    const wallet = await unlockWallet(file, withPassphrase(PASSPHRASE));
    expect(wallet.seed).toBe(SEED);
    expect(wallet.mnemonic).toBe(MNEMONIC);
  });

  it('is left as it was when it is already sealed', () => {
    writeSealedWallet(file, PUBLIC, { seed: SEED }, PASSPHRASE);
    const before = fs.readFileSync(file, 'utf8');
    sealWalletInPlace(file, PASSPHRASE);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});
