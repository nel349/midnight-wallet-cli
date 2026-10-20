// What `mn grant` settles before a wallet is looked at. The home directory is a
// temporary one, and the account on record is written as an earlier mn left
// it: nothing here reaches a chain.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from '../lib/argv.ts';
import { UsageError } from '../lib/errors.ts';
import { UnreachableByAccountError } from '../lib/grant/account.ts';
import { NoAccountError, prepareGrant } from '../lib/grant/prepare.ts';
import { createAccountKey, sealedOwnerStore } from '../lib/grant/sealed-account.ts';

const ENDPOINTS = ['--node', 'ws://localhost:29944', '--indexer-ws', 'ws://localhost:28088/api/v4/graphql/ws', '--proof-server', 'http://localhost:26300'];

// An account's records as mn 0.6.0-rc.10 left them.
const ACCOUNT = '5e'.repeat(32);
const OWNER_RECORD = { contractAddress: ACCOUNT, deviceArm: 'k1', deviceSk: '4f'.repeat(32), bootSalt: '3a'.repeat(32), encryptionSecret: '2b'.repeat(32) };

let home: string;
let origHome: string | undefined;

const accounts = () => path.join(home, '.midnight', 'accounts');
const recordsOf = (wallet: string) => path.join(accounts(), 'undeployed', wallet);
const prepare = (...argv: string[]) => prepareGrant(parseArgs(['grant', ...argv, ...ENDPOINTS]));
const asAlice = (...argv: string[]) => prepare(...argv, '--wallet', 'alice');

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-grant-home-')));
  origHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('prepareGrant', () => {
  it('refuses a command line that is wrong before anything else', async () => {
    await expect(prepare('revoke', '--wallet', 'alice')).rejects.toThrow(UsageError);
  });

  it('refuses a network the account package can\'t reach, creating nothing', async () => {
    await expect(asAlice('status', '--network', 'preprod')).rejects.toThrow(UnreachableByAccountError);
    expect(fs.existsSync(accounts())).toBe(false);
  });

  it('prepares the deploy of a new account: records under the wallet\'s name, readable by their owner only', async () => {
    const prepared = await asAlice('deploy');
    expect(prepared.account).toBeNull();
    expect(prepared.walletName).toBe('alice');
    expect(prepared.target.network).toBe('undeployed');
    expect(prepared.recordsDir).toBe(recordsOf('alice'));
    expect(fs.statSync(recordsOf('alice')).mode & 0o777).toBe(0o700);
  });

  it('prepares the import of a backup for a wallet with no account', async () => {
    const prepared = await asAlice('import', 'alice.backup.json');
    expect(prepared.account).toBeNull();
    expect(prepared.request).toEqual({ subcommand: 'import', file: 'alice.backup.json' });
  });

  it('finds a sealed account on record by its address, which needs no passphrase', async () => {
    fs.mkdirSync(recordsOf('alice'), { recursive: true });
    sealedOwnerStore(recordsOf('alice'), createAccountKey(recordsOf('alice'), 'correct horse battery staple')).writeOwner({ contractAddress: ACCOUNT, bootSalt: '3a'.repeat(32), encryptionSecret: '2b'.repeat(32) });
    const prepared = await asAlice('status');
    expect(prepared.account).toEqual({ address: ACCOUNT });
  });

  it('refuses an owner command when the wallet has no account, saying how to deploy one', async () => {
    for (const command of [['status'], ['list'], ['revoke', '0'], ['revoke-all']]) {
      const refused = asAlice(...command);
      await expect(refused).rejects.toThrow(NoAccountError);
      await expect(refused).rejects.toThrow('Wallet "alice" has no account on undeployed yet.\nDeploy one: midnight grant deploy');
    }
  });

  it('takes records that hold only a device kept for a deploy that never wrote an account as no account', async () => {
    fs.mkdirSync(recordsOf('alice'), { recursive: true });
    fs.writeFileSync(path.join(recordsOf('alice'), 'owner.json'), JSON.stringify({ deviceArm: 'k1', deviceSk: '4f'.repeat(32) }));
    await expect(asAlice('status')).rejects.toThrow(NoAccountError);
  });

  describe('with an account on record, as an earlier mn left it', () => {
    beforeEach(() => {
      fs.mkdirSync(recordsOf('alice'), { recursive: true });
      fs.writeFileSync(path.join(recordsOf('alice'), 'owner.json'), JSON.stringify(OWNER_RECORD));
    });

    it('refuses to import a backup over it', async () => {
      await expect(asAlice('import', 'alice.backup.json')).rejects.toThrow(/already has an account/);
    });

    it('prepares an owner command on it', async () => {
      const prepared = await asAlice('revoke', '3');
      expect(prepared.account).toEqual({ address: ACCOUNT });
      expect(prepared.request).toMatchObject({ subcommand: 'revoke' });
    });

    it('lets a deploy run again: the account keeps the key it has', async () => {
      const prepared = await asAlice('deploy');
      expect(prepared.account).toEqual({ address: ACCOUNT });
    });

    it('keeps each wallet\'s account apart', async () => {
      await expect(prepare('status', '--wallet', 'bob')).rejects.toThrow(NoAccountError);
    });

    it('reads the records and changes nothing in them', async () => {
      const before = fs.readFileSync(path.join(recordsOf('alice'), 'owner.json'), 'utf8');
      await asAlice('status');
      expect(fs.readFileSync(path.join(recordsOf('alice'), 'owner.json'), 'utf8')).toBe(before);
      expect(fs.readdirSync(recordsOf('alice'))).toEqual(['owner.json']);
    });
  });
});
