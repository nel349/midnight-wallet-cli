// A transfer's arguments are checked from the wallet files and the address
// encoding alone: no wallet starts and no network is reached. HOME points at a
// temporary directory so wallet names resolve to files made here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveTransferRequest } from '../lib/transfer-request.ts';
import { parseArgs } from '../lib/argv.ts';
import { saveWalletConfig } from '../lib/wallet-config.ts';
import { deriveAllAddresses, deriveAllShieldedAddresses } from '../lib/derive-address.ts';
import { MIDNIGHT_DIR, WALLETS_DIR_NAME } from '../lib/constants.ts';
import { UsageError } from '../lib/errors.ts';
import { classifyError } from '../lib/exit-codes.ts';

const HOME = path.join(os.tmpdir(), `midnight-transfer-request-test-${process.pid}`);
const WALLETS = path.join(HOME, MIDNIGHT_DIR, WALLETS_DIR_NAME);
const SENDER_SEED = Buffer.from('00'.repeat(31) + '11', 'hex');
const RECIPIENT_SEED = Buffer.from('00'.repeat(31) + '22', 'hex');
const RECIPIENT = deriveAllAddresses(RECIPIENT_SEED);
const RECIPIENT_SHIELDED = deriveAllShieldedAddresses(RECIPIENT_SEED);

let origHome: string | undefined;

function saveWallet(name: string, seed: Buffer, shielded = false): string {
  const file = path.join(WALLETS, `${name}.json`);
  saveWalletConfig({
    seed: seed.toString('hex'),
    addresses: deriveAllAddresses(seed),
    ...(shielded ? { shieldedAddresses: deriveAllShieldedAddresses(seed) } : {}),
    createdAt: new Date(0).toISOString(),
  }, file);
  return file;
}

const request = (...argv: string[]) => resolveTransferRequest(parseArgs(['transfer', ...argv]));

beforeEach(() => {
  origHome = process.env.HOME;
  process.env.HOME = HOME;
  fs.mkdirSync(WALLETS, { recursive: true });
  saveWallet('sender', SENDER_SEED);
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('resolveTransferRequest', () => {
  it('takes an address and an amount, on the network asked for', () => {
    const r = request(RECIPIENT.preprod, '1.5', '--wallet', 'sender', '--network', 'preprod');
    expect(r).toMatchObject({ recipientAddress: RECIPIENT.preprod, amountNight: 1.5, shielded: false, networkName: 'preprod' });
    expect(r.walletPath).toBe(path.join(WALLETS, 'sender.json'));
    expect(r.walletConfig.seed).toBe(SENDER_SEED.toString('hex'));
  });

  it('resolves a wallet name given as the recipient to that wallet\'s address on the network', () => {
    saveWallet('bob', RECIPIENT_SEED, true);
    expect(request('bob', '2', '--wallet', 'sender').recipientAddress).toBe(RECIPIENT.undeployed);
    expect(request('bob', '2', '--wallet', 'sender', '--shielded').recipientAddress).toBe(RECIPIENT_SHIELDED.undeployed);
  });

  it.each([
    [[], 'Missing recipient address'],
    [[RECIPIENT.undeployed], 'Missing amount'],
    [[RECIPIENT.undeployed, '0'], 'Invalid amount: "0" — must be greater than 0'],
    [[RECIPIENT.undeployed, '-5'], 'Invalid amount: "-5"'],
    [[RECIPIENT.undeployed, '1.1234567'], 'NIGHT has 6 decimals'],
    [['nobody', '1'], 'Wallet file not found'],
    [['mn_addr_undeployed1notanaddress', '1'], 'Invalid recipient address'],
    [[RECIPIENT.preprod, '1'], 'Expected a bech32m address (mn_addr_...) for network "undeployed"'],
    [[RECIPIENT_SHIELDED.undeployed, '1'], 'Invalid recipient address'],
    [[RECIPIENT.undeployed, '1', '--shielded'], 'Invalid shielded address'],
    [[RECIPIENT.undeployed, '1', '--wallet', 'nosuchsender'], 'Wallet file not found'],
  ])('refuses %j', (argv, message) => {
    expect(() => request(...argv, ...(argv.includes('--wallet') ? [] : ['--wallet', 'sender']))).toThrow(message);
  });

  it.each([
    [[RECIPIENT.undeployed]],
    [[RECIPIENT.undeployed, 'ten']],
    [['mn_addr_undeployed1notanaddress', '1']],
    [[RECIPIENT.preprod, '1']],
  ])('refuses %j as a usage mistake, which an agent sees as INVALID_ARGS', (argv) => {
    let err: unknown;
    try { request(...argv, '--wallet', 'sender'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UsageError);
    expect(classifyError(err as Error).errorCode).toBe('INVALID_ARGS');
  });

  it('refuses a shielded transfer where shielded is off before reading the address', () => {
    expect(() => request('mn_shield-addr_preprod1garbage', '1', '--wallet', 'sender', '--shielded', '--network', 'preprod'))
      .toThrow(/Shielded is unavailable on preprod/);
  });
});
