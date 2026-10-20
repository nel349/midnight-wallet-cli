// mn's one passphrase: where it comes from, and the keystore's check that
// holds it to being one. It comes from MN_PASSPHRASE (scripts, the MCP
// server, CI; kept off the process list), else it is typed at a terminal with
// nothing echoed, else the command is refused before it changes anything.
// The check is a known value sealed under the passphrase in ~/.midnight: once
// it is there, every other passphrase is refused, so no secret is ever sealed
// under a second one.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { DIR_MODE, FILE_MODE, MIDNIGHT_DIR } from './constants.ts';
import { UsageError } from './errors.ts';
import { openSecret, sealSecret } from './keystore.ts';

/** The variable a non-interactive run sets the passphrase in. */
export const PASSPHRASE_ENV = 'MN_PASSPHRASE';

/** Where the keystore's check of the passphrase is kept, under ~/.midnight. */
const KEYSTORE_FILENAME = 'keystore.json';
/** The value the check seals: opening it proves the passphrase. */
const CHECK_VALUE = Buffer.from('mn keystore: the one passphrase', 'utf8');

/** No passphrase can be had: not in the environment, and no terminal to ask at. */
export class NoPassphraseError extends UsageError {
  readonly code = 'PASSPHRASE_REQUIRED';

  constructor() {
    super(`This needs mn's passphrase. Set ${PASSPHRASE_ENV}, or run it at a terminal to be asked for it.`);
    this.name = 'NoPassphraseError';
    Object.setPrototypeOf(this, NoPassphraseError.prototype);
  }
}

/** Where the passphrase is read from: the environment, and a terminal if there is one. */
export interface PassphraseSource {
  env?: Record<string, string | undefined>;
  input?: Readable & { setRawMode?: (mode: boolean) => unknown };
  output?: Writable;
  isTTY?: boolean;
  /** Ask twice and refuse two that differ: for setting the passphrase. */
  confirm?: boolean;
}

const keystorePath = (home: string): string => path.join(home, MIDNIGHT_DIR, KEYSTORE_FILENAME);

// One line from `input`. A real terminal is put in raw mode so nothing typed is
// echoed; the line ends at Enter, and Ctrl-C refuses.
const hiddenLine = (input: NonNullable<PassphraseSource['input']>): Promise<string> =>
  new Promise((resolve, reject) => {
    if (typeof input.setRawMode === 'function') {
      let typed = '';
      const onData = (chunk: Buffer): void => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\r' || char === '\n') { finish(); resolve(typed); return; }
          if (char === '\u0003') { finish(); reject(new UsageError('Cancelled.')); return; }
          if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1);
          else typed += char;
        }
      };
      const finish = (): void => {
        input.removeListener('data', onData);
        input.setRawMode?.(false);
        input.pause();
      };
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
      return;
    }
    const lines = createInterface({ input, terminal: false });
    lines.once('line', (line) => { resolve(line); lines.close(); });
    lines.once('close', () => reject(new NoPassphraseError()));
  });

const ask = async (source: PassphraseSource, prompt: string): Promise<string> => {
  const output = source.output ?? process.stderr;
  output.write(prompt);
  const line = await hiddenLine(source.input ?? process.stdin);
  output.write('\n');
  return line;
};

/** The passphrase: from MN_PASSPHRASE, else asked for at the terminal. */
export async function readPassphrase(source: PassphraseSource = {}): Promise<string> {
  const fromEnv = (source.env ?? process.env)[PASSPHRASE_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  if (!(source.isTTY ?? process.stdin.isTTY === true)) throw new NoPassphraseError();
  const passphrase = await ask(source, source.confirm ? 'New passphrase for mn: ' : 'Passphrase for mn: ');
  if (source.confirm) {
    const again = await ask(source, 'Passphrase again: ');
    if (again !== passphrase) throw new UsageError('The two passphrases do not match.');
  }
  return passphrase;
}

/** True once mn's passphrase is set on this machine. */
export function isPassphraseSet(home: string): boolean {
  return fs.existsSync(keystorePath(home));
}

/** Sets mn's one passphrase. Refused when one is set already. */
export function establishPassphrase(home: string, passphrase: string): void {
  const file = keystorePath(home);
  if (fs.existsSync(file)) throw new UsageError(`mn's passphrase is already set (${file}).`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
  // `wx`: never over a check another process wrote meanwhile.
  fs.writeFileSync(file, JSON.stringify({ check: sealSecret(CHECK_VALUE, passphrase, 'keystore-check') }, null, 2) + '\n', { mode: FILE_MODE, flag: 'wx' });
}

/** Refuses `passphrase` unless it is the one set. */
export function checkPassphrase(home: string, passphrase: string): void {
  const { check } = JSON.parse(fs.readFileSync(keystorePath(home), 'utf8')) as { check: unknown };
  openSecret(check, passphrase, 'keystore-check');
}

/** The shortest passphrase mn accepts when one is set. */
export const MIN_PASSPHRASE_LENGTH = 12;

// The passphrase this process has unlocked, by home: one prompt per run.
const unlocked = new Map<string, string>();

/**
 * mn's passphrase, read and checked against the one set; asked for once per
 * run. One already checked is taken again only when the environment names no
 * other: a changed MN_PASSPHRASE is checked afresh.
 */
export async function unlockPassphrase(home: string, source: PassphraseSource = {}): Promise<string> {
  const known = unlocked.get(home);
  const fromEnv = (source.env ?? process.env)[PASSPHRASE_ENV];
  if (known !== undefined && (fromEnv === undefined || fromEnv === '' || fromEnv === known)) return known;
  if (!isPassphraseSet(home)) throw new UsageError('mn has no passphrase yet. Set one with: midnight wallet protect');
  const passphrase = await readPassphrase(source);
  checkPassphrase(home, passphrase);
  unlocked.set(home, passphrase);
  return passphrase;
}

/**
 * The passphrase to seal a new secret under: the one set, or, on a machine
 * with none yet, a new one (asked twice at a terminal), which is then set.
 */
export async function passphraseForNewSecret(home: string, source: PassphraseSource = {}): Promise<string> {
  if (isPassphraseSet(home)) return unlockPassphrase(home, source);
  const passphrase = await readPassphrase({ ...source, confirm: true });
  if ([...passphrase].length < MIN_PASSPHRASE_LENGTH) {
    throw new UsageError(`mn's passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  establishPassphrase(home, passphrase);
  unlocked.set(home, passphrase);
  return passphrase;
}
