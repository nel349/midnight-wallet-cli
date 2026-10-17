// grant command — the wallet owner's account, and the grants that let an agent spend from it
// Usage: midnight grant <deploy|deposit|status|list|issue|revoke|revoke-all> [options]
//
// The account's owner code is the account package mn installs
// (@kuiralabs/midnight-account-chain), or a local build named with
// --account-build; mn runs its commands with this wallet paying the fees
// through mn serve.

import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { UsageError } from '../lib/errors.ts';
import { ERROR_CODES, classifyError } from '../lib/exit-codes.ts';
import { type AccountBridge, deployAccount, depositIntoAccount, newDevelopmentOwnerKey, runOwnerCommand } from '../lib/grant/bridge.ts';
import { deployShortOfDustNote } from '../lib/grant/deploy-cost.ts';
import { prepareGrant } from '../lib/grant/prepare.ts';
import { type GrantRequest, ownerArguments, paysAFee } from '../lib/grant/request.ts';
import { writeJsonResult } from '../lib/json-output.ts';
import { assertWalletCanPay, openPayingServe } from '../lib/paying-wallet.ts';
import { dim, yellow } from '../ui/colors.ts';
import { header, keyValue } from '../ui/format.ts';
import { silentSpinner, start as startSpinner } from '../ui/spinner.ts';

/** Said with every result: until wallets agree on how to derive an owner key, the account's key is a random one. */
const DEVELOPMENT_KEY_NOTE =
  'This account is on a development owner key, kept in its records: the wallet\'s mnemonic can\'t recover it.';

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

export default async function grantCommand(args: ParsedArgs, _signal?: AbortSignal): Promise<void> {
  const { request, target, walletName, bridge, account } = await prepareGrant(args);
  const jsonMode = hasFlag(args, 'json');
  const walletFlag = getFlag(args, 'wallet');

  if (!jsonMode) {
    process.stderr.write('\n' + header(`Grant: ${request.subcommand}`) + '\n\n');
    process.stderr.write(keyValue('Network', target.network) + '\n');
    process.stderr.write(keyValue('Wallet', walletName) + '\n');
    if (account !== null) process.stderr.write(keyValue('Account', account.address) + '\n');
    process.stderr.write('\n');
  }

  // Reading the account or a request submits nothing: a wallet with no Dust can still do it.
  const funds = paysAFee(request) ? await assertWalletCanPay(target, walletFlag, jsonMode ? silentSpinner() : startSpinner('Checking wallet...')) : undefined;
  const serve = await openPayingServe(target, walletFlag, jsonMode ? silentSpinner() : startSpinner('Starting mn serve...'));
  const spinner = jsonMode ? silentSpinner() : startSpinner(SPINNER_LABEL[request.subcommand]);
  const paid: AccountBridge = { ...bridge, servePort: serve.port, onMessage: (message) => spinner.update(message) };
  const common = { subcommand: request.subcommand, network: target.network, wallet: walletName, ownerKey: 'development' };

  try {
    if (request.subcommand === 'deploy') {
      const outcome = await deployAccount(paid, newDevelopmentOwnerKey());
      spinner.stop(outcome.resumed ? 'Account ready' : 'Account deployed');
      if (jsonMode) {
        writeJsonResult({ ...common, ...outcome });
      } else {
        process.stderr.write('\n' + keyValue('Account', outcome.address) + '\n');
        if (outcome.resumed) process.stderr.write(dim('  An account already on record was completed; no new one was deployed.') + '\n');
        if (outcome.setAside) process.stderr.write(dim(`  The record of an earlier deploy that never reached the chain was kept at ${outcome.setAside}`) + '\n');
        process.stderr.write('\n' + yellow('  ' + DEVELOPMENT_KEY_NOTE) + '\n');
        process.stderr.write(dim('  Next: midnight grant status') + '\n\n');
        process.stdout.write(outcome.address + '\n');
      }
      return;
    }

    if (request.subcommand === 'deposit') {
      const outcome = await depositIntoAccount(paid, request.value);
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

    const result = await runOwnerCommand(paid, ownerArguments(request, jsonMode));
    if (result.exitCode !== 0) {
      const message = result.errors.join('\n') || `The account build's ${request.subcommand} command failed`;
      throw result.exitCode === 2 ? new UsageError(message) : new Error(message);
    }
    spinner.stop('Done');
    if (jsonMode) {
      writeJsonResult({ ...common, ...(JSON.parse(result.output) as Record<string, unknown>) });
    } else {
      process.stderr.write('\n');
      process.stdout.write(result.output + '\n');
      process.stderr.write('\n' + dim('  ' + DEVELOPMENT_KEY_NOTE) + '\n\n');
    }
  } catch (err) {
    spinner.fail(`${request.subcommand} failed`);
    // A deploy costs far more Dust than a transfer: say how much when that is what stopped it.
    if (request.subcommand === 'deploy' && funds !== undefined && err instanceof Error && isShortOfDust(err)) {
      throw new Error(`${err.message}\n\n${deployShortOfDustNote(funds.dustBalance)}`);
    }
    throw err;
  } finally {
    await serve.stop();
  }
}
