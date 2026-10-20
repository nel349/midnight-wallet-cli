// How `mn grant` opens an account's records: a sealed account with mn's
// passphrase, its private state under its own password; an account an earlier
// mn wrote in plain text still, with a warning and the password it was made
// with, until `midnight wallet protect`; and for a first deploy, a new account
// sealed from the start. Nothing here reaches a chain.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WrongPassphraseError } from '../lib/keystore.ts';
import { PASSPHRASE_ENV, establishPassphrase } from '../lib/passphrase.ts';
import { getNetworkConfig } from '../lib/network.ts';
import { openGrantAccount } from '../lib/grant/account.ts';
import { createAccountKey, isSealedAccount, sealedOwnerStore } from '../lib/grant/sealed-account.ts';

const PASSPHRASE = 'correct horse battery staple';
const RECORD = { contractAddress: '5e'.repeat(32), bootSalt: '3a'.repeat(32), encryptionSecret: '2b'.repeat(32) };
const NETWORK = getNetworkConfig('undeployed');

let home: string;
let dir: string;
const open = (passphrase = PASSPHRASE, warn: (line: string) => void = () => {}) =>
  openGrantAccount(NETWORK, dir, () => {}, { home, source: { env: { [PASSPHRASE_ENV]: passphrase }, isTTY: false }, warn });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-grant-account-'));
  dir = path.join(home, '.midnight', 'accounts', 'undeployed', 'alice');
  fs.mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('opening an account', () => {
  it('opens a sealed account with the passphrase, its private state under a password of its own', async () => {
    establishPassphrase(home, PASSPHRASE);
    sealedOwnerStore(dir, createAccountKey(dir, PASSPHRASE)).writeOwner(RECORD);
    const account = await open();
    expect(account.protection).toBe('sealed');
    expect(account.store.readOwner()).toEqual(RECORD);
    const password = await account.location.password();
    expect(password).not.toMatch(/Ultimate Question/);
    expect(await (await open()).location.password()).toBe(password);
  });

  it('refuses a sealed account with another passphrase', async () => {
    establishPassphrase(home, PASSPHRASE);
    createAccountKey(dir, PASSPHRASE);
    await expect(open('not the passphrase at all')).rejects.toThrow(WrongPassphraseError);
  });

  it('opens an account an earlier mn wrote in plain text, saying it is not protected', async () => {
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ ...RECORD, deviceArm: 'k1', deviceSk: '4f'.repeat(32) }));
    const warnings: string[] = [];
    const account = await open(PASSPHRASE, (line) => warnings.push(line));
    expect(account.protection).toBe('plain-text');
    expect(account.store.readOwner()).toEqual(RECORD);
    expect(account.keys.read()?.arm).toBe('k1');
    expect(warnings.join('\n')).toMatch(/not protected[\s\S]*midnight wallet protect/);
  });

  it('makes a new account sealed from the start, setting the passphrase on a machine with none', async () => {
    const account = await open();
    expect(account.protection).toBe('sealed');
    expect(isSealedAccount(dir)).toBe(true);
    expect(account.keys.read()).toBeUndefined();
  });
});
