// What a command needs before it submits a transaction the wallet pays for,
// through mn serve: which network and endpoints, whether the wallet can pay,
// and a server to balance and submit. `mn contract` and `mn grant` share it.
//
// Progress goes to the spinner the command passes (a silent one under --json).
// The wallet repository and the server are loaded when first needed, so a
// command that only reads local files (`contract inspect`) doesn't load them.

import { type ParsedArgs, getFlag } from './argv.ts';
import { NATIVE_TOKEN_TYPE } from './constants.ts';
import { applyEndpointOverrides, endpointFlags, type EndpointOverrides, type NetworkConfig, type NetworkName } from './network.ts';
import { resolveNetwork } from './resolve-network.ts';
import { loadWalletConfig, resolveWalletPath } from './wallet-config.ts';
import { formatNight } from '../ui/format.ts';
import { OWN_COMMAND_DUST_WAIT_MS } from './dust-wait.ts';
import type { Spinner } from '../ui/spinner.ts';

/** The network a command acts on, with its endpoints resolved. */
export interface PayingTarget {
  network: string;
  networkConfig: NetworkConfig;
  /** The endpoints given as flags, which a server started for the command must use too. */
  endpoints: EndpointOverrides;
}

/**
 * --network (undeployed when not given), then explicit endpoint flags over the
 * defaults. Without endpoint flags, `undeployed` resolves to whatever local
 * stack docker shows, which is ambiguous when more than one runs.
 */
export function resolvePayingTarget(args: ParsedArgs, command: string, subcommand: string): PayingTarget {
  const network = getFlag(args, 'network') ?? 'undeployed';
  const endpoints: EndpointOverrides = {
    node: getFlag(args, 'node'),
    indexerWS: getFlag(args, 'indexer-ws'),
    proofServer: getFlag(args, 'proof-server'),
  };
  const { name, config: networkConfig } = resolveNetwork({
    args: { command, subcommand, positionals: [], flags: { network, ...endpointFlags(endpoints) } },
  });
  applyEndpointOverrides(networkConfig, endpoints, name);
  return { network, networkConfig, endpoints };
}

/**
 * The wallet holds NIGHT and has Dust to pay a fee with. Throws, saying what
 * to do, when it has neither. `wallet` is the --wallet flag; without it the
 * active wallet is checked, the one the command's server will use. Returns
 * what it found, the Dust in Specks.
 */
export async function assertWalletCanPay({ network, networkConfig }: PayingTarget, wallet: string | undefined, progress: Spinner): Promise<{ nightBalance: bigint; dustBalance: bigint }> {
  const walletConfig = loadWalletConfig(resolveWalletPath(wallet));
  const seedBuffer = Buffer.from(walletConfig.seed, 'hex');
  const address = walletConfig.addresses[network as NetworkName];
  const { defaultRepository } = await import('./wallet-data-repository.ts');
  const repo = defaultRepository();

  try {
    // Two cheap reads through the repo: no facade, no proof server, no strict
    // sync. Its tip-aware memo makes the next check in the same MCP session
    // nearly free.
    const balanceView = await repo.unshielded(address, networkConfig);
    const nightBalance = balanceView.balances.get(NATIVE_TOKEN_TYPE) ?? 0n;

    if (nightBalance === 0n) {
      progress.fail('No NIGHT balance');
      throw new Error(
        `Wallet has 0 NIGHT on ${network}.\n\n` +
        `  Fund your wallet before deploying:\n` +
        `    Address: ${address}\n` +
        (network === 'undeployed'
          ? `    Run: midnight airdrop 1000\n`
          : `    Use the Midnight faucet or transfer from another wallet.\n`)
      );
    }

    const dustView = await repo.dust(seedBuffer, networkConfig, { onStatus: (s) => progress.update(s) });
    if (dustView.balance === 0n && dustView.availableCoins === 0) {
      progress.fail('No dust available');
      throw new Error(
        `Wallet has no dust on ${network}. Dust is required to pay transaction fees.\n\n` +
        `  Register for dust generation:\n` +
        `    Run: midnight dust register --network ${network}\n` +
        `    Then wait: midnight dust status --network ${network}\n`
      );
    }

    progress.stop(`Wallet OK (${formatNight(nightBalance)}, dust available)`);
    return { nightBalance, dustBalance: dustView.balance };
  } catch (err) {
    progress.fail('Wallet check failed');
    throw err;
  }
}

/**
 * An mn serve for the command's network and wallet: one already running there
 * is reused (its stop does nothing); one on another network refuses, saying
 * what to do.
 */
export async function openPayingServe({ network, endpoints }: PayingTarget, wallet: string | undefined, progress: Spinner): Promise<{ port: number; stop: () => Promise<void> }> {
  const { startServeOrReuse } = await import('./test/serve-manager.ts');
  const handle = await startServeOrReuse({
    network,
    endpoints,
    wallet,
    onMessage: (msg) => progress.update(msg),
    dustWaitMs: OWN_COMMAND_DUST_WAIT_MS,
  });
  progress.stop('mn serve ready (port ' + handle.port + ')');
  return { port: handle.port, stop: () => handle.stop() };
}
