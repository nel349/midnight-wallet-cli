// An account's records as mn keeps them, sealed: every secret in the records
// directory is under a data key of the account's own, and that key is sealed
// under mn's passphrase. The passphrase's key derivation is paid once, to open
// the data key; the account package reads and writes the records as often as
// its protocols need, each through AES-256-GCM under that key.
//
//   account-key.json             the data key, sealed under the passphrase
//   owner.sealed.json            the address in clear (it is public on chain),
//                                the records (encryption secrets, boot salt,
//                                pending changes) sealed
//   roster.sealed.json           the roster of grants, sealed
//   owner-device.sealed.json     the owner key's arm in clear, its secret sealed
//   private-state.sealed.json    the private state's password, sealed
//
// The owner store and the device keys keep the account package's contract for
// them: the records replaced whole, the roster apart from them, a device kept
// once and never replaced, and the records of a deploy that never landed
// moved aside with their device.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Arm, x25519KeyPair, x25519PublicOf } from '@kuiralabs/midnight-account';
import {
  type LocalOwnerDevice,
  type OwnerRecord,
  type OwnerStore,
  type Roster,
  freshOwnerDevice,
  ownerDeviceFromSecret,
} from '@kuiralabs/midnight-account-chain/owner';
import { validatePassword } from '@midnight-ntwrk/midnight-js-utils';
import { FILE_MODE } from '../constants.ts';
import { deviceCodeOf, joinCodeOf } from './device-code.ts';
import { UsageError } from '../errors.ts';
import { FileExistsError, readJsonIfPresent, writeJsonDurably } from '../durable-file.ts';
import { type KeyedSecret, freshDataKey, openSecret, openWithKey, sealSecret, sealWithKey } from '../keystore.ts';

const ACCOUNT_KEY_FILE = 'account-key.json';
// The data key while a plain-text account is being sealed: the account is
// sealed only once this is renamed to ACCOUNT_KEY_FILE.
const MIGRATING_KEY_FILE = 'account-key.migrating.json';
const OWNER_FILE = 'owner.sealed.json';
const ROSTER_FILE = 'roster.sealed.json';
const DEVICE_FILE = 'owner-device.sealed.json';
// The owner device's read key, where another device seals the account's secret to it after a rotation.
const DEVICE_READ_FILE = 'owner-device-read.sealed.json';
const PRIVATE_STATE_FILE = 'private-state.sealed.json';
// The devices on the account this machine knows of, by their codes.
const DEVICES_FILE = 'devices.sealed.json';
const ASIDE_PREFIX = 'set-aside-';

const EMPTY_ROSTER: Roster = { entries: [] };

type OwnerFile = { readonly contractAddress: string; readonly record: KeyedSecret };
type DeviceFile = { readonly arm: Arm; readonly secret: KeyedSecret };

const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), 'utf8');
const parsed = <T>(bytes: Buffer): T => JSON.parse(bytes.toString('utf8')) as T;

/** True once the account in `dir` keeps its records sealed. */
export function isSealedAccount(dir: string): boolean {
  return fs.existsSync(path.join(dir, ACCOUNT_KEY_FILE));
}

/** Makes the account's data key and seals it under `passphrase`. Never over a key that exists. */
export function createAccountKey(dir: string, passphrase: string): Buffer {
  const key = freshDataKey();
  try {
    writeJsonDurably(path.join(dir, ACCOUNT_KEY_FILE), { sealed: sealSecret(key, passphrase, 'account-key') }, { exclusive: true });
  } catch (error) {
    if (error instanceof FileExistsError) throw new Error(`The account in ${dir} already has its data key.`);
    throw error;
  }
  return key;
}

/** A plain-text account is being sealed, and the run doing it stopped part way. */
export class AccountMigrationInterruptedError extends UsageError {
  constructor(dir: string) {
    super(`Protecting the account in ${dir} was interrupted part way. Finish it with: midnight wallet protect`);
    this.name = 'AccountMigrationInterruptedError';
    Object.setPrototypeOf(this, AccountMigrationInterruptedError.prototype);
  }
}

/** True while a plain-text account in `dir` is part way through being sealed. */
export function isAccountMigrating(dir: string): boolean {
  return fs.existsSync(path.join(dir, MIGRATING_KEY_FILE));
}

/** The data key a plain-text account is being sealed under: the one an interrupted run made, or a new one. */
export function migratingAccountKey(dir: string, passphrase: string): Buffer {
  const file = path.join(dir, MIGRATING_KEY_FILE);
  const kept = readJsonIfPresent<{ sealed: unknown }>(file);
  if (kept !== undefined) return openSecret(kept.sealed, passphrase, 'account-key');
  const key = freshDataKey();
  writeJsonDurably(file, { sealed: sealSecret(key, passphrase, 'account-key') }, { exclusive: true });
  return key;
}

