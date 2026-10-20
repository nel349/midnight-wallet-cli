// grant command — the wallet owner's account, and the grants that let an agent spend from it
// Usage: midnight grant <deploy|deposit|status|list|issue|revoke|revoke-all> [options]
//
// The account's owner code is the account package mn installs
// (@kuiralabs/midnight-account-chain), called in this process. status and list
// read the account without a wallet, and so does an issue shown but not
// confirmed. The others are paid by this wallet, through its DApp connector in
// this process: no server, no port.

import { type ParsedArgs, hasFlag, getFlag } from '../lib/argv.ts';
import { UsageError } from '../lib/errors.ts';
import { ERROR_CODES, classifyError } from '../lib/exit-codes.ts';
import { type GrantAccount, openGrantAccount, ownerDeviceOf } from '../lib/grant/account.ts';
import { deployShortOfDustNote } from '../lib/grant/deploy-cost.ts';
import { type OwnerCommandOutput, grantRequestOf, grantsOf, issue, issuePreview, revoke, revokeAll, statusOf } from '../lib/grant/owner-commands.ts';
import { prepareGrant } from '../lib/grant/prepare.ts';
import { type GrantRequest, paysAFee } from '../lib/grant/request.ts';
import { writeJsonResult } from '../lib/json-output.ts';
import { type PayingWallet, assertWalletCanPay, openPayingWallet } from '../lib/paying-wallet.ts';
import { dim, yellow } from '../ui/colors.ts';
import { header, keyValue, formatNight } from '../ui/format.ts';
import { type Spinner, silentSpinner, start as startSpinner } from '../ui/spinner.ts';
import { CANCELLED_MESSAGE } from '../lib/contract/runner.ts';

const SPINNER_LABEL: Record<GrantRequest['subcommand'], string> = {
  deploy: 'Deploying the account...',
  deposit: 'Depositing into the account...',
  status: 'Reading the account...',
  list: 'Reading the grants...',
  issue: 'Reading the grant request...',
  revoke: 'Revoking the grant...',
  'revoke-all': 'Revoking every grant...',
};

function isShortOfDust(err: Error): boolean {
  const { errorCode } = classifyError(err);
  return errorCode === ERROR_CODES.DUST_REQUIRED || errorCode === ERROR_CODES.INSUFFICIENT_BALANCE;
}

/** A deposit is refused before anything is built when the wallet's synced shielded NIGHT is short: the SDK's own refusal names neither the token nor the amounts. */
function shortOfShieldedNight(held: bigint, value: bigint): UsageError {
  return new UsageError(
    `Not enough shielded NIGHT for this deposit: the wallet holds ${formatNight(held)} shielded and the deposit takes ${formatNight(value)}. `
    + 'Get shielded NIGHT into it first: midnight airdrop <amount> --shielded on a local chain, or midnight transfer <this wallet> <amount> --shielded from another wallet.',
  );
}

export default async function grantCommand(args: ParsedArgs, signal?: AbortSignal): Promise<void> {
  const { request, target, walletName, recordsDir, account } = await prepareGrant(args);
  const jsonMode = hasFlag(args, 'json');
  const walletFlag = getFlag(args, 'wallet');
  const spinnerFor = (label: string): Spinner => (jsonMode ? silentSpinner() : startSpinner(label));

  if (!jsonMode) {
    process.stderr.write('\n' + header(`Grant: ${request.subcommand}`) + '\n\n');
    process.stderr.write(keyValue('Network', target.network) + '\n');
    process.stderr.write(keyValue('Wallet', walletName) + '\n');
    if (account !== null) process.stderr.write(keyValue('Account', account.address) + '\n');
    process.stderr.write('\n');
  }

  const throwIfCancelled = (): void => {
    if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
  };
  // Reading the account or a request submits nothing: a wallet with no Dust can still do it, and none is opened.
  const funds = paysAFee(request) ? await assertWalletCanPay(target, walletFlag, spinnerFor('Checking wallet...')) : undefined;
  const paying = paysAFee(request) ? await openPayingWallet(target, walletFlag, spinnerFor('Opening the wallet...')) : undefined;
  try {
    await runOwned(request, { target, walletName, recordsDir, account, jsonMode, paying, funds, spinnerFor, throwIfCancelled });
  } finally {
    await paying?.stop();
  }
}

interface OwnedRun {
  target: Awaited<ReturnType<typeof prepareGrant>>['target'];
  walletName: string;
  recordsDir: string;
  account: Awaited<ReturnType<typeof prepareGrant>>['account'];
  jsonMode: boolean;
  paying: PayingWallet | undefined;
  funds: { dustBalance: bigint } | undefined;
  spinnerFor: (label: string) => Spinner;
  throwIfCancelled: () => void;
}

