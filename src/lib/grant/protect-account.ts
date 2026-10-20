// Sealing an account an earlier mn made in plain text, for `midnight wallet
// protect`. In an order that any interruption leaves safe, and that running
// it again finishes:
//   1. a data key is made under a migrating name (an interrupted run's is reused);
//   2. the records, roster and owner key are written sealed under it;
//   3. the private state is moved off the public password onto the account's
//      own, each store in one batch (one already moved is left as it is);
//   4. what was sealed is read back and compared with the plain text;
//   5. the data key is given its final name: from here the account is sealed;
//   6. the plain-text files are removed, and a deploy's records kept aside
//      in plain text are sealed.
// Between 3 and 5 the account is refused (AccountMigrationInterruptedError),
// never opened under the public password its private state has left.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Arm } from '@kuiralabs/midnight-account';
import { changePrivateStatePassword, directoryOwnerStore, ownerDeviceFromSecret } from '@kuiralabs/midnight-account-chain/owner';
import { MIDNIGHT_DIR } from '../constants.ts';
import { LEGACY_STORE_PASSWORD, privateStateLocationOf } from './account.ts';
import { ACCOUNTS_DIR_NAME, accountRecordsDir } from './account-records.ts';
import {
  completeAccountKey,
  isSealedAccount,
  migratingAccountKey,
  sealPlainFile,
  sealedDeviceKeys,
  sealedOwnerStore,
  sealedPrivateStatePassword,
} from './sealed-account.ts';

export { AccountMigrationInterruptedError } from './sealed-account.ts';

/** What protecting one account did. */
export type AccountProtectOutcome = 'sealed-now' | 'already-sealed' | 'nothing';

// The plain-text files an earlier mn kept an account's secrets in.
const PLAIN_OWNER_FILE = 'owner.json';
const PLAIN_ROSTER_FILE = 'roster.json';
// The records of a deploy that never landed, moved aside by the account package.
const PLAIN_SET_ASIDE = /^owner\.unlanded-\d+\.json$/;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Seals the account in `dir` under `passphrase`, if it is in plain text. Its
 * private state is scoped to the paying wallet's shielded coin public key,
 * `coinPublicKey` (hex). `stopBeforeSealing` stops after step 4, as an
 * interrupted run would, for the tests.
 */
export async function protectAccount(dir: string, passphrase: string, coinPublicKey: string, { stopBeforeSealing = false }: { stopBeforeSealing?: boolean } = {}): Promise<AccountProtectOutcome> {
  if (isSealedAccount(dir)) {
    // A run that stopped after sealing, before the plain text was removed.
    for (const file of [PLAIN_OWNER_FILE, PLAIN_ROSTER_FILE]) fs.rmSync(path.join(dir, file), { force: true });
    return 'already-sealed';
  }
  const plain = directoryOwnerStore(dir);
  const record = plain.readOwner();
  // The owner key beside the records, as an earlier mn kept it in owner.json.
  const plainOwner = fs.existsSync(path.join(dir, PLAIN_OWNER_FILE))
    ? (JSON.parse(fs.readFileSync(path.join(dir, PLAIN_OWNER_FILE), 'utf8')) as { deviceArm?: Arm; deviceSk?: string })
    : {};
  const device = plainOwner.deviceSk === undefined ? undefined : ownerDeviceFromSecret(plainOwner.deviceArm ?? 'v1', plainOwner.deviceSk);
  const hasRoster = fs.existsSync(path.join(dir, PLAIN_ROSTER_FILE));
  if (record === undefined && device === undefined && !hasRoster) return 'nothing';

  // 1, 2
  const key = migratingAccountKey(dir, passphrase);
  const store = sealedOwnerStore(dir, key);
  const keys = sealedDeviceKeys(dir, key);
  if (record !== undefined) store.writeOwner(record);
  store.writeRoster(plain.readRoster());
  if (device !== undefined && keys.read() === undefined) keys.keep(device);

  // 3
  const password = sealedPrivateStatePassword(dir, key);
  const location = privateStateLocationOf(dir, () => LEGACY_STORE_PASSWORD);
  if (record !== undefined && fs.existsSync(location.database)) {
    await changePrivateStatePassword({ getCoinPublicKey: () => coinPublicKey }, record.contractAddress, location, () => password);
  }

  // 4
  if (!same(store.readOwner(), record) || !same(store.readRoster(), plain.readRoster()) || keys.read()?.secretText() !== device?.secretText()) {
    throw new Error(`Sealing the account in ${dir} did not read back as its plain text; the plain text is kept. Run midnight wallet protect again.`);
  }
  if (stopBeforeSealing) return 'nothing';

  // 5, 6
  completeAccountKey(dir);
  for (const file of [PLAIN_OWNER_FILE, PLAIN_ROSTER_FILE]) fs.rmSync(path.join(dir, file), { force: true });
  for (const file of fs.readdirSync(dir).filter((f) => PLAIN_SET_ASIDE.test(f))) sealPlainFile(dir, file, key);
  return 'sealed-now';
}

/** What protecting one account under ~/.midnight/accounts did, or why it could not. */
export type ProtectedAccount =
  | { network: string; wallet: string; outcome: AccountProtectOutcome }
  | { network: string; wallet: string; error: string };

/**
 * Seals every plain-text account under `home`, in network and wallet order.
 * `coinKeyOf` names the shielded coin public key of the wallet an account
 * belongs to. An account that cannot be sealed is named with why, and the
 * others are still sealed.
 */
export async function protectAllAccounts(home: string, passphrase: string, coinKeyOf: (wallet: string) => Promise<string>): Promise<ProtectedAccount[]> {
  const root = path.join(home, MIDNIGHT_DIR, ACCOUNTS_DIR_NAME);
  const report: ProtectedAccount[] = [];
  const dirsIn = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []);
  for (const network of dirsIn(root)) {
    for (const wallet of dirsIn(path.join(root, network))) {
      const dir = accountRecordsDir(network, wallet, home);
      try {
        const outcome = isSealedAccount(dir)
          ? await protectAccount(dir, passphrase, '')
          : await protectAccount(dir, passphrase, await coinKeyOf(wallet));
        if (outcome !== 'nothing') report.push({ network, wallet, outcome });
      } catch (error) {
        report.push({ network, wallet, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return report;
}

