// A tool that moves funds answers its first call with a confirmation token and
// does nothing else. Run through this checkout's MCP server as a real process,
// with a temporary home and the stand-in account build: nothing reaches a chain.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { STAND_IN_ACCOUNT, createStandInAccountBuild } from './helpers/stand-in-account-build.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const ENDPOINTS = { node: 'ws://localhost:29944', 'indexer-ws': 'ws://localhost:28088/api/v4/graphql/ws', 'proof-server': 'http://localhost:26300' };

let home: string;
let buildDir: string;
let recordsDir: string;
let client: Client;

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-mcp-confirm-home-')));
  const env = { ...process.env, HOME: home, NO_COLOR: '1' } as Record<string, string>;
  execFileSync(TSX, [path.join(REPO, 'src', 'wallet.ts'), 'wallet', 'generate', 'alice', '--json'], { env, stdio: 'ignore' });
  buildDir = createStandInAccountBuild();
  // An account on record for alice, as the stand-in build reads it.
  recordsDir = path.join(home, '.midnight', 'accounts', 'undeployed', 'alice');
  fs.mkdirSync(recordsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(recordsDir, 'account.json'), JSON.stringify(STAND_IN_ACCOUNT));

  client = new Client({ name: 'mn-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: TSX, args: [path.join(REPO, 'src', 'mcp-server.ts')], env, stderr: 'ignore' }));
}, 60_000);

afterAll(async () => {
  await client?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(buildDir, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
};

describe('midnight_grant_deposit', () => {
  it('answers with a token whose description names the amount in both units and the account, and deposits nothing', async () => {
    const pending = await call('midnight_grant_deposit', { amount: '1.5', wallet: 'alice', 'account-build': buildDir, network: 'undeployed', ...ENDPOINTS });

    expect(pending.pending).toBe(true);
    expect(pending.token).toEqual(expect.any(String));
    expect(pending.tool).toBe('midnight_grant_deposit');
    expect(pending.description).toBe(`Deposit 1.5 shielded NIGHT (1500000 in the smallest unit) from wallet alice into its account ${STAND_IN_ACCOUNT.address} on undeployed`);
    // The stand-in build writes deposit.json when its deposit is called: it never was.
    expect(fs.existsSync(path.join(recordsDir, 'deposit.json'))).toBe(false);
  }, 60_000);

  it('refuses a deposit that can\'t run before any token is given', async () => {
    const refused = await call('midnight_grant_deposit', { amount: '1.0000001', wallet: 'alice', 'account-build': buildDir, network: 'undeployed', ...ENDPOINTS });
    expect(refused).toMatchObject({ error: true, code: 'INVALID_ARGS' });
    expect(refused.token).toBeUndefined();
  }, 60_000);
});
