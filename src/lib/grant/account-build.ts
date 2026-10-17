// The account build `mn grant` drives: a local directory holding the account
// owner's code and its compiled contract. mn copies nothing from it. It runs a
// small script inside it, which imports the build's one module for outside
// callers and gives it a wallet backed by mn serve.

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { UsageError } from '../errors.ts';

/** The module of the build that mn imports. */
export const ACCOUNT_BUILD_ENTRY = 'driver.ts';

/** The version of that module's interface this mn speaks. */
export const ACCOUNT_DRIVER_VERSION = 2;

/** The build is TypeScript, which Node.js runs as it is from this version. */
export const MIN_NODE_FOR_ACCOUNT_BUILD = '22.18.0';

/**
 * The account build's directory: --account-build, else the `account-build`
 * config key. Throws, saying how to name one, when neither is given.
 */
export function resolveAccountBuild(flag: string | undefined, configured: string | undefined): string {
  const given = flag ?? configured;
  if (given === undefined || given.trim() === '') {
    throw new UsageError(
      'No account build named. Give the directory of the account build with --account-build <dir>, '
      + 'or once with: midnight config set account-build <dir>',
    );
  }
  return resolve(given);
}

/**
 * The directory is an account build mn can drive: it has the module mn
 * imports and its dependencies are installed. Throws, saying what is missing.
 */
export function checkAccountBuild(dir: string): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new UsageError(`The account build ${dir} is not a directory.`);
  }
  if (!existsSync(join(dir, ACCOUNT_BUILD_ENTRY))) {
    throw new UsageError(
      `${dir} is not an account build mn can drive: it has no ${ACCOUNT_BUILD_ENTRY}. `
      + 'Point --account-build at the directory that holds it (an older build has none: update it).',
    );
  }
  if (!existsSync(join(dir, 'node_modules'))) {
    throw new UsageError(`The account build ${dir} has no node_modules: install its dependencies there first (npm install).`);
  }
}

/** This Node.js can't run the build's TypeScript as it is. */
export class NodeTooOldForAccountBuildError extends Error {
  readonly code = 'UNSUPPORTED_NODE';

  constructor(version: string) {
    super(
      `mn grant runs the account build's TypeScript directly, which needs Node.js ${MIN_NODE_FOR_ACCOUNT_BUILD} or newer; this is Node.js ${version}. `
      + 'Install a current Node.js (https://nodejs.org) and run the command again.',
    );
    this.name = 'NodeTooOldForAccountBuildError';
    Object.setPrototypeOf(this, NodeTooOldForAccountBuildError.prototype);
  }
}

/** Throws when this Node.js can't run the build's TypeScript as it is. */
export function assertNodeRunsAccountBuild(version: string = process.versions.node): void {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const [needMajor = 0, needMinor = 0] = MIN_NODE_FOR_ACCOUNT_BUILD.split('.').map(Number);
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return;
  throw new NodeTooOldForAccountBuildError(version);
}