/** Runs the command on the account, with the wallet that pays (if it pays) already open. */
async function runOwned(request: GrantRequest, { target, walletName, recordsDir, account, jsonMode, paying, funds, spinnerFor, throwIfCancelled }: OwnedRun): Promise<void> {
  const spinner = spinnerFor(SPINNER_LABEL[request.subcommand]);
  // A cancel takes effect at the next step the account package reports: each
  // step it records before submitting, so stopping there is as safe as an
  // interruption, and the next run finishes what this one left.
  const owned: GrantAccount = await openGrantAccount(target.networkConfig, recordsDir, (line) => {
    spinner.update(line);
    throwIfCancelled();
  });
  // How the account's owner key and records are kept: sealed, or in plain text until `wallet protect`.
  const common = { subcommand: request.subcommand, network: target.network, wallet: walletName, ownerKey: owned.protection };

  // The wallet that pays, which a paying command opened above.
  const payingWallet = async (): Promise<PayingWallet> => {
    if (paying === undefined) throw new Error(`${request.subcommand} was prepared as a command that pays nothing`);
    throwIfCancelled();
    return paying;
  };
  // The owner's session, paid by the wallet.
  const ownerSession = async () => {
    const { connectOver, openSessionOver } = await import('@kuiralabs/midnight-account-chain/owner');
    if (account === null) throw new Error('An owner command was prepared without an account');
    const { feeWallet } = await payingWallet();
    return openSessionOver(await connectOver(owned.context, account.address, feeWallet, owned.location, async () => {}), owned.store, ownerDeviceOf(owned));
  };
  const report = (output: OwnerCommandOutput): void => {
    spinner.stop('Done');
    if (jsonMode) {
      writeJsonResult({ ...common, ...output.result });
    } else {
      process.stderr.write('\n');
      process.stdout.write(output.lines.join('\n') + '\n\n');
    }
  };

  try {
    throwIfCancelled();
    switch (request.subcommand) {
      case 'deploy': {
        const { deployOwnerAccount, freshOwnerDevice } = await import('@kuiralabs/midnight-account-chain/owner');
        const { feeWallet } = await payingWallet();
        // The device the records hold, or for a new account a key made here, on the k1 arm and
        // independent of any other (MIP-0013), kept sealed before the deploy is submitted.
        const device = () => owned.keys.read() ?? owned.keys.keep(freshOwnerDevice('k1'));
        const outcome = await deployOwnerAccount(owned.context, feeWallet, owned.store, owned.location, device);
        spinner.stop(outcome.resumed ? 'Account ready' : 'Account deployed');
        if (jsonMode) {
          writeJsonResult({ ...common, ...outcome });
        } else {
          process.stderr.write('\n' + keyValue('Account', outcome.address) + '\n');
          if (outcome.resumed) process.stderr.write(dim('  An account already on record was completed; no new one was deployed.') + '\n');
          if (outcome.setAside) process.stderr.write(dim(`  The record of an earlier deploy that never reached the chain was kept at ${outcome.setAside}`) + '\n');
          if (owned.protection === 'sealed') process.stderr.write('\n' + dim('  Its owner key was made on this machine and is kept encrypted under mn\'s passphrase.') + '\n');
          process.stderr.write(dim('  Next: midnight grant status') + '\n\n');
          process.stdout.write(outcome.address + '\n');
        }
        return;
      }
      case 'deposit': {
        const { connectOver, depositShielded } = await import('@kuiralabs/midnight-account-chain/deposit');
        if (account === null) throw new Error('A deposit was prepared without an account');
        const wallet = await payingWallet();
        const value = BigInt(request.value);
        const held = await wallet.shieldedNight();
        if (held < value) throw shortOfShieldedNight(held, value);
        const connection = await connectOver(owned.context, account.address, wallet.feeWallet, owned.location, async () => {});
        const { result } = await depositShielded(connection, value);
        const outcome = { address: account.address, value: request.value, txHash: result.public.txHash, blockHeight: Number(result.public.blockHeight) };
        spinner.stop('Deposited');
        if (jsonMode) {
          writeJsonResult({ ...common, amount: request.amount, ...outcome });
        } else {
          process.stderr.write('\n' + keyValue('Deposited', `${request.amount} NIGHT (${outcome.value} in the smallest unit, as status and --cap count)`) + '\n');
          process.stderr.write(keyValue('Block', String(outcome.blockHeight)) + '\n');
          process.stderr.write(keyValue('Transaction', outcome.txHash) + '\n');
          process.stderr.write('\n' + dim('  Next: midnight grant status') + '\n\n');
          process.stdout.write(outcome.txHash + '\n');
        }
        return;
      }
      case 'status':
      case 'list': {
        const { readOwnerView } = await import('@kuiralabs/midnight-account-chain/owner');
        const device = ownerDeviceOf(owned);
        const view = await readOwnerView(owned.context.network, owned.store, device);
        report(request.subcommand === 'status' ? statusOf(view, device.arm) : grantsOf(view, owned.context.clock()));
        return;
      }
      case 'issue': {
        const grantRequest = grantRequestOf(request.link);
        if (!request.confirmed) {
          report(issuePreview(grantRequest, request.limits, owned.context.clock()));
          return;
        }
        report(await issue(await ownerSession(), grantRequest, request.limits, owned.context.clock()));
        return;
      }
      case 'revoke':
        report(await revoke(await ownerSession(), request.target));
        return;
      case 'revoke-all':
        report(await revokeAll(await ownerSession()));
        return;
    }
  } catch (err) {
    spinner.fail(`${request.subcommand} failed`);
    // A deploy costs far more Dust than a transfer: say how much when that is what stopped it.
    if (request.subcommand === 'deploy' && funds !== undefined && err instanceof Error && isShortOfDust(err)) {
      throw new Error(`${err.message}\n\n${deployShortOfDustNote(funds.dustBalance)}`);
    }
    throw err;
  }
}
