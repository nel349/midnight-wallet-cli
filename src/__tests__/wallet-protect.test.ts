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
});
