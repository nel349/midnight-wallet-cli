// The bridge to the account build: the real generated script, run by Node in
// a stand-in build directory whose driver.ts records what it is given, with a
// WebSocket server standing in for mn serve. Nothing of the bridge is faked:
// the script, its environment, its working directory and its result all go
// through the code a real run uses.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer } from 'ws';
import {
  UnreachableByAccountBuildError, accountOnRecord, bridgeEnvironment, deployAccount, depositIntoAccount, generateBridgeScript, newDevelopmentOwnerKey,
  runOwnerCommand, type AccountBridge,
} from '../lib/grant/bridge.ts';
import { classifyError } from '../lib/exit-codes.ts';
import { type AccountBuild, installedAccountPackage } from '../lib/grant/account-build.ts';
import type { NetworkConfig } from '../lib/network.ts';
import { createStandInAccountBuild } from './helpers/stand-in-account-build.ts';

const NETWORK: NetworkConfig = {
  indexer: 'http://localhost:28088/api/v4/graphql',
  indexerWS: 'ws://localhost:28088/api/v4/graphql/ws',
  node: 'ws://localhost:29944',
  proofServer: 'http://localhost:26300',
  networkId: 'Undeployed',
};

let buildDir: string;
let recordsDir: string;
let serve: WebSocketServer;
let servePort: number;
const messages: string[] = [];
const bridge = (): AccountBridge => ({ build: { kind: 'directory', dir: buildDir }, recordsDir, networkConfig: NETWORK, servePort, onMessage: (m) => messages.push(m) });
const LOCAL: AccountBuild = { kind: 'directory', dir: '/builds/chain' };
const recorded = (what: string) => JSON.parse(fs.readFileSync(path.join(recordsDir, `${what}.json`), 'utf8'));

