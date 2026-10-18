// The account build `mn grant` drives: the account owner's code and its
// compiled contract. By default it is the account package mn depends on,
// @kuiralabs/midnight-account-chain; --account-build (or the account-build
// config key) names a local checkout instead, run as TypeScript. mn copies
// nothing from either. It runs a small script that imports the build's one
// module for outside callers and gives it a wallet backed by mn serve.

import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MIDNIGHT_DIR } from '../constants.ts';
import { UsageError } from '../errors.ts';

/** The module of a local build that mn imports. */
export const ACCOUNT_BUILD_ENTRY = 'driver.ts';

/** The account package mn drives when no local build is named, and its module for outside callers. */
export const ACCOUNT_PACKAGE = '@kuiralabs/midnight-account-chain';
const ACCOUNT_PACKAGE_DRIVER = `${ACCOUNT_PACKAGE}/driver`;

/** What the script imports beside the driver: midnight-js's provider interfaces, for the paying wallet, and the WebSocket client it reaches mn serve with. */
const MIDNIGHT_JS_TYPES = '@midnight-ntwrk/midnight-js-types';
const WEBSOCKET_CLIENT = 'ws';

/** The version of the build's interface this mn speaks. */
export const ACCOUNT_DRIVER_VERSION = 4;

/** The build needs Node.js from this version: a local one is TypeScript, which Node.js runs as it is from here. */
export const MIN_NODE_FOR_ACCOUNT_BUILD = '22.18.0';

/** Where the package's proving artefacts are cached, under ~/.midnight: each file is fetched the first time a command proves with it. */
const ACCOUNT_ARTIFACTS_DIR_NAME = 'account-artifacts';

export type AccountBuild =
  /** The installed account package: its driver and the midnight-js-types it uses, and mn's ws, as file URLs. */
  | { kind: 'package'; driverUrl: string; typesUrl: string; wsUrl: string }
  /** A local checkout, named by --account-build or the account-build config key. */
  | { kind: 'directory'; dir: string };

/** The installed account package, resolved from mn's own dependencies. */
export function installedAccountPackage(from: string = import.meta.url): AccountBuild {
  const require = createRequire(from);
  const driver = require.resolve(ACCOUNT_PACKAGE_DRIVER);
  return {
    kind: 'package',
    driverUrl: pathToFileURL(driver).href,
    // The package's own copy, the one its midnight-js reads the wallet with.
    typesUrl: pathToFileURL(createRequire(driver).resolve(MIDNIGHT_JS_TYPES)).href,
    wsUrl: pathToFileURL(require.resolve(WEBSOCKET_CLIENT)).href,
  };
}

/**
 * The account build: the directory --account-build names, else the one the
 * `account-build` config key names, else the installed account package.
 */
export function resolveAccountBuild(flag: string | undefined, configured: string | undefined, installed: () => AccountBuild = installedAccountPackage): AccountBuild {
  const given = [flag, configured].find((value) => value !== undefined && value.trim() !== '');
  return given === undefined ? installed() : { kind: 'directory', dir: resolve(given) };
}

/** Where the account package caches its proving artefacts. */
export function accountArtifactsDir(home: string = homedir()): string {
  return join(home, MIDNIGHT_DIR, ACCOUNT_ARTIFACTS_DIR_NAME);
}

/**
 * A local build is one mn can drive: it has the module mn imports and its
 * dependencies are installed. Throws, saying what is missing. The installed
 * package needs no check: mn's own install resolved it.
 */
export function checkAccountBuild(build: AccountBuild): void {
  if (build.kind === 'package') return;
  const { dir } = build;
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

/** This Node.js is older than the account build needs. */
export class NodeTooOldForAccountBuildError extends Error {
  readonly code = 'UNSUPPORTED_NODE';

  constructor(version: string) {
    super(
      `mn grant runs the account build, which needs Node.js ${MIN_NODE_FOR_ACCOUNT_BUILD} or newer (a local build runs as TypeScript); this is Node.js ${version}. `
      + 'Install a current Node.js (https://nodejs.org) and run the command again.',
    );
    this.name = 'NodeTooOldForAccountBuildError';
    Object.setPrototypeOf(this, NodeTooOldForAccountBuildError.prototype);
  }
}

/** Throws when this Node.js is older than the account build needs. */
export function assertNodeRunsAccountBuild(version: string = process.versions.node): void {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const [needMajor = 0, needMinor = 0] = MIN_NODE_FOR_ACCOUNT_BUILD.split('.').map(Number);
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return;
  throw new NodeTooOldForAccountBuildError(version);
}
