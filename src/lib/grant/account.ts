// What `mn grant` gives the account package (@kuiralabs/midnight-account-chain),
// which it calls in its own process: the network it acts on, where the proving
// keys are cached, its progress, and the account's records, device key and
// private state, all in the account's records directory.
//
// The records are where every account so far keeps them, so an account made by
// an earlier mn opens unchanged: owner.json (the account's records and its
// owner key) and roster.json, with the private state in the directory's
// midnight-level-db under the store name and password it was first made with.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { artefactCache } from '@kuiralabs/midnight-account-chain/artefacts';
import { type AccountContext, type ProgressEvent, accountContext, describeProgress, networkOf } from '@kuiralabs/midnight-account-chain/context';
import {
  type DirectoryDeviceKeys,
  type OwnerDevice,
  type OwnerStore,
  type PrivateStateLocation,
  directoryDeviceKeys,
  directoryOwnerStore,
} from '@kuiralabs/midnight-account-chain/owner';
import { MIDNIGHT_DIR } from '../constants.ts';
import { UsageError } from '../errors.ts';
import type { NetworkConfig } from '../network.ts';

/** Where the account package caches its proving artefacts, under ~/.midnight: each file is fetched the first time a command proves with it. */
const ACCOUNT_ARTIFACTS_DIR_NAME = 'account-artifacts';

export function accountArtifactsDir(home: string = homedir()): string {
  return join(home, MIDNIGHT_DIR, ACCOUNT_ARTIFACTS_DIR_NAME);
}

/** The network the account package acts on: ledger 9, which only a local network runs so far. */
const ACCOUNT_NETWORK_ID = 'undeployed';

/** The private state's database, store and password, as every account so far was made with them. */
const PRIVATE_STATE_DATABASE = 'midnight-level-db';
const PRIVATE_STATE_STORE = 'midnight-bench-account';
// The password the account package encrypted every account's private state
// with until it took one from its caller: testkit-js's own, public in its
// source. It stays so those stores are read back; it protects nothing a
// reader of this machine's files couldn't read.
const LEGACY_STORE_PASSWORD = 'Answer to the Ultimate Question of Life, the Universe, and Everything!';

/** A network the account package can't reach yet. */
export class UnreachableByAccountError extends UsageError {
  constructor(networkId: string) {
    super(`mn grant runs on ledger 9, which only a local network (undeployed) runs so far; ${networkId} is not one.`);
    this.name = 'UnreachableByAccountError';
    Object.setPrototypeOf(this, UnreachableByAccountError.prototype);
  }
}

/** Throws when the account package can't act on `networkConfig`'s network. */
export function assertAccountNetwork(networkConfig: NetworkConfig): void {
  if (networkConfig.networkId.toLowerCase() !== ACCOUNT_NETWORK_ID) throw new UnreachableByAccountError(networkConfig.networkId);
}

/** The Node.js the account package needs: it declares 22.18 or newer. */
export const MIN_NODE_FOR_ACCOUNT = '22.18.0';

/** This Node.js is older than the account package needs. */
export class NodeTooOldForAccountError extends Error {
  readonly code = 'UNSUPPORTED_NODE';

  constructor(version: string) {
    super(`mn grant runs the account package, which needs Node.js ${MIN_NODE_FOR_ACCOUNT} or newer; this is Node.js ${version}. Install a current Node.js (https://nodejs.org) and run the command again.`);
    this.name = 'NodeTooOldForAccountError';
    Object.setPrototypeOf(this, NodeTooOldForAccountError.prototype);
  }
}

/** Throws when this Node.js is older than the account package needs. */
export function assertNodeRunsAccount(version: string = process.versions.node): void {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const [needMajor = 0, needMinor = 0] = MIN_NODE_FOR_ACCOUNT.split('.').map(Number);
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return;
  throw new NodeTooOldForAccountError(version);
}

/** The node's http(s) form: mn keeps it as the WebSocket URL its wallet connects to. */
const httpOf = (url: string): string => url.replace(/^ws/, 'http');

/** Everything the account package needs to act on one wallet's account. */
export interface GrantAccount {
  context: AccountContext;
  store: OwnerStore;
  keys: DirectoryDeviceKeys;
  location: PrivateStateLocation;
}

/** The account in `recordsDir` on `networkConfig`'s network, its progress said through `say`. */
export function grantAccount(networkConfig: NetworkConfig, recordsDir: string, say: (line: string) => void): GrantAccount {
  assertAccountNetwork(networkConfig);
  const progress = (event: ProgressEvent): void => say(describeProgress(event).trim());
  const network = networkOf({ networkId: ACCOUNT_NETWORK_ID, node: httpOf(networkConfig.node), indexer: networkConfig.indexer, proofServer: networkConfig.proofServer });
  return {
    context: accountContext({ network, artefacts: artefactCache(accountArtifactsDir(), { progress }), progress }),
    store: directoryOwnerStore(recordsDir),
    keys: directoryDeviceKeys(recordsDir),
    location: { database: join(recordsDir, PRIVATE_STATE_DATABASE), store: PRIVATE_STATE_STORE, password: () => LEGACY_STORE_PASSWORD },
  };
}

/** The account's owner device, which its records hold. */
export function ownerDeviceOf(account: GrantAccount): OwnerDevice {
  const device = account.keys.read();
  if (device === undefined) throw new Error('The account\'s records hold no owner key.');
  return device;
}
