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
  UnreachableByAccountBuildError, accountOnRecord, bridgeEnvironment, deployAccount, generateBridgeScript, newDevelopmentOwnerKey,
  runOwnerCommand, type AccountBridge,
} from '../lib/grant/bridge.ts';
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
const bridge = (): AccountBridge => ({ buildDir, recordsDir, networkConfig: NETWORK, servePort, onMessage: (m) => messages.push(m) });
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
      const result = method === 'getShieldedAddresses' ? { shieldedCoinPublicKey: 'c0'.repeat(32), shieldedEncryptionPublicKey: 'e0'.repeat(32) } : null;
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
    expect(bridgeEnvironment(NETWORK, '/records')).toEqual({
      MIDNIGHT_ACCOUNT_NODE_URL: 'http://localhost:29944',
      MIDNIGHT_ACCOUNT_INDEXER_URL: 'http://localhost:28088/api/v4/graphql',
      MIDNIGHT_ACCOUNT_PROOF_SERVER_URL: 'http://localhost:26300',
      MIDNIGHT_ACCOUNT_STATE_DIR: '/records',
    });
    expect(bridgeEnvironment({ ...NETWORK, node: 'wss://node.example:443' }, '/r').MIDNIGHT_ACCOUNT_NODE_URL).toBe('https://node.example:443');
  });

  it('refuses a network the build can\'t reach', () => {
    expect(() => bridgeEnvironment({ ...NETWORK, networkId: 'PreProd' }, '/r')).toThrow(UnreachableByAccountBuildError);
    expect(() => bridgeEnvironment({ ...NETWORK, networkId: 'PreProd' }, '/r')).toThrow('reaches only an undeployed (local) network; this is PreProd');
  });
});

describe('generateBridgeScript', () => {
  it('asks which account is on record without a wallet or mn serve', () => {
    const script = generateBridgeScript({ kind: 'account' });
    expect(script).not.toContain('ws://127.0.0.1');
    expect(script).toContain('driver.accountOnRecord()');
  });

  it('needs an mn serve for anything that pays', () => {
    expect(() => generateBridgeScript({ kind: 'deploy' })).toThrow('The deploy action needs an mn serve to pay');
  });

  it('never carries the owner key: the script reads it from its environment', () => {
    const script = generateBridgeScript({ kind: 'deploy' }, 9932);
    expect(script).toContain('process.env.MN_GRANT_OWNER_KEY');
    expect(script).toContain('ws://127.0.0.1:9932');
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

    const outcome = await deployAccount(bridge(), ownerKey);

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
      await expect(accountOnRecord(bridge())).rejects.toThrow('This account build speaks version 2 of its interface; this mn speaks version 1.');
    } finally {
      delete process.env.STAND_IN_DRIVER_VERSION;
    }
  });
});
