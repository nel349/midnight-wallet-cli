// An account's encrypted backup: everything another machine needs to act as
// the same owner (the records, the roster, the owner key, and the private
// state with its password) sealed under mn's passphrase in one file, which
// holds nothing in the clear but the network and the address. Imported for a
// wallet with no account, the account opens there as it did here; it is never
// imported over an account, nor for another network, nor without the
// passphrase it was made with.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FeeWallet, accountProviders, freshOwnerDevice } from '@kuiralabs/midnight-account-chain/owner';
import { PRIVATE_STATE_ID } from '@kuiralabs/midnight-account-chain/contract';
import { WrongPassphraseError } from '../lib/keystore.ts';
import { PASSPHRASE_ENV, establishPassphrase } from '../lib/passphrase.ts';
import { getNetworkConfig } from '../lib/network.ts';
import { openGrantAccount, privateStateLocationOf } from '../lib/grant/account.ts';
import { exportAccount, importAccount } from '../lib/grant/account-backup.ts';
import { createPendingDevice, sealedDeviceList } from '../lib/grant/sealed-account.ts';
import { deviceCodeOf } from '../lib/grant/device-code.ts';
import { openAccountKey } from '../lib/grant/sealed-account.ts';
import { createAccountKey, sealedDeviceKeys, sealedOwnerStore, sealedPrivateStatePassword } from '../lib/grant/sealed-account.ts';

const PASSPHRASE = 'correct horse battery staple';
const ACCOUNT = '5e'.repeat(32);
const RECORD = { contractAddress: ACCOUNT, bootSalt: '3a'.repeat(32), encryptionSecret: '2b'.repeat(32) };
const ROSTER = { entries: [{ grantId: 'aa'.repeat(32), status: 'issued' as const, slot: 0, readPk: 'bb'.repeat(32) }] };
const PRIVATE_STATE = { coins: { [ '7c'.repeat(32) ]: { value: '250000' } } };
const NETWORK = getNetworkConfig('undeployed');
const wallet = { getCoinPublicKey: () => 'a9'.repeat(32) } as unknown as FeeWallet;

let root: string;
let here: string;
let there: string;
let fromDir: string;
let toDir: string;
let backup: string;
const source = (passphrase = PASSPHRASE) => ({ env: { [PASSPHRASE_ENV]: passphrase }, isTTY: false });
const accountsOf = (home: string) => path.join(home, '.midnight', 'accounts', 'undeployed', 'alice');

