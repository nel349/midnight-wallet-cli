// A stand-in account build for tests: a directory with the driver.ts mn
// imports, which writes down what it is called with instead of touching a
// chain, and mn's own node_modules for its dependencies. The bridge runs it
// exactly as it runs a real build.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// What a build's driver.ts offers, here writing down what it was called with.
const DRIVER = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DRIVER_VERSION: number = Number(process.env.STAND_IN_DRIVER_VERSION ?? 4);
const records = process.env.MIDNIGHT_ACCOUNT_STATE_DIR as string;
const seen = (what: string, value: unknown): void => writeFileSync(join(records, what + '.json'), JSON.stringify(value));

export const accountOnRecord = (): { address: string; arm: string } | undefined =>
  existsSync(join(records, 'account.json')) ? JSON.parse(readFileSync(join(records, 'account.json'), 'utf8')) : undefined;

type Wallet = { supportedEras: readonly string[]; getCoinPublicKey: () => string; getEncryptionPublicKey: () => string };

export const deployOver = async (wallet: Wallet, deviceSk?: string) => {
  console.log('wave 1: deployed');
  seen('deploy', {
    deviceSk, cwd: process.cwd(), coinPublicKey: wallet.getCoinPublicKey(), encryptionPublicKey: wallet.getEncryptionPublicKey(),
    eras: wallet.supportedEras, node: process.env.MIDNIGHT_ACCOUNT_NODE_URL, indexer: process.env.MIDNIGHT_ACCOUNT_INDEXER_URL,
    proofServer: process.env.MIDNIGHT_ACCOUNT_PROOF_SERVER_URL,
  });
  if (deviceSk === 'ee'.repeat(32)) throw new Error('the deploy failed for want of Dust');
  seen('account', { address: 'ab'.repeat(32), arm: 'k1' });
  return { address: 'ab'.repeat(32), resumed: false, activated: true };
};

export const depositOver = async (wallet: Wallet, value: bigint) => {
  console.log('deposit_shielded: 21.0 s');
  seen('deposit', { value: typeof value === 'bigint' ? value.toString() : 'not a bigint', coinPublicKey: wallet.getCoinPublicKey() });
  if (value === 999n) throw new Error('Insufficient shielded balance');
  return { address: 'ab'.repeat(32), value: value.toString(), txHash: 'd0'.repeat(32), blockHeight: 412 };
};

export const runOwnerOver = async (wallet: Wallet, argv: readonly string[], out: (text: string) => void): Promise<number> => {
  console.log('issue_grant (k1): 24.0 s');
  seen('owner', { argv, coinPublicKey: wallet.getCoinPublicKey() });
  if (argv[0] === 'nope') { console.error('usage: status | grants'); return 2; }
  if (argv[0] === 'revoke') { console.error('the roster holds no revocable grant ' + argv[1]); return 1; }
  out(JSON.stringify({ grants: [], asked: argv }, null, 2));
  return 0;
};
`;

/** A new stand-in build directory; the caller removes it. */
export function createStandInAccountBuild(): string {
  const buildDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-stand-in-build-')));
  fs.writeFileSync(path.join(buildDir, 'driver.ts'), DRIVER);
  // A build has its own dependencies installed; this one borrows mn's.
  fs.symlinkSync(fileURLToPath(new URL('../../../node_modules', import.meta.url)), path.join(buildDir, 'node_modules'));
  return buildDir;
}

/** The account the stand-in driver reports once it is on record. */
export const STAND_IN_ACCOUNT = { address: 'ab'.repeat(32), arm: 'k1' };
