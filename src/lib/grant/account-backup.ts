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
import {
  createAccountKey,
  isAccountMigrating,
  isSealedAccount,
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
  device: { arm: Arm; secret: string };
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

// A plain-text or half-sealed account must be protected before it is backed up.
const sealedAccountIn = (dir: string, passphrase: string) => {
  if (!isSealedAccount(dir)) throw new UsageError(`The account in ${dir} is not protected. Encrypt it first: midnight wallet protect`);
  return openAccountKey(dir, passphrase);
};

/** Writes the account in `dir` on `network` to `file`, sealed under `passphrase`. Never over a file that exists. */
export async function exportAccount(dir: string, network: string, passphrase: string, file: string): Promise<{ contractAddress: string; file: string }> {
  const key = sealedAccountIn(dir, passphrase);
  const record = sealedOwnerStore(dir, key).readOwner();
  const device = sealedDeviceKeys(dir, key).read();
  if (record === undefined || device === undefined) throw new UsageError(`The account in ${dir} has not been deployed yet: there is nothing to back up.`);
  const database = privateStateLocationOf(dir, () => '').database;
  const bundle: AccountBundle = {
    record,
    roster: sealedOwnerStore(dir, key).readRoster(),
    device: { arm: device.arm, secret: device.secretText() },
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
  const hasAccount = isSealedAccount(dir) || isAccountMigrating(dir) || fs.existsSync(path.join(dir, 'owner.json')) || fs.existsSync(database);
  if (hasAccount) throw new UsageError(`The wallet already has an account in ${dir}; a backup is never imported over one.`);

  const key = createAccountKey(dir, passphrase);
  const store = sealedOwnerStore(dir, key);
  sealedDeviceKeys(dir, key).keep(ownerDeviceFromSecret(bundle.device.arm, bundle.device.secret));
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
