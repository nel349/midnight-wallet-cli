// An account's encrypted backup, for `midnight grant export` and `import`:
// everything another machine needs to act as the same owner, sealed under
// mn's passphrase in one file. The records (its encryption secrets), the
// roster of grants, the owner key, the private state's password, and the
// private state itself (its coins' openings), its files already encrypted
// under that password. Only the network and the address are in the clear.
//
// The owner key is one device: a machine that imports it acts as the same
// device, so the account is used from one machine at a time. Two at once is
// a second device (`midnight grant device add`).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Arm } from '@kuiralabs/midnight-account';
import { type OwnerRecord, type Roster, ownerDeviceFromSecret } from '@kuiralabs/midnight-account-chain/owner';
import { UsageError } from '../errors.ts';
import { FileExistsError, writeJsonDurably } from '../durable-file.ts';
import { type SealedSecret, openSecret, sealSecret } from '../keystore.ts';
import { privateStateLocationOf } from './account.ts';
import { type DeviceIdentity, deviceCodeOf } from './device-code.ts';
import {
  createAccountKey,
  isAccountMigrating,
  isPendingDevice,
  isSealedAccount,
  keepDeviceReadSecret,
  ownDeviceCode,
  sealedDeviceList,
  sealedDeviceReadSecret,
  keepPrivateStatePassword,
  openAccountKey,
  sealedDeviceKeys,
  sealedOwnerStore,
  sealedPrivateStatePassword,
} from './sealed-account.ts';

const BACKUP_KIND = 'mn-account-backup';
const BACKUP_VERSION = 1;

/** A backup as written: the network and the address in clear, everything else sealed. */
interface AccountBackupFile {
  kind: typeof BACKUP_KIND;
  v: typeof BACKUP_VERSION;
  network: string;
  contractAddress: string;
  sealed: SealedSecret;
}

/** What is sealed in a backup. */
interface AccountBundle {
  record: OwnerRecord;
  roster: Roster;
  /** The owner key and its read key (hex); absent from a backup made for another device, which brings its own. */
  device?: { arm: Arm; secret: string; readSecret: string };
  /** The devices on the account the exporting machine knew of, by their codes. */
  devices: string[];
  privateStatePassword: string;
  /** The private state's files, by their path under its database directory, as base64. */
  privateState: Record<string, string>;
}

// Every file under `dir`, by its path relative to it.
const filesUnder = (dir: string, relative = ''): string[] =>
  fs.readdirSync(path.join(dir, relative), { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(relative, entry.name);
    return entry.isDirectory() ? filesUnder(dir, at) : [at];
  });

// The devices on the account this machine knows of: its list, or, for an
// account that kept none, its own device.
const knownDevices = (dir: string, key: Uint8Array, own: { arm: Arm; pk: { x: bigint; y: bigint } }): string[] => {
  const listed = sealedDeviceList(dir, key).read();
  return listed.length > 0 ? listed : [ownDeviceCode(dir, key, own)];
};

// A plain-text or half-sealed account must be protected before it is backed up.
const sealedAccountIn = (dir: string, passphrase: string) => {
  if (!isSealedAccount(dir)) throw new UsageError(`The account in ${dir} is not protected. Encrypt it first: midnight wallet protect`);
  return openAccountKey(dir, passphrase);
};

/**
 * Writes the account in `dir` on `network` to `file`, sealed under
 * `passphrase`. Never over a file that exists. With `forDevice`, the backup
 * is for that device, just added to the account: it carries everything but
 * this machine's owner key.
 */
