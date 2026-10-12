// What `mn grant` settles before a wallet is looked at or a server started.
// The home directory is a temporary one and the account build is the stand-in,
// run for real: nothing here reaches a chain.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from '../lib/argv.ts';
import { UsageError } from '../lib/errors.ts';
import { UnreachableByAccountBuildError } from '../lib/grant/bridge.ts';
import { NO_DEV_OWNER_KEY, NoAccountError, prepareGrant } from '../lib/grant/prepare.ts';
import { STAND_IN_ACCOUNT, createStandInAccountBuild } from './helpers/stand-in-account-build.ts';

const ENDPOINTS = ['--node', 'ws://localhost:29944', '--indexer-ws', 'ws://localhost:28088/api/v4/graphql/ws', '--proof-server', 'http://localhost:26300'];

let home: string;
let buildDir: string;
let origHome: string | undefined;

const accounts = () => path.join(home, '.midnight', 'accounts');
const recordsOf = (wallet: string) => path.join(accounts(), 'undeployed', wallet);
const prepare = (...argv: string[]) => prepareGrant(parseArgs(['grant', ...argv, ...ENDPOINTS]));
const inBuild = (...argv: string[]) => prepare(...argv, '--wallet', 'alice', '--account-build', buildDir);

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-grant-home-')));
  buildDir = createStandInAccountBuild();
  origHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(buildDir, { recursive: true, force: true });
});

describe('prepareGrant', () => {
  it('refuses a command line that is wrong before it looks for an account build', async () => {
    await expect(prepare('revoke', '--wallet', 'alice')).rejects.toThrow(UsageError);
    await expect(prepare('revoke', '--wallet', 'alice')).rejects.not.toThrow('account-build');
  });

  it('says how to name an account build when none is named', async () => {
    await expect(prepare('status', '--wallet', 'alice')).rejects.toThrow('midnight config set account-build <dir>');
  });

  it('takes the account build from the config when no flag names one', async () => {
    fs.mkdirSync(path.join(home, '.midnight'), { recursive: true });
    fs.writeFileSync(path.join(home, '.midnight', 'config.json'), JSON.stringify({ network: 'undeployed', 'account-build': buildDir }));
    const prepared = await prepare('deploy', '--dev-owner-key', '--wallet', 'alice');
    expect(prepared.bridge.buildDir).toBe(buildDir);
  });

  it('refuses a network the build can\'t reach, creating nothing', async () => {
    await expect(inBuild('status', '--network', 'preprod')).rejects.toThrow(UnreachableByAccountBuildError);
    expect(fs.existsSync(accounts())).toBe(false);
  });

  it('prepares the deploy of a new account: records under the wallet\'s name, readable by their owner only', async () => {
    const prepared = await inBuild('deploy', '--dev-owner-key');
    expect(prepared.account).toBeNull();
    expect(prepared.walletName).toBe('alice');
    expect(prepared.target.network).toBe('undeployed');
    expect(prepared.bridge).toMatchObject({ buildDir, recordsDir: recordsOf('alice') });
    expect(prepared.bridge.servePort).toBeUndefined();
    expect(fs.statSync(recordsOf('alice')).mode & 0o777).toBe(0o700);
  });

  it('refuses to deploy a new account without --dev-owner-key, saying what the key is', async () => {
    await expect(inBuild('deploy')).rejects.toThrow(NO_DEV_OWNER_KEY);
    await expect(inBuild('deploy')).rejects.toThrow(UsageError);
  });

  it('refuses an owner command when the wallet has no account, saying how to deploy one', async () => {
    for (const command of [['status'], ['list'], ['revoke', '0'], ['revoke-all']]) {
      const refused = inBuild(...command);
      await expect(refused).rejects.toThrow(NoAccountError);
      await expect(refused).rejects.toThrow('Wallet "alice" has no account on undeployed yet.\nDeploy one: midnight grant deploy --dev-owner-key');
    }
  });

  describe('with an account on record', () => {
    beforeEach(() => {
      fs.mkdirSync(recordsOf('alice'), { recursive: true });
      fs.writeFileSync(path.join(recordsOf('alice'), 'account.json'), JSON.stringify(STAND_IN_ACCOUNT));
    });

    it('prepares an owner command on it', async () => {
      const prepared = await inBuild('revoke', '3');
      expect(prepared.account).toEqual(STAND_IN_ACCOUNT);
      expect(prepared.request).toMatchObject({ subcommand: 'revoke' });
    });

    it('lets a deploy run again without --dev-owner-key: the account keeps the key it has', async () => {
      const prepared = await inBuild('deploy');
      expect(prepared.account).toEqual(STAND_IN_ACCOUNT);
    });

    it('keeps each wallet\'s account apart', async () => {
      await expect(prepare('status', '--wallet', 'bob', '--account-build', buildDir)).rejects.toThrow(NoAccountError);
    });
  });
});
