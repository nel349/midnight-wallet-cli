// Everything `mn grant` settles before a wallet is looked at or a server
// started: what is asked, which account build, which network, where the
// account's records are and whether there is an account yet. The CLI runs it
// first; the MCP server runs it before it issues a confirmation token.

import { type ParsedArgs, getFlag } from '../argv.ts';
import { loadCliConfig } from '../cli-config.ts';
import { UsageError } from '../errors.ts';
import { type PayingTarget, resolvePayingTarget } from '../paying-wallet.ts';
import { assertNodeRunsAccountBuild, checkAccountBuild, resolveAccountBuild } from './account-build.ts';
import { accountRecordsDir, accountWalletName, ensureAccountRecordsDir } from './account-records.ts';
import { type AccountBridge, type AccountOnRecord, accountOnRecord, bridgeEnvironment } from './bridge.ts';
import { type GrantRequest, resolveGrantRequest } from './request.ts';

export interface PreparedGrant {
  request: GrantRequest;
  target: PayingTarget;
  /** The name the account is kept under: the wallet's. */
  walletName: string;
  /** The bridge to the account build, without a paying server yet. */
  bridge: AccountBridge;
  /** The account on record; null only for a deploy of a new one. */
  account: AccountOnRecord | null;
}

export const NO_DEV_OWNER_KEY =
  'A new account needs --dev-owner-key for now: its owner key will be a random development key, kept in the '
  + 'account\'s records, which the wallet\'s mnemonic can\'t recover. (A key derived from the mnemonic comes once '
  + 'wallets agree on how to derive it.)';

/** The wallet has no account to run an owner command on. */
export class NoAccountError extends Error {
  readonly code = 'NO_ACCOUNT';

  constructor(walletName: string, network: string) {
    super(`Wallet "${walletName}" has no account on ${network} yet.\nDeploy one: midnight grant deploy --dev-owner-key`);
    this.name = 'NoAccountError';
    Object.setPrototypeOf(this, NoAccountError.prototype);
  }
}

export async function prepareGrant(args: ParsedArgs): Promise<PreparedGrant> {
  const request = resolveGrantRequest(args);

  const buildDir = resolveAccountBuild(getFlag(args, 'account-build'), loadCliConfig()['account-build']);
  checkAccountBuild(buildDir);
  assertNodeRunsAccountBuild();

  const target = resolvePayingTarget(args, 'grant', request.subcommand);
  const walletName = accountWalletName(getFlag(args, 'wallet'));
  const recordsDir = accountRecordsDir(target.network, walletName);
  // Refuses a network the build can't reach before anything is created.
  bridgeEnvironment(target.networkConfig, recordsDir);
  ensureAccountRecordsDir(recordsDir);

  const bridge: AccountBridge = { buildDir, recordsDir, networkConfig: target.networkConfig };
  const account = await accountOnRecord(bridge);
  if (request.subcommand === 'deploy') {
    if (account === null && !request.devOwnerKey) throw new UsageError(NO_DEV_OWNER_KEY);
  } else if (account === null) {
    throw new NoAccountError(walletName, target.network);
  }
  return { request, target, walletName, bridge, account };
}