const privateStateIn = async (home: string, dir: string) => {
  const account = await openGrantAccount(NETWORK, dir, () => {}, { home, source: source() });
  const providers = accountProviders(account.context, wallet, privateStateLocationOf(dir, () => account.location.password() as string));
  providers.privateStateProvider.setContractAddress(ACCOUNT);
  return { account, privateState: providers.privateStateProvider };
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-account-backup-'));
  here = path.join(root, 'here');
  there = path.join(root, 'there');
  fromDir = accountsOf(here);
  toDir = accountsOf(there);
  backup = path.join(root, 'alice.backup.json');
  establishPassphrase(here, PASSPHRASE);
  fs.mkdirSync(fromDir, { recursive: true });
  const key = createAccountKey(fromDir, PASSPHRASE);
  const store = sealedOwnerStore(fromDir, key);
  store.writeOwner(RECORD);
  store.writeRoster(ROSTER);
  sealedDeviceKeys(fromDir, key).keep(freshOwnerDevice('k1'));
  sealedPrivateStatePassword(fromDir, key);
  await (await privateStateIn(here, fromDir)).privateState.set(PRIVATE_STATE_ID, PRIVATE_STATE as never);
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("an account's backup", () => {
  it('holds nothing in the clear but the network and the address', async () => {
    await exportAccount(fromDir, 'undeployed', PASSPHRASE, backup);
    const text = fs.readFileSync(backup, 'utf8');
    expect(JSON.parse(text)).toMatchObject({ network: 'undeployed', contractAddress: ACCOUNT });
    for (const secret of [RECORD.encryptionSecret, RECORD.bootSalt, 'bb'.repeat(32)]) expect(text).not.toContain(secret);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
  });

  it('is never written over a file that exists', async () => {
    fs.writeFileSync(backup, 'something');
    await expect(exportAccount(fromDir, 'undeployed', PASSPHRASE, backup)).rejects.toThrow(/already exists/);
  });

  it('imports for a wallet with no account, which then acts as the same owner, its private state with it', async () => {
    await exportAccount(fromDir, 'undeployed', PASSPHRASE, backup);
    establishPassphrase(there, PASSPHRASE);
    expect(await importAccount(toDir, 'undeployed', PASSPHRASE, backup)).toEqual({ contractAddress: ACCOUNT });
    const { account, privateState } = await privateStateIn(there, toDir);
    const original = await openGrantAccount(NETWORK, fromDir, () => {}, { home: here, source: source() });
    expect(account.store.readOwner()).toEqual(RECORD);
    expect(account.store.readRoster()).toEqual(ROSTER);
    expect(account.keys.read()?.pk).toEqual(original.keys.read()?.pk);
    expect(await privateState.get(PRIVATE_STATE_ID)).toEqual(PRIVATE_STATE);
  });

  it('is never imported over an account, nor for another network', async () => {
    await exportAccount(fromDir, 'undeployed', PASSPHRASE, backup);
    await expect(importAccount(fromDir, 'undeployed', PASSPHRASE, backup)).rejects.toThrow(/already has an account/);
    await expect(importAccount(toDir, 'preview', PASSPHRASE, backup)).rejects.toThrow(/undeployed/);
  });

  it('opens only with the passphrase it was made with', async () => {
    await exportAccount(fromDir, 'undeployed', PASSPHRASE, backup);
    await expect(importAccount(toDir, 'undeployed', 'not the passphrase it was made with', backup)).rejects.toThrow(WrongPassphraseError);
    expect(fs.existsSync(toDir)).toBe(false);
  });
});

describe("a backup made for another device", () => {
  it('leaves out this machine\'s owner key, and gives the device it was made for the records', async () => {
    establishPassphrase(there, PASSPHRASE);
    fs.mkdirSync(toDir, { recursive: true });
    const pending = createPendingDevice(toDir, PASSPHRASE);
    expect(pending.arm).toBe('v1');
    await exportAccount(fromDir, 'undeployed', PASSPHRASE, backup, { forDevice: { arm: pending.arm, pk: pending.pk } });
    await importAccount(toDir, 'undeployed', PASSPHRASE, backup);
    const { account, privateState } = await privateStateIn(there, toDir);
    const original = await openGrantAccount(NETWORK, fromDir, () => {}, { home: here, source: source() });
    expect(account.store.readOwner()).toEqual(RECORD);
    expect(account.keys.read()?.pk).toEqual(pending.pk);
    expect(account.keys.read()?.pk).not.toEqual(original.keys.read()?.pk);
    expect(await privateState.get(PRIVATE_STATE_ID)).toEqual(PRIVATE_STATE);
    const devices = sealedDeviceList(toDir, openAccountKey(toDir, PASSPHRASE)).read();
    expect(devices).toContain(deviceCodeOf(pending));
    expect(devices).toContain(deviceCodeOf(original.keys.read()!));
  });

  it('is refused on a machine without the device it was made for', async () => {
    establishPassphrase(there, PASSPHRASE);
    fs.mkdirSync(toDir, { recursive: true });
    createPendingDevice(toDir, PASSPHRASE);
    const other = path.join(root, 'other');
    const otherDir = accountsOf(other);
    establishPassphrase(other, PASSPHRASE);
    fs.mkdirSync(otherDir, { recursive: true });
    const stranger = createPendingDevice(otherDir, PASSPHRASE);
    await exportAccount(fromDir, 'undeployed', PASSPHRASE, backup, { forDevice: { arm: stranger.arm, pk: stranger.pk } });
    await expect(importAccount(toDir, 'undeployed', PASSPHRASE, backup)).rejects.toThrow(/made for another device/);
    const empty = accountsOf(path.join(root, 'empty'));
    await expect(importAccount(empty, 'undeployed', PASSPHRASE, backup)).rejects.toThrow(/device new/);
  });

  it('keeps the pending device when made again: one key per machine', () => {
    establishPassphrase(there, PASSPHRASE);
    fs.mkdirSync(toDir, { recursive: true });
    expect(createPendingDevice(toDir, PASSPHRASE).pk).toEqual(createPendingDevice(toDir, PASSPHRASE).pk);
  });
});

