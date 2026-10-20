// Everything `mn grant` settles before a wallet is looked at: what is asked,
// which network, where the account's records are and whether there is an
// account yet. The CLI runs it first; the MCP server runs it before it issues a
// confirmation token.

import { type ParsedArgs, getFlag } from '../argv.ts';
import { type PayingTarget, resolvePayingTarget } from '../paying-wallet.ts';
import { assertAccountNetwork, assertNodeRunsAccount } from './account.ts';
import { accountRecordsDir, accountWalletName, ensureAccountRecordsDir } from './account-records.ts';
import { type GrantRequest, resolveGrantRequest } from './request.ts';
import { contractAddressOnRecord } from './sealed-account.ts';

/** The account a wallet's records name. */
export interface AccountOnRecord {
  address: string;
}

export interface PreparedGrant {
  request: GrantRequest;
  target: PayingTarget;
  /** The name the account is kept under: the wallet's. */
  walletName: string;
  /** The account's records directory, which exists. */
  recordsDir: string;
  /** The account on record; null only for a deploy of a new one. */
  account: AccountOnRecord | null;
}

/** The wallet has no account to run an owner command on. */
export class NoAccountError extends Error {
  readonly code = 'NO_ACCOUNT';

  constructor(walletName: string, network: string) {
    super(`Wallet "${walletName}" has no account on ${network} yet.\nDeploy one: midnight grant deploy`);
    this.name = 'NoAccountError';
    Object.setPrototypeOf(this, NoAccountError.prototype);
  }
}

/** The account the records in `recordsDir` name, if any. Reads the records alone: no chain, no wallet. */
export async function accountOnRecord(recordsDir: string): Promise<AccountOnRecord | null> {
  // A sealed account keeps its address in clear beside its sealed records.
  const sealedAddress = contractAddressOnRecord(recordsDir);
  if (sealedAddress !== undefined) return { address: sealedAddress };
  const { directoryOwnerStore } = await import('@kuiralabs/midnight-account-chain/owner');
  const record = directoryOwnerStore(recordsDir).readOwner();
  return record === undefined ? null : { address: record.contractAddress };
}

export async function prepareGrant(args: ParsedArgs): Promise<PreparedGrant> {
  const request = resolveGrantRequest(args);
  assertNodeRunsAccount();
  const target = resolvePayingTarget(args, 'grant', request.subcommand);
  // Refuses a network the account can't reach before anything is created.
  assertAccountNetwork(target.networkConfig);
  const walletName = accountWalletName(getFlag(args, 'wallet'));
  const recordsDir = accountRecordsDir(target.network, walletName);
  ensureAccountRecordsDir(recordsDir);

  const account = await accountOnRecord(recordsDir);
  if (request.subcommand !== 'deploy' && account === null) {
    throw new NoAccountError(walletName, target.network);
  }
  return { request, target, walletName, recordsDir, account };
}
