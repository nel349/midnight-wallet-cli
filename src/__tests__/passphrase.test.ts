// Where mn's one passphrase comes from, and how it is held to being one: from
// MN_PASSPHRASE, else typed at a terminal without echo, else a clear refusal;
// once set, the keystore's check refuses any other passphrase, so no secret
// is ever sealed under a second one.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WrongPassphraseError } from '../lib/keystore.ts';
import {
  NoPassphraseError,
  PASSPHRASE_ENV,
  MIN_PASSPHRASE_LENGTH,
  establishPassphrase,
  isPassphraseSet,
  passphraseForNewSecret,
  readPassphrase,
  unlockPassphrase,
} from '../lib/passphrase.ts';
import { FILE_MODE } from '../lib/constants.ts';

const PASSPHRASE = 'correct horse battery staple';
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-passphrase-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

// A terminal that types `lines` and records what mn writes to it.
const terminal = (...lines: string[]) => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => { written += chunk.toString('utf8'); });
  const typeNext = (): void => { const line = lines.shift(); if (line !== undefined) input.write(`${line}\n`); };
  return { io: { env: {}, input, output, isTTY: true, typeNext }, written: () => written };
};

describe('reading the passphrase', () => {
  it('takes MN_PASSPHRASE when it is set, asking nothing', async () => {
    const value = await readPassphrase({ env: { [PASSPHRASE_ENV]: PASSPHRASE }, isTTY: false });
    expect(value).toBe(PASSPHRASE);
  });

  it('asks at a terminal, without echoing what is typed', async () => {
    const { io, written } = terminal(PASSPHRASE);
    const reading = readPassphrase(io);
    io.typeNext();
    expect(await reading).toBe(PASSPHRASE);
    expect(written()).toContain('Passphrase');
    expect(written()).not.toContain(PASSPHRASE);
  });

  it('asks twice when setting it, and refuses two that differ', async () => {
    const { io } = terminal(PASSPHRASE, 'something else');
    const reading = readPassphrase({ ...io, confirm: true });
    io.typeNext();
    setTimeout(io.typeNext, 10);
    await expect(reading).rejects.toThrow(/do not match/);
  });

  it('refuses where it can neither read the variable nor ask', async () => {
    await expect(readPassphrase({ env: {}, isTTY: false })).rejects.toThrow(NoPassphraseError);
  });
});

describe('the one passphrase', () => {
  it('is set once, in an owner-only file, and then known to be set', () => {
    expect(isPassphraseSet(home)).toBe(false);
    establishPassphrase(home, PASSPHRASE);
    expect(isPassphraseSet(home)).toBe(true);
    const marker = fs.readdirSync(path.join(home, '.midnight')).find((name) => name.startsWith('keystore'));
    expect(marker).toBeDefined();
    expect(fs.statSync(path.join(home, '.midnight', marker as string)).mode & 0o777).toBe(FILE_MODE);
  });

  it('unlocks with the passphrase it was set with', async () => {
    establishPassphrase(home, PASSPHRASE);
    expect(await unlockPassphrase(home, { env: { [PASSPHRASE_ENV]: PASSPHRASE }, isTTY: false })).toBe(PASSPHRASE);
  });

  it('refuses any other passphrase once set', async () => {
    establishPassphrase(home, PASSPHRASE);
    await expect(unlockPassphrase(home, { env: { [PASSPHRASE_ENV]: 'another one' }, isTTY: false })).rejects.toThrow(WrongPassphraseError);
  });

  it('checks a changed MN_PASSPHRASE afresh, never taking the one checked before', async () => {
    establishPassphrase(home, PASSPHRASE);
    await unlockPassphrase(home, { env: { [PASSPHRASE_ENV]: PASSPHRASE }, isTTY: false });
    await expect(unlockPassphrase(home, { env: { [PASSPHRASE_ENV]: 'another one' }, isTTY: false })).rejects.toThrow(WrongPassphraseError);
  });

  it('is not set a second time over the first', () => {
    establishPassphrase(home, PASSPHRASE);
    expect(() => establishPassphrase(home, 'another one')).toThrow(/already set/);
  });
});

describe('a new secret', () => {
  it('sets the passphrase on a machine with none, and is sealed under it', async () => {
    const passphrase = await passphraseForNewSecret(home, { env: { [PASSPHRASE_ENV]: PASSPHRASE }, isTTY: false });
    expect(passphrase).toBe(PASSPHRASE);
    expect(isPassphraseSet(home)).toBe(true);
  });

  it(`refuses a new passphrase shorter than ${MIN_PASSPHRASE_LENGTH} characters, setting nothing`, async () => {
    await expect(passphraseForNewSecret(home, { env: { [PASSPHRASE_ENV]: 'too short' }, isTTY: false })).rejects.toThrow(/at least/);
    expect(isPassphraseSet(home)).toBe(false);
  });

  it('takes the passphrase already set, and no other', async () => {
    establishPassphrase(home, PASSPHRASE);
    await expect(passphraseForNewSecret(home, { env: { [PASSPHRASE_ENV]: 'another passphrase' }, isTTY: false })).rejects.toThrow(WrongPassphraseError);
  });
});

