// Finding and checking the account build `mn grant` drives, and where an
// account's records and the package's proving artefacts live. Real
// directories, made for each test, and the account package mn really has
// installed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACCOUNT_PACKAGE, NodeTooOldForAccountBuildError, accountArtifactsDir, assertNodeRunsAccountBuild, checkAccountBuild, installedAccountPackage, resolveAccountBuild,
} from '../lib/grant/account-build.ts';
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
    expect(resolveAccountBuild('/builds/a', '/builds/b')).toEqual({ kind: 'directory', dir: '/builds/a' });
    expect(resolveAccountBuild(undefined, '/builds/b')).toEqual({ kind: 'directory', dir: '/builds/b' });
    expect(resolveAccountBuild('relative/build', undefined)).toEqual({ kind: 'directory', dir: path.resolve('relative/build') });
  });

  it('is the installed account package when neither names a directory', () => {
    const installed = installedAccountPackage();
    expect(resolveAccountBuild(undefined, undefined)).toEqual(installed);
    expect(resolveAccountBuild('  ', '')).toEqual(installed);
  });
});

describe('installedAccountPackage', () => {
  it('resolves the driver, midnight-js-types and ws mn depends on, to files that exist', () => {
    const build = installedAccountPackage();
    if (build.kind !== 'package') throw new Error('not the package');
    expect(fileURLToPath(build.driverUrl)).toMatch(new RegExp(`node_modules/${ACCOUNT_PACKAGE}/dist/driver\\.js$`));
    for (const url of [build.driverUrl, build.typesUrl, build.wsUrl]) expect(fs.existsSync(fileURLToPath(url))).toBe(true);
  });
});

describe('checkAccountBuild', () => {
  const local = (at: string) => ({ kind: 'directory' as const, dir: at });

  it('accepts a directory with the module mn imports and its dependencies installed', () => {
    fs.writeFileSync(path.join(dir, 'driver.ts'), 'export const DRIVER_VERSION = 1;\n');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    expect(() => checkAccountBuild(local(dir))).not.toThrow();
  });

  it('accepts the installed package as it is', () => {
    expect(() => checkAccountBuild(installedAccountPackage())).not.toThrow();
  });

  it('refuses what is not a directory', () => {
    const file = path.join(dir, 'a-file');
    fs.writeFileSync(file, '');
    expect(() => checkAccountBuild(local(file))).toThrow(`The account build ${file} is not a directory.`);
    expect(() => checkAccountBuild(local(path.join(dir, 'missing')))).toThrow(UsageError);
  });

  it('refuses a directory without the module, naming it', () => {
    fs.mkdirSync(path.join(dir, 'node_modules'));
    expect(() => checkAccountBuild(local(dir))).toThrow(`${dir} is not an account build mn can drive: it has no driver.ts.`);
  });

  it('says to install the dependencies when they are not there', () => {
    fs.writeFileSync(path.join(dir, 'driver.ts'), '');
    expect(() => checkAccountBuild(local(dir))).toThrow(`The account build ${dir} has no node_modules: install its dependencies there first (npm install).`);
  });
});

describe('assertNodeRunsAccountBuild', () => {
  it('accepts Node.js 22.18 and newer', () => {
    for (const version of ['22.18.0', '22.20.1', '23.0.0', '25.3.0']) {
      expect(() => assertNodeRunsAccountBuild(version)).not.toThrow();
    }
  });

  it('refuses an older one', () => {
    for (const version of ['22.17.9', '22.0.0', '20.10.0']) {
      expect(() => assertNodeRunsAccountBuild(version)).toThrow(`needs Node.js 22.18.0 or newer (a local build runs as TypeScript); this is Node.js ${version}.`);
      expect(() => assertNodeRunsAccountBuild(version)).toThrow(NodeTooOldForAccountBuildError);
    }
  });
});

describe('an account\'s records', () => {
  it('live under ~/.midnight/accounts, by network and wallet', () => {
    expect(accountRecordsDir('undeployed', 'alice', '/home/norm')).toBe('/home/norm/.midnight/accounts/undeployed/alice');
  });

  it('are proved with artefacts the package caches under ~/.midnight/account-artifacts', () => {
    expect(accountArtifactsDir('/home/norm')).toBe('/home/norm/.midnight/account-artifacts');
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
