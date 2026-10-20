// A file holding a secret is written whole or not at all, and survives a
// crash once written: a temporary file of its own, synced, renamed over the
// file, then the directory synced so the rename itself is on disk. Owner-only,
// in an owner-only directory.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DIR_MODE, FILE_MODE } from './constants.ts';

const TEMPORARY_ID_BYTES = 8;

/** The file already exists, and was not to be written over. */
export class FileExistsError extends Error {
  constructor(file: string) {
    super(`${file} already exists.`);
    this.name = 'FileExistsError';
    Object.setPrototypeOf(this, FileExistsError.prototype);
  }
}

/** Writes `value` to `file` as JSON, durably. With `exclusive`, refuses a file that exists. */
export function writeJsonDurably(file: string, value: unknown, { exclusive = false }: { exclusive?: boolean } = {}): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if (exclusive && fs.existsSync(file)) throw new FileExistsError(file);
  const temporary = `${file}.${process.pid}.${randomBytes(TEMPORARY_ID_BYTES).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', FILE_MODE);
    try {
      fs.writeSync(fd, JSON.stringify(value, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (exclusive) {
      // A link fails if the file appeared meanwhile, where a rename would replace it.
      fs.linkSync(temporary, file);
      fs.unlinkSync(temporary);
    } else {
      fs.renameSync(temporary, file);
    }
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (exclusive && (error as NodeJS.ErrnoException).code === 'EEXIST') throw new FileExistsError(file);
    throw error;
  }
  const dirFd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

/** Reads `file` as JSON, or undefined when there is none. */
export function readJsonIfPresent<T>(file: string): T | undefined {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : undefined;
}
