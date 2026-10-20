// `midnight wallet protect` on an account an earlier mn made in plain text:
// its records, roster and owner key sealed under a data key of its own, its
// private state moved off the public password onto a password of its own,
// and nothing secret left in plain text. A run interrupted part way is
// finished by the next, and an account caught half way is refused, never
// opened under the wrong password. Nothing here reaches a chain: the private
// state is a real LevelDB store, written through the account package.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FeeWallet, accountProviders, ownerDeviceFromSecret } from '@kuiralabs/midnight-account-chain/owner';
import { PRIVATE_STATE_ID } from '@kuiralabs/midnight-account-chain/contract';
import { PASSPHRASE_ENV, establishPassphrase } from '../lib/passphrase.ts';
import { getNetworkConfig } from '../lib/network.ts';
import { LEGACY_STORE_PASSWORD, openGrantAccount, privateStateLocationOf } from '../lib/grant/account.ts';
import { AccountMigrationInterruptedError, protectAccount } from '../lib/grant/protect-account.ts';
import { isSealedAccount } from '../lib/grant/sealed-account.ts';

const PASSPHRASE = 'correct horse battery staple';
const ACCOUNT = '5e'.repeat(32);
const COIN_KEY = 'a9'.repeat(32);
const RECORD = { contractAddress: ACCOUNT, bootSalt: '3a'.repeat(32), encryptionSecret: '2b'.repeat(32) };
const DEVICE_SECRET = '4f'.repeat(32);
const ROSTER = { entries: [{ grantId: 'aa'.repeat(32), status: 'issued', slot: 0, readPk: 'bb'.repeat(32) }] };
const PRIVATE_STATE = { secretKey: '7c'.repeat(32) };
const NETWORK = getNetworkConfig('undeployed');

let home: string;
let dir: string;
const wallet = { getCoinPublicKey: () => COIN_KEY } as unknown as FeeWallet;

// The account package's providers over the account's private state, under `password`.
const privateStateUnder = async (password: string) => {
  const account = await openGrantAccount(NETWORK, dir, () => {}, { home, source: { env: { [PASSPHRASE_ENV]: PASSPHRASE }, isTTY: false }, warn: () => {} });
  const providers = accountProviders(account.context, wallet, privateStateLocationOf(dir, () => password));
  providers.privateStateProvider.setContractAddress(ACCOUNT);
  return providers.privateStateProvider;
};

// An account as mn 0.6.0-rc.10 left it: plain records and roster, its private state under the public password.
const writePlainAccount = async (): Promise<void> => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ ...RECORD, deviceArm: 'k1', deviceSk: DEVICE_SECRET }));
  fs.writeFileSync(path.join(dir, 'roster.json'), JSON.stringify(ROSTER));
  await (await privateStateUnder(LEGACY_STORE_PASSWORD)).set(PRIVATE_STATE_ID, PRIVATE_STATE as never);
};

const plainTextLeft = (): string[] =>
  fs.readdirSync(dir).filter((f) => f.endsWith('.json')).filter((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    return text.includes(DEVICE_SECRET) || text.includes(RECORD.encryptionSecret) || text.includes('bb'.repeat(32));
  });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-protect-account-'));
  dir = path.join(home, '.midnight', 'accounts', 'undeployed', 'alice');
  establishPassphrase(home, PASSPHRASE);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('protecting an account an earlier mn made in plain text', () => {
  it('seals its records, roster and owner key, and leaves nothing secret in plain text', async () => {
    await writePlainAccount();
    expect(await protectAccount(dir, PASSPHRASE, COIN_KEY)).toBe('sealed-now');
    expect(isSealedAccount(dir)).toBe(true);
    expect(plainTextLeft()).toEqual([]);
    const account = await openGrantAccount(NETWORK, dir, () => {}, { home, source: { env: { [PASSPHRASE_ENV]: PASSPHRASE }, isTTY: false } });
    expect(account.protection).toBe('sealed');
    expect(account.store.readOwner()).toEqual(RECORD);
    expect(account.store.readRoster()).toEqual(ROSTER);
    expect(account.keys.read()?.pk).toEqual(ownerDeviceFromSecret('k1', DEVICE_SECRET).pk);
  });

  it('moves its private state onto a password of its own, off the public one', async () => {
    await writePlainAccount();
    await protectAccount(dir, PASSPHRASE, COIN_KEY);
    const account = await openGrantAccount(NETWORK, dir, () => {}, { home, source: { env: { [PASSPHRASE_ENV]: PASSPHRASE }, isTTY: false } });
    const own = await account.location.password();
    expect(own).not.toBe(LEGACY_STORE_PASSWORD);
    expect(await (await privateStateUnder(own)).get(PRIVATE_STATE_ID)).toEqual(PRIVATE_STATE);
    await expect((await privateStateUnder(LEGACY_STORE_PASSWORD)).get(PRIVATE_STATE_ID)).rejects.toThrow();
  });

  it('is left as it is once sealed', async () => {
    await writePlainAccount();
    await protectAccount(dir, PASSPHRASE, COIN_KEY);
    expect(await protectAccount(dir, PASSPHRASE, COIN_KEY)).toBe('already-sealed');
  });

  it('has nothing to protect where there is no account', async () => {
    fs.mkdirSync(dir, { recursive: true });
    expect(await protectAccount(dir, PASSPHRASE, COIN_KEY)).toBe('nothing');
  });

  it('is refused while caught half way, and finished by the next run', async () => {
    await writePlainAccount();
    // A run that stopped after moving the private state, before the account was sealed.
    await protectAccount(dir, PASSPHRASE, COIN_KEY, { stopBeforeSealing: true });
    expect(isSealedAccount(dir)).toBe(false);
    await expect(openGrantAccount(NETWORK, dir, () => {}, { home, warn: () => {} })).rejects.toThrow(AccountMigrationInterruptedError);
    expect(await protectAccount(dir, PASSPHRASE, COIN_KEY)).toBe('sealed-now');
    const account = await openGrantAccount(NETWORK, dir, () => {}, { home, source: { env: { [PASSPHRASE_ENV]: PASSPHRASE }, isTTY: false } });
    expect(await (await privateStateUnder(await account.location.password())).get(PRIVATE_STATE_ID)).toEqual(PRIVATE_STATE);
    expect(plainTextLeft()).toEqual([]);
  });

  it('seals the records of a deploy that never landed, kept aside in plain text', async () => {
    await writePlainAccount();
    fs.writeFileSync(path.join(dir, 'owner.unlanded-1790000000000.json'), JSON.stringify({ ...RECORD, deviceArm: 'k1', deviceSk: DEVICE_SECRET }));
    await protectAccount(dir, PASSPHRASE, COIN_KEY);
    expect(plainTextLeft()).toEqual([]);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('owner.unlanded-1790000000000') && f.endsWith('.sealed.json'))).toBe(true);
  });
});