/** Makes the migrating data key the account's: from here the account is sealed. */
export function completeAccountKey(dir: string): void {
  fs.renameSync(path.join(dir, MIGRATING_KEY_FILE), path.join(dir, ACCOUNT_KEY_FILE));
  const dirFd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

/** Seals a plain-text file of the account's whole, as `<name>.sealed.json` beside it, and removes the plain one. */
export function sealPlainFile(dir: string, file: string, key: Uint8Array): string {
  const sealedFile = file.replace(/\.json$/, '.sealed.json');
  writeJsonDurably(path.join(dir, sealedFile), { record: sealWithKey(key, fs.readFileSync(path.join(dir, file)), 'owner-record') });
  fs.rmSync(path.join(dir, file));
  return sealedFile;
}

/** The account's data key, opened with `passphrase`. */
export function openAccountKey(dir: string, passphrase: string): Buffer {
  const file = readJsonIfPresent<{ sealed: unknown }>(path.join(dir, ACCOUNT_KEY_FILE));
  if (file === undefined) throw new Error(`The account in ${dir} has no data key.`);
  return openSecret(file.sealed, passphrase, 'account-key');
}

/** The account's address, which needs no passphrase: it is public on chain. */
export function contractAddressOnRecord(dir: string): string | undefined {
  return readJsonIfPresent<OwnerFile>(path.join(dir, OWNER_FILE))?.contractAddress;
}

/** The account's owner store, its records and roster sealed under `key`. */
export function sealedOwnerStore(dir: string, key: Uint8Array, { clock = (): Date => new Date() }: { clock?: () => Date } = {}): OwnerStore {
  const ownerFile = path.join(dir, OWNER_FILE);
  const rosterFile = path.join(dir, ROSTER_FILE);
  return {
    readOwner: () => {
      const file = readJsonIfPresent<OwnerFile>(ownerFile);
      return file === undefined ? undefined : parsed<OwnerRecord>(openWithKey(key, file.record, 'owner-record'));
    },
    writeOwner: (record) => writeJsonDurably(ownerFile, { contractAddress: record.contractAddress, record: sealWithKey(key, json(record), 'owner-record') } satisfies OwnerFile),
    ownerWrittenAt: () => (fs.existsSync(ownerFile) ? fs.statSync(ownerFile).mtime : undefined),
    // The records and their device move aside together, into a directory of their own.
    setAsideOwner: () => {
      const keptAt = path.join(dir, `${ASIDE_PREFIX}${clock().getTime()}`);
      fs.mkdirSync(keptAt, { mode: 0o700 });
      for (const file of [OWNER_FILE, DEVICE_FILE, DEVICE_READ_FILE]) {
        const from = path.join(dir, file);
        if (!fs.existsSync(from)) continue;
        fs.renameSync(from, path.join(keptAt, file));
        fs.chmodSync(path.join(keptAt, file), FILE_MODE);
      }
      return keptAt;
    },
    readRoster: () => {
      const file = readJsonIfPresent<{ roster: KeyedSecret }>(rosterFile);
      return file === undefined ? EMPTY_ROSTER : parsed<Roster>(openWithKey(key, file.roster, 'owner-roster'));
    },
    writeRoster: (roster) => writeJsonDurably(rosterFile, { roster: sealWithKey(key, json(roster), 'owner-roster') }),
  };
}

/** The owner's device kept in the account, its secret sealed under `key`. */
export interface SealedDeviceKeys {
  /** The device kept, if any. */
  read(): LocalOwnerDevice | undefined;
  /** Keeps `device`, before any record names it, and returns it. A device already kept is never replaced. */
  keep<D extends LocalOwnerDevice>(device: D): D;
}

export function sealedDeviceKeys(dir: string, key: Uint8Array): SealedDeviceKeys {
  const deviceFile = path.join(dir, DEVICE_FILE);
  return {
    read: () => {
      const file = readJsonIfPresent<DeviceFile>(deviceFile);
      return file === undefined ? undefined : ownerDeviceFromSecret(file.arm, openWithKey(key, file.secret, 'owner-device').toString('utf8'));
    },
    keep: (device) => {
      try {
        writeJsonDurably(deviceFile, { arm: device.arm, secret: sealWithKey(key, Buffer.from(device.secretText(), 'utf8'), 'owner-device') } satisfies DeviceFile, { exclusive: true });
      } catch (error) {
        if (error instanceof FileExistsError) throw new Error(`The account in ${dir} already keeps an owner key; it is never replaced.`);
        throw error;
      }
      return device;
    },
  };
}

// The private state's password: random, from an alphabet of all four of
// midnight-js's character classes, redrawn until it meets midnight-js's own
// policy (a random draw can still hold a run such as "abcd").
const PASSWORD_LENGTH = 32;
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789-_.~!@#%^*+=';

const freshPrivateStatePassword = (): string => {
  for (;;) {
    const password = [...randomBytes(PASSWORD_LENGTH)].map((byte) => PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]).join('');
    try {
      validatePassword(password);
      return password;
    } catch {
      // Drawn again.
    }
  }
};