export async function exportAccount(dir: string, network: string, passphrase: string, file: string, { forDevice }: { forDevice?: DeviceIdentity } = {}): Promise<{ contractAddress: string; file: string }> {
  const key = sealedAccountIn(dir, passphrase);
  const record = sealedOwnerStore(dir, key).readOwner();
  const device = sealedDeviceKeys(dir, key).read();
  if (record === undefined || device === undefined) throw new UsageError(`The account in ${dir} has not been deployed yet: there is nothing to back up.`);
  const database = privateStateLocationOf(dir, () => '').database;
  const bundle: AccountBundle = {
    record,
    roster: sealedOwnerStore(dir, key).readRoster(),
    ...(forDevice === undefined ? { device: { arm: device.arm, secret: device.secretText(), readSecret: Buffer.from(sealedDeviceReadSecret(dir, key)).toString('hex') } } : {}),
    devices: [...new Set([...knownDevices(dir, key, device), ...(forDevice === undefined ? [] : [deviceCodeOf(forDevice, forDevice.readKey)])])],
    privateStatePassword: sealedPrivateStatePassword(dir, key),
    privateState: fs.existsSync(database) ? Object.fromEntries(filesUnder(database).map((f) => [f, fs.readFileSync(path.join(database, f)).toString('base64')])) : {},
  };
  const backup: AccountBackupFile = {
    kind: BACKUP_KIND,
    v: BACKUP_VERSION,
    network,
    contractAddress: record.contractAddress,
    sealed: sealSecret(Buffer.from(JSON.stringify(bundle), 'utf8'), passphrase, 'account-backup'),
  };
  const resolved = path.resolve(file);
  try {
    writeJsonDurably(resolved, backup, { exclusive: true });
  } catch (error) {
    if (error instanceof FileExistsError) throw new UsageError(`${resolved} already exists; a backup is never written over a file.`);
    throw error;
  }
  return { contractAddress: record.contractAddress, file: resolved };
}

/** Imports the backup in `file` as the account in `dir` on `network`, which must have none, sealed under `passphrase`. */
export async function importAccount(dir: string, network: string, passphrase: string, file: string): Promise<{ contractAddress: string }> {
  const backup = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as Partial<AccountBackupFile>;
  if (backup.kind !== BACKUP_KIND || backup.v !== BACKUP_VERSION) throw new UsageError(`${file} is not an account backup mn can read.`);
  if (backup.network !== network) throw new UsageError(`${file} is a backup of an account on ${backup.network}, not on ${network}.`);
  // Opened before anything is written, so a wrong passphrase leaves nothing behind.
  const bundle = JSON.parse(openSecret(backup.sealed, passphrase, 'account-backup').toString('utf8')) as AccountBundle;
  const database = privateStateLocationOf(dir, () => '').database;

  let key: Buffer;
  if (bundle.device === undefined) {
    // Made for another device: this machine's pending device must be the one it names.
    if (!isPendingDevice(dir)) throw new UsageError(`${file} was made for another device to join the account. Make this machine's device first, with: midnight grant device new`);
    key = openAccountKey(dir, passphrase);
    const pending = sealedDeviceKeys(dir, key).read();
    const pendingCode = pending === undefined ? undefined : ownDeviceCode(dir, key, pending);
    if (pendingCode === undefined || !bundle.devices.includes(pendingCode)) {
      throw new UsageError(`${file} was made for another device, not this machine's (${pendingCode ?? 'none'}).`);
    }
    if (fs.existsSync(database)) throw new UsageError(`The wallet already holds a private state in ${dir}; a backup is never imported over one.`);
  } else {
    const hasAccount = isSealedAccount(dir) || isAccountMigrating(dir) || fs.existsSync(path.join(dir, 'owner.json')) || fs.existsSync(database);
    if (hasAccount) throw new UsageError(`The wallet already has an account in ${dir}; a backup is never imported over one.`);
    key = createAccountKey(dir, passphrase);
    sealedDeviceKeys(dir, key).keep(ownerDeviceFromSecret(bundle.device.arm, bundle.device.secret));
    keepDeviceReadSecret(dir, key, new Uint8Array(Buffer.from(bundle.device.readSecret, 'hex')));
  }
  const store = sealedOwnerStore(dir, key);
  sealedDeviceList(dir, key).write(bundle.devices);
  keepPrivateStatePassword(dir, key, bundle.privateStatePassword);
  for (const [relative, base64] of Object.entries(bundle.privateState)) {
    const target = path.join(database, relative);
    if (!target.startsWith(database + path.sep)) throw new Error(`The backup names a private-state file outside its database: ${relative}`);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, Buffer.from(base64, 'base64'), { mode: 0o600 });
  }
  store.writeRoster(bundle.roster);
  // The records last: the account is on record only once everything it needs is here.
  store.writeOwner(bundle.record);
  return { contractAddress: bundle.record.contractAddress };
}
