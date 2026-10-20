// An account's records as mn keeps them: under a data key of the account's
// own, itself sealed under mn's passphrase. Its address reads without the
// passphrase; its records, roster, owner key and private state's password
// never sit in the clear; its owner key is a valid key made on this machine,
// kept once; a deploy that never landed moves aside with its key. The owner
// store passes the account package's own conformance suite, run under
// node:test as that suite is written.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshOwnerDevice } from '@kuiralabs/midnight-account-chain/owner';
import { validatePassword } from '@midnight-ntwrk/midnight-js-utils';
import { WrongPassphraseError } from '../lib/keystore.ts';
import {
  contractAddressOnRecord,
  createAccountKey,
  isSealedAccount,
  openAccountKey,
  sealedDeviceKeys,
  sealedOwnerStore,
  sealedPrivateStatePassword,
} from '../lib/grant/sealed-account.ts';

const PASSPHRASE = 'correct horse battery staple';
const RECORD = { contractAddress: 'ab'.repeat(32), bootSalt: 'ef'.repeat(32), encryptionSecret: '12'.repeat(32) };
const CONFORMANCE = fileURLToPath(new URL('./sealed-account.conformance.ts', import.meta.url));

let dir: string;
const filesText = (): string => fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-sealed-account-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('an account sealed under its data key', () => {
  it('is known to be sealed once its key exists, and the key opens only with the passphrase', () => {
    expect(isSealedAccount(dir)).toBe(false);
    const key = createAccountKey(dir, PASSPHRASE);
    expect(isSealedAccount(dir)).toBe(true);
    expect(openAccountKey(dir, PASSPHRASE)).toEqual(key);
    expect(() => openAccountKey(dir, 'not the passphrase')).toThrow(WrongPassphraseError);
  });

  it('never makes a second key over the first', () => {
    createAccountKey(dir, PASSPHRASE);
    expect(() => createAccountKey(dir, PASSPHRASE)).toThrow(/already/);
  });

  it('keeps its records and roster out of the clear, its address readable without the passphrase', () => {
    const key = createAccountKey(dir, PASSPHRASE);
    const store = sealedOwnerStore(dir, key);
    store.writeOwner(RECORD);
    store.writeRoster({ entries: [{ grantId: 'aa'.repeat(32), status: 'issued', slot: 1, readPk: 'bb'.repeat(32) }] });
    const text = filesText();
    expect(text).not.toContain(RECORD.encryptionSecret);
    expect(text).not.toContain(RECORD.bootSalt);
    expect(text).not.toContain('bb'.repeat(32));
    expect(contractAddressOnRecord(dir)).toBe(RECORD.contractAddress);
  });

  it('keeps its files owner-only', () => {
    const key = createAccountKey(dir, PASSPHRASE);
    sealedOwnerStore(dir, key).writeOwner(RECORD);
    for (const file of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, file)).mode & 0o777, file).toBe(0o600);
  });
});

describe("the account's owner key", () => {
  it('is kept sealed, once, and read back as the same device', () => {
    const key = createAccountKey(dir, PASSPHRASE);
    const keys = sealedDeviceKeys(dir, key);
    expect(keys.read()).toBeUndefined();
    const device = keys.keep(freshOwnerDevice('k1'));
    expect(filesText()).not.toContain(device.secretText());
    const again = keys.read();
    expect(again?.arm).toBe('k1');
    expect(again?.pk).toEqual(device.pk);
    expect(() => keys.keep(freshOwnerDevice('k1'))).toThrow(/already/);
  });

  it('moves aside with records of a deploy that never landed', () => {
    const key = createAccountKey(dir, PASSPHRASE);
    const store = sealedOwnerStore(dir, key);
    const keys = sealedDeviceKeys(dir, key);
    keys.keep(freshOwnerDevice('k1'));
    store.writeOwner(RECORD);
    store.setAsideOwner();
    expect(store.readOwner()).toBeUndefined();
    expect(keys.read()).toBeUndefined();
    expect(contractAddressOnRecord(dir)).toBeUndefined();
  });
});

describe("the account's private-state password", () => {
  it('is made once, meets midnight-js\'s policy, is sealed, and reads back the same', () => {
    const key = createAccountKey(dir, PASSPHRASE);
    const password = sealedPrivateStatePassword(dir, key);
    expect(() => validatePassword(password)).not.toThrow();
    expect(filesText()).not.toContain(password);
    expect(sealedPrivateStatePassword(dir, key)).toBe(password);
  });
});

describe('the sealed owner store', () => {
  it("passes the account package's owner store conformance suite", () => {
    const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', CONFORMANCE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(output).toMatch(/# fail 0/);
    expect(output).toMatch(/# pass [1-9]/);
  }, 60_000);
});