/** Keeps `password` as the account's private-state password, sealed under `key`: for an imported account. Never over one kept. */
export function keepPrivateStatePassword(dir: string, key: Uint8Array, password: string): void {
  writeJsonDurably(path.join(dir, PRIVATE_STATE_FILE), { password: sealWithKey(key, Buffer.from(password, 'utf8'), 'private-state-password') }, { exclusive: true });
}

/** The account's private-state password: made on first use, sealed under `key`, the same every time after. */
export function sealedPrivateStatePassword(dir: string, key: Uint8Array): string {
  const file = path.join(dir, PRIVATE_STATE_FILE);
  const kept = readJsonIfPresent<{ password: KeyedSecret }>(file);
  if (kept !== undefined) return openWithKey(key, kept.password, 'private-state-password').toString('utf8');
  const password = freshPrivateStatePassword();
  try {
    writeJsonDurably(file, { password: sealWithKey(key, Buffer.from(password, 'utf8'), 'private-state-password') }, { exclusive: true });
    return password;
  } catch (error) {
    // Another run made it first: that one is the account's.
    if (error instanceof FileExistsError) return sealedPrivateStatePassword(dir, key);
    throw error;
  }
}

/** The devices on the account this machine knows of, by their codes, sealed under `key`. */
export interface SealedDeviceList {
  read(): string[];
  write(codes: readonly string[]): void;
}

export function sealedDeviceList(dir: string, key: Uint8Array): SealedDeviceList {
  const file = path.join(dir, DEVICES_FILE);
  return {
    read: () => {
      const kept = readJsonIfPresent<{ devices: KeyedSecret }>(file);
      return kept === undefined ? [] : parsed<string[]>(openWithKey(key, kept.devices, 'owner-devices'));
    },
    write: (codes) => writeJsonDurably(file, { devices: sealWithKey(key, json([...new Set(codes)]), 'owner-devices') }),
  };
}

/** True when `dir` holds a device made for an account it has no records of yet: one `device new` made, awaiting a backup. */
export function isPendingDevice(dir: string): boolean {
  return isSealedAccount(dir) && fs.existsSync(path.join(dir, DEVICE_FILE)) && !fs.existsSync(path.join(dir, OWNER_FILE));
}

/**
 * A device of this machine's own for an account another device already
 * owns: a JubJub key (the arm the contract adds devices on), made here and
 * sealed under `passphrase`, before the account's records come in a backup.
 * Made once: asked again, the same device. Refused where an account is.
 */
export function createPendingDevice(dir: string, passphrase: string): LocalOwnerDevice {
  if (isPendingDevice(dir)) {
    const kept = sealedDeviceKeys(dir, openAccountKey(dir, passphrase)).read();
    if (kept !== undefined) return kept;
  }
  if (isSealedAccount(dir) || isAccountMigrating(dir) || fs.existsSync(path.join(dir, 'owner.json'))) {
    throw new UsageError(`The wallet already has an account in ${dir}: a new device is made for a wallet with none.`);
  }
  const key = createAccountKey(dir, passphrase);
  const device = sealedDeviceKeys(dir, key).keep(freshOwnerDevice('v1'));
  sealedDeviceList(dir, key).write([deviceCodeOf(device, x25519PublicOf(sealedDeviceReadSecret(dir, key)))]);
  return device;
}

/** The owner device's read key (an X25519 secret): made with the device, or on first use for one made before, sealed under `key`. */
export function sealedDeviceReadSecret(dir: string, key: Uint8Array): Uint8Array {
  const file = path.join(dir, DEVICE_READ_FILE);
  const kept = readJsonIfPresent<{ readSecret: KeyedSecret }>(file);
  if (kept !== undefined) return new Uint8Array(openWithKey(key, kept.readSecret, 'owner-device-read'));
  try {
    writeJsonDurably(file, { readSecret: sealWithKey(key, x25519KeyPair().secret, 'owner-device-read') }, { exclusive: true });
  } catch (error) {
    // Another run made it first: that one is the device's.
    if (!(error instanceof FileExistsError)) throw error;
  }
  return sealedDeviceReadSecret(dir, key);
}

/** This machine's device code: its owner device and read key. */
export function ownDeviceCode(dir: string, key: Uint8Array, device: Pick<LocalOwnerDevice, 'arm' | 'pk'>): string {
  return deviceCodeOf(device, x25519PublicOf(sealedDeviceReadSecret(dir, key)));
}

/** The code this machine's device prints to be added: its code and its signature of its read key. */
export function ownJoinCode(dir: string, key: Uint8Array, device: LocalOwnerDevice): string {
  return joinCodeOf(device, x25519PublicOf(sealedDeviceReadSecret(dir, key)));
}

/** Keeps `readSecret` as the owner device's read key, sealed under `key`: for a device restored from a backup. Never over one kept. */
export function keepDeviceReadSecret(dir: string, key: Uint8Array, readSecret: Uint8Array): void {
  writeJsonDurably(path.join(dir, DEVICE_READ_FILE), { readSecret: sealWithKey(key, readSecret, 'owner-device-read') }, { exclusive: true });
}

