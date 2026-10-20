// `midnight wallet protect`: sets mn's passphrase on a machine with none and
// seals every plain-text wallet under it, saying which it sealed; run again,
// it seals nothing new; with another passphrase than the one set, it changes
// nothing.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import walletCommand from '../commands/wallet.ts';
import { parseArgs } from '../lib/argv.ts';
import { PASSPHRASE_ENV, isPassphraseSet } from '../lib/passphrase.ts';
import { loadWalletConfig } from '../lib/wallet-config.ts';
import { deriveAllAddresses } from '../lib/derive-address.ts';
import { captureOutput, type CapturedOutput } from './helpers/capture-output.ts';
import { saveWalletConfig } from './helpers/plain-wallet.ts';

const PASSPHRASE = 'correct horse battery staple';
const SEED = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
const ORIGINAL_HOME = process.env.HOME;
let home: string;
let io: CapturedOutput;

const plainWallet = (name: string): string =>
  saveWalletConfig({ seed: SEED, addresses: deriveAllAddresses(Buffer.from(SEED, 'hex')), createdAt: '2026-10-19T00:00:00.000Z' }, path.join(home, '.midnight', 'wallets', `${name}.json`));

const protect = async (): Promise<Record<string, unknown>> => {
  io.restore();
  io = captureOutput();
  await walletCommand(parseArgs(['wallet', 'protect', '--json']));
  return JSON.parse(io.stdout()) as Record<string, unknown>;
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-wallet-protect-'));
  process.env.HOME = home;
  process.env[PASSPHRASE_ENV] = PASSPHRASE;
  io = captureOutput();
});
afterEach(() => {
  io.restore();
  process.env.HOME = ORIGINAL_HOME;
  delete process.env[PASSPHRASE_ENV];
  fs.rmSync(home, { recursive: true, force: true });
});

describe('wallet protect', () => {
  it('sets the passphrase and seals every plain-text wallet, naming each', async () => {
    const alice = plainWallet('alice');
    plainWallet('bob');
    const result = await protect();
    expect(isPassphraseSet(home)).toBe(true);
    expect(result).toMatchObject({ sealed: ['alice', 'bob'], alreadySealed: [] });
    expect(loadWalletConfig(alice).isSealed).toBe(true);
    expect(fs.readFileSync(alice, 'utf8')).not.toContain(SEED);
  });

  it('seals nothing new when run again', async () => {
    plainWallet('alice');
    await protect();
    expect(await protect()).toMatchObject({ sealed: [], alreadySealed: ['alice'] });
  });

  it('changes nothing with a passphrase other than the one set', async () => {
    plainWallet('alice');
    await protect();
    const bob = plainWallet('bob');
    process.env[PASSPHRASE_ENV] = 'another passphrase entirely';
    await expect(protect()).rejects.toThrow(/Wrong passphrase/);
    expect(loadWalletConfig(bob).isSealed).toBe(false);
  });

  it("seals each wallet's plain-text account too, and names one whose wallet is gone", async () => {
    plainWallet('alice');
    const accounts = path.join(home, '.midnight', 'accounts', 'undeployed');
    for (const name of ['alice', 'gone']) {
      fs.mkdirSync(path.join(accounts, name), { recursive: true });
      fs.writeFileSync(path.join(accounts, name, 'owner.json'), JSON.stringify({ contractAddress: '5e'.repeat(32), bootSalt: '3a'.repeat(32), encryptionSecret: '2b'.repeat(32), deviceArm: 'k1', deviceSk: '4f'.repeat(32) }));
    }
    const result = await protect();
    expect(result.accounts).toEqual([
      { network: 'undeployed', wallet: 'alice', outcome: 'sealed-now' },
      { network: 'undeployed', wallet: 'gone', error: expect.stringContaining('not found') },
    ]);
    expect(fs.readFileSync(path.join(accounts, 'gone', 'owner.json'), 'utf8')).toContain('4f'.repeat(32));
    expect(fs.existsSync(path.join(accounts, 'alice', 'owner.json'))).toBe(false);
  });

  it('passes over an empty account folder, which an earlier mn left for a command that failed', async () => {
    plainWallet('alice');
    fs.mkdirSync(path.join(home, '.midnight', 'accounts', 'undeployed', 'never'), { recursive: true });
    const result = await protect();
    expect(result.accounts).toEqual([]);
  });
});
