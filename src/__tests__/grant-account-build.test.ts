// Finding and checking the account build `mn grant` drives, and where an
// account's records live. Real directories, made for each test.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NodeTooOldForAccountBuildError, assertNodeRunsAccountBuild, checkAccountBuild, resolveAccountBuild } from '../lib/grant/account-build.ts';
import { accountRecordsDir, accountWalletName, ensureAccountRecordsDir } from '../lib/grant/account-records.ts';
import { UsageError } from '../lib/errors.ts';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-account-build-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveAccountBuild', () => {
  it('takes the flag over the configured directory, as an absolute path', () => {
    expect(resolveAccountBuild('/builds/a', '/builds/b')).toBe('/builds/a');
    expect(resolveAccountBuild(undefined, '/builds/b')).toBe('/builds/b');
    expect(resolveAccountBuild('relative/build', undefined)).toBe(path.resolve('relative/build'));
  });

  it('says how to name one when neither is given', () => {
    expect(() => resolveAccountBuild(undefined, undefined)).toThrow(UsageError);
    expect(() => resolveAccountBuild(undefined, undefined)).toThrow('--account-build <dir>, or once with: midnight config set account-build <dir>');
    expect(() => resolveAccountBuild('  ', undefined)).toThrow(UsageError);
  });
});

describe('checkAccountBuild', () => {
  it('accepts a directory with the module mn imports and its dependencies installed', () => {
    fs.writeFileSync(path.join(dir, 'driver.ts'), 'export const DRIVER_VERSION = 1;\n');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    expect(() => checkAccountBuild(dir)).not.toThrow();
  });

  it('refuses what is not a directory', () => {
    const file = path.join(dir, 'a-file');
    fs.writeFileSync(file, '');
    expect(() => checkAccountBuild(file)).toThrow(`The account build ${file} is not a directory.`);
    expect(() => checkAccountBuild(path.join(dir, 'missing'))).toThrow(UsageError);
  });

  it('refuses a directory without the module, naming it', () => {
    fs.mkdirSync(path.join(dir, 'node_modules'));
    expect(() => checkAccountBuild(dir)).toThrow(`${dir} is not an account build mn can drive: it has no driver.ts.`);
  });

  it('says to install the dependencies when they are not there', () => {
    fs.writeFileSync(path.join(dir, 'driver.ts'), '');
    expect(() => checkAccountBuild(dir)).toThrow(`The account build ${dir} has no node_modules: install its dependencies there first (npm install).`);
  });
});

describe('assertNodeRunsAccountBuild', () => {
  it('accepts Node.js 22.18 and newer', () => {
    for (const version of ['22.18.0', '22.20.1', '23.0.0', '25.3.0']) {
      expect(() => assertNodeRunsAccountBuild(version)).not.toThrow();
    }
  });

  it('refuses an older one, which can\'t run TypeScript as it is', () => {
    for (const version of ['22.17.9', '22.0.0', '20.10.0']) {
      expect(() => assertNodeRunsAccountBuild(version)).toThrow(`needs Node.js 22.18.0 or newer; this is Node.js ${version}.`);
      expect(() => assertNodeRunsAccountBuild(version)).toThrow(NodeTooOldForAccountBuildError);
    }
  });
});

describe('an account\'s records', () => {
  it('live under ~/.midnight/accounts, by network and wallet', () => {
    expect(accountRecordsDir('undeployed', 'alice', '/home/norm')).toBe('/home/norm/.midnight/accounts/undeployed/alice');
  });

  it('are kept under the wallet\'s name: the flag, a wallet file\'s name, or the active wallet', () => {
    expect(accountWalletName('alice', () => 'active')).toBe('alice');
    expect(accountWalletName('/some/where/bob.json', () => 'active')).toBe('bob');
    expect(accountWalletName(undefined, () => 'active')).toBe('active');
  });

  it('get a directory only their owner can read', () => {
    const records = path.join(dir, 'accounts', 'undeployed', 'alice');
    ensureAccountRecordsDir(records);
    expect(fs.statSync(records).mode & 0o777).toBe(0o700);
    expect(() => ensureAccountRecordsDir(records)).not.toThrow();
  });
});