beforeAll(async () => {
  buildDir = createStandInAccountBuild();
  recordsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-account-records-')));

  serve = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => serve.once('listening', resolve));
  servePort = (serve.address() as { port: number }).port;
  serve.on('connection', (socket) => {
    socket.on('message', (data) => {
      const { id, method } = JSON.parse(data.toString());
      // As mn serve sends them: bigints as decimal text, keyed by token type (NIGHT is all zeros).
      const result = method === 'getShieldedAddresses' ? { shieldedCoinPublicKey: 'c0'.repeat(32), shieldedEncryptionPublicKey: 'e0'.repeat(32) }
        : method === 'getShieldedBalances' ? { ['0'.repeat(64)]: '5000000', ['ff'.repeat(32)]: '90000000' }
        : null;
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
});

afterAll(async () => {
  await new Promise((resolve) => serve.close(resolve));
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.rmSync(recordsDir, { recursive: true, force: true });
});

describe('bridgeEnvironment', () => {
  it('gives the build its endpoints as http URLs and its records directory', () => {
    expect(bridgeEnvironment(NETWORK, '/records', LOCAL)).toMatchObject({
      MIDNIGHT_ACCOUNT_NODE_URL: 'http://localhost:29944',
      MIDNIGHT_ACCOUNT_INDEXER_URL: 'http://localhost:28088/api/v4/graphql',
      MIDNIGHT_ACCOUNT_PROOF_SERVER_URL: 'http://localhost:26300',
      MIDNIGHT_ACCOUNT_STATE_DIR: '/records',
    });
    expect(bridgeEnvironment({ ...NETWORK, node: 'wss://node.example:443' }, '/r', LOCAL).MIDNIGHT_ACCOUNT_NODE_URL).toBe('https://node.example:443');
  });

  it('names a cache under ~/.midnight for the installed package\'s proving artefacts, and none for a local build, which has its own', () => {
    const origHome = process.env.HOME;
    process.env.HOME = '/home/norm';
    try {
      expect(bridgeEnvironment(NETWORK, '/records', installedAccountPackage()).MIDNIGHT_ACCOUNT_ARTEFACTS_DIR).toBe('/home/norm/.midnight/account-artifacts');
      expect(bridgeEnvironment(NETWORK, '/records', LOCAL).MIDNIGHT_ACCOUNT_ARTEFACTS_DIR).toBeUndefined();
    } finally {
      process.env.HOME = origHome;
    }
  });

  it('refuses a network the build can\'t reach', () => {
    expect(() => bridgeEnvironment({ ...NETWORK, networkId: 'PreProd' }, '/r', LOCAL)).toThrow(UnreachableByAccountBuildError);
    expect(() => bridgeEnvironment({ ...NETWORK, networkId: 'PreProd' }, '/r', LOCAL)).toThrow('reaches only an undeployed (local) network; this is PreProd');
  });
});

describe('generateBridgeScript', () => {
  it('asks which account is on record without a wallet or mn serve', () => {
    const script = generateBridgeScript({ kind: 'account' }, LOCAL);
    expect(script).not.toContain('ws://127.0.0.1');
    expect(script).toContain('driver.accountOnRecord()');
  });

  it('needs an mn serve for anything that pays', () => {
    expect(() => generateBridgeScript({ kind: 'deploy' }, LOCAL)).toThrow('The deploy action needs an mn serve to pay');
    expect(() => generateBridgeScript({ kind: 'deposit', value: '1' }, LOCAL)).toThrow('The deposit action needs an mn serve to pay');
  });

  it('never carries the owner key: the script reads it from its environment', () => {
    const script = generateBridgeScript({ kind: 'deploy' }, LOCAL, 9932);
    expect(script).toContain('process.env.MN_GRANT_OWNER_KEY');
    expect(script).toContain('ws://127.0.0.1:9932');
  });

  it('imports everything from the installed package by URL, so it runs from anywhere', () => {
    const build = installedAccountPackage();
    if (build.kind !== 'package') throw new Error('not the package');
    const script = generateBridgeScript({ kind: 'deposit', value: '1' }, build, 9932);
    for (const url of [build.driverUrl, build.typesUrl, build.wsUrl]) expect(script).toContain(JSON.stringify(url));
    expect(script).not.toMatch(/from '(ws|@midnight-ntwrk\/[^']+)'/);
  });
});

describe('running the bridge in a build', () => {
  it('finds no account on record before a deploy', async () => {
    expect(await accountOnRecord(bridge())).toBeNull();
  });

  it('deploys with the wallet behind mn serve, the owner key from the environment, and the records directory as working directory', async () => {
    const ownerKey = newDevelopmentOwnerKey();
    expect(ownerKey).toMatch(/^[0-9a-f]{64}$/);
    messages.length = 0;

    // Set in the shell, none reaches the build: a profile would move its
    // records, and the artefacts it proves with are its own.
    const shell = { BENCH_PROFILE: 'k1', MIDNIGHT_ACCOUNT_ARTEFACTS_DIR: '/elsewhere', MIDNIGHT_ACCOUNT_ARTEFACTS_SOURCE: 'relative/source' };
    Object.assign(process.env, shell);
    let outcome;
    try {
      outcome = await deployAccount(bridge(), ownerKey);
    } finally {
      for (const name of Object.keys(shell)) delete process.env[name];
    }

    expect(outcome).toEqual({ address: 'ab'.repeat(32), resumed: false, activated: true });
    expect(recorded('deploy')).toEqual({
      deviceSk: ownerKey,
      cwd: recordsDir,
      coinPublicKey: 'c0'.repeat(32),
      encryptionPublicKey: 'e0'.repeat(32),
      eras: ['v9'],
      node: 'http://localhost:29944',
      indexer: 'http://localhost:28088/api/v4/graphql',
      proofServer: 'http://localhost:26300',
      profile: null,
      artefactsDir: null,
      artefactsSource: null,
    });
    // The build's console.log progress reaches mn as messages, not as output.
    expect(messages).toContain('wave 1: deployed');
    // Nothing of mn's is left in the build's directory.
    expect(fs.readdirSync(buildDir).sort()).toEqual(['driver.ts', 'node_modules']);
  });

  it('then finds the account on record', async () => {
    expect(await accountOnRecord(bridge())).toEqual({ address: 'ab'.repeat(32), arm: 'k1' });
  });

  it('reports a failed deploy as the build\'s own error', async () => {
    await expect(deployAccount(bridge(), 'ee'.repeat(32))).rejects.toThrow('the deploy failed for want of Dust');
    expect(fs.readdirSync(buildDir).sort()).toEqual(['driver.ts', 'node_modules']);
  });

  it('deposits with the wallet behind mn serve, the value reaching the build as a bigint', async () => {
    messages.length = 0;
    expect(await depositIntoAccount(bridge(), '2000000')).toEqual({ address: 'ab'.repeat(32), value: '2000000', txHash: 'd0'.repeat(32), blockHeight: 412 });
    expect(recorded('deposit')).toEqual({ value: '2000000', coinPublicKey: 'c0'.repeat(32) });
    expect(messages).toContain('deposit_shielded: 21.0 s');
    expect(fs.readdirSync(buildDir).sort()).toEqual(['driver.ts', 'node_modules']);
  });

  it('refuses a deposit the wallet\'s shielded NIGHT can\'t cover before the build is called, saying what it holds', async () => {
    fs.rmSync(path.join(recordsDir, 'deposit.json'), { force: true });
    const refused = depositIntoAccount(bridge(), '5000001');
    await expect(refused).rejects.toThrow('Not enough shielded NIGHT for this deposit: the wallet holds 5.000000 NIGHT shielded and the deposit takes 5.000001 NIGHT. '
      + 'Get shielded NIGHT into it first: midnight airdrop <amount> --shielded on a local chain');
    const error = await refused.then(() => new Error('the deposit ran'), (e: unknown) => e as Error);
    expect(classifyError(error)).toEqual({ exitCode: 5, errorCode: 'INSUFFICIENT_BALANCE' });
    expect(fs.existsSync(path.join(recordsDir, 'deposit.json'))).toBe(false);
    // Exactly what it holds is enough.
    expect((await depositIntoAccount(bridge(), '5000000')).value).toBe('5000000');
  });

  it('reports a failed deposit as the build\'s own error', async () => {
    await expect(depositIntoAccount(bridge(), '999')).rejects.toThrow('Insufficient shielded balance');
  });

  it('refuses a deposit value that is not a positive whole number before anything runs', async () => {
    for (const value of ['0', '1.5', '-3', '', '1e6', '0x10']) {
      await expect(depositIntoAccount(bridge(), value)).rejects.toThrow(`A deposit's value is a positive whole number of the smallest unit; got "${value}"`);
    }
  });

  it('runs an owner command and returns what it wrote as its result', async () => {
    messages.length = 0;
    const result = await runOwnerCommand(bridge(), ['grants', '--json']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ grants: [], asked: ['grants', '--json'] });
    expect(result.errors).toEqual([]);
    expect(recorded('owner')).toEqual({ argv: ['grants', '--json'], coinPublicKey: 'c0'.repeat(32) });
    expect(messages).toContain('issue_grant (k1): 24.0 s');
  });

  it('returns the build\'s exit code and what it reported when a command fails or is misused', async () => {
    expect(await runOwnerCommand(bridge(), ['revoke', '7'])).toEqual({ exitCode: 1, output: '', errors: ['the roster holds no revocable grant 7'] });
    expect(await runOwnerCommand(bridge(), ['nope'])).toEqual({ exitCode: 2, output: '', errors: ['usage: status | grants'] });
  });

  it('refuses a build that speaks another version of the interface', async () => {
    process.env.STAND_IN_DRIVER_VERSION = '2';
    try {
      await expect(accountOnRecord(bridge())).rejects.toThrow('This account build speaks version 2 of its interface; this mn speaks version 4.');
    } finally {
      delete process.env.STAND_IN_DRIVER_VERSION;
    }
  });
});

describe('running the bridge in the installed account package', () => {
  let home: string;
  let records: string;
  let origHome: string | undefined;

  beforeAll(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-account-home-')));
    records = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-account-records-')));
    origHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterAll(() => {
    process.env.HOME = origHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(records, { recursive: true, force: true });
  });

  it('runs the package\'s own driver from the records directory, which it leaves as it found it', async () => {
    // Whatever the shell set: the package's own cache and source are mn's to
    // name, its records are not moved by a profile, and the Node.js it runs
    // on is mn's own, not the first on PATH.
    const shell = { BENCH_PROFILE: 'k1', MIDNIGHT_ACCOUNT_ARTEFACTS_SOURCE: 'relative/source', PATH: '/nowhere' };
    const before = { ...process.env };
    Object.assign(process.env, shell);
    try {
      expect(await accountOnRecord({ build: installedAccountPackage(), recordsDir: records, networkConfig: NETWORK })).toBeNull();
    } finally {
      for (const name of Object.keys(shell)) {
        if (before[name] === undefined) delete process.env[name];
        else process.env[name] = before[name];
      }
    }
    expect(fs.readdirSync(records)).toEqual([]);
    // The package placed its build's manifest in its artefact cache, and fetched nothing.
    const [cache, ...more] = fs.readdirSync(path.join(home, '.midnight', 'account-artifacts'));
    expect(more).toEqual([]);
    expect(fs.readdirSync(path.join(home, '.midnight', 'account-artifacts', cache ?? ''))).toEqual(['compiler']);
  });
});
