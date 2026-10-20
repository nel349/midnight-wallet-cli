// A tool call that asks for progress gets what the command's spinners say as
// progress notifications, though the command runs in --json mode. Run through
// this checkout's MCP server as a real process, with a temporary home: the
// indexer is a port nothing listens on, so nothing reaches a chain.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Progress } from '@modelcontextprotocol/sdk/types.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');

let home: string;
let client: Client;
let closedPort: number;
let aliceAddress: string;

/** A port that was just listening and now refuses connections. */
async function aClosedPort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address() as net.AddressInfo;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mn-mcp-progress-home-')));
  const env = { ...process.env, HOME: home, NO_COLOR: '1', MN_PASSPHRASE: 'correct horse battery staple' } as Record<string, string>;
  const generated = execFileSync(TSX, [path.join(REPO, 'src', 'wallet.ts'), 'wallet', 'generate', 'alice', '--network', 'undeployed', '--json'], { env, encoding: 'utf8' });
  aliceAddress = JSON.parse(generated).addresses.undeployed;
  closedPort = await aClosedPort();

  client = new Client({ name: 'mn-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: TSX, args: [path.join(REPO, 'src', 'mcp-server.ts')], env, stderr: 'ignore' }));
}, 60_000);

afterAll(async () => {
  await client?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

// An address's balance: its spinner starts before the indexer is reached.
const balanceOfAlice = () => ({
  name: 'midnight_balance',
  arguments: { address: aliceAddress, 'indexer-ws': `ws://127.0.0.1:${closedPort}/api/v4/graphql/ws` },
});

describe('progress notifications', () => {
  it('sends what the command says while it runs, in order and numbered, before its result', async () => {
    const progress: Progress[] = [];
    const result = await client.callTool(balanceOfAlice(), undefined, { onprogress: (update) => progress.push(update) });

    expect(progress[0]).toMatchObject({ progress: 1, message: 'Checking balance on undeployed...' });
    expect(progress.map((update) => update.progress)).toEqual(progress.map((_, index) => index + 1));
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ error: true, code: 'NETWORK_ERROR' });
  }, 60_000);

  it('sends none to a call that asked for none, which gets the same result', async () => {
    const result = await client.callTool(balanceOfAlice());
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ error: true, code: 'NETWORK_ERROR' });
  }, 60_000);
});
