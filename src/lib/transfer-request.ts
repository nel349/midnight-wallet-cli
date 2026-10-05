// A transfer's arguments, checked before any wallet starts: the CLI checks them
// before syncing, the MCP server before it issues a confirmation token, so a
// typo in the amount or the recipient is refused up front.

import { MidnightBech32m, ShieldedAddress, UnshieldedAddress } from '@midnightntwrk/wallet-sdk/address-format';
import { type ParsedArgs, getFlag, hasFlag } from './argv.ts';
import { UsageError } from './errors.ts';
import { loadWalletConfig, resolveWalletPath, type WalletConfig } from './wallet-config.ts';
import { resolveNetworkName } from './resolve-network.ts';
import { networkIdForName } from './network-id.ts';
import { shieldedSyncEnabled, shieldedDisabledReason } from './shielded-policy.ts';
import { parseAmount } from './transfer.ts';
import type { NetworkName } from './network.ts';

export interface TransferRequest {
  walletPath: string;
  walletConfig: WalletConfig;
  networkName: NetworkName;
  /** The recipient's bech32m address; a wallet name given as the recipient is resolved to it. */
  recipientAddress: string;
  amountNight: number;
  shielded: boolean;
}

/** `transfer <to> <amount> [--shielded] [--wallet] [--network]`, checked without touching the chain. */
export function resolveTransferRequest(args: ParsedArgs): TransferRequest {
  const recipientInput = args.subcommand;
  const amountStr = args.positionals[0];

  if (!recipientInput) {
    throw new UsageError(
      'Missing recipient address.\n' +
      'Usage: midnight transfer <to> <amount>\n' +
      'Example: midnight transfer mn_addr_undeployed1... 100\n' +
      'Example: midnight transfer alice 100'
    );
  }

  if (!amountStr) {
    throw new UsageError(
      'Missing amount.\n' +
      'Usage: midnight transfer <to> <amount>\n' +
      'Example: midnight transfer mn_addr_undeployed1... 100'
    );
  }

  const shielded = hasFlag(args, 'shielded');
  const recipientAddress = resolveRecipient(recipientInput, args, shielded);
  const amountNight = parseAmount(amountStr);
  const walletPath = resolveWalletPath(getFlag(args, 'wallet'));
  const walletConfig = loadWalletConfig(walletPath);
  const networkName = resolveNetworkName({ args });

  if (shielded) {
    if (!shieldedSyncEnabled(networkName, hasFlag(args, 'force-shielded'))) {
      throw new Error(shieldedDisabledReason(networkName));
    }
    decodeShieldedRecipient(recipientAddress, networkName);
  } else {
    decodeUnshieldedRecipient(recipientAddress, networkName);
  }

  return { walletPath, walletConfig, networkName, recipientAddress, amountNight, shielded };
}

export function decodeShieldedRecipient(address: string, networkName: NetworkName): ShieldedAddress {
  try {
    return MidnightBech32m.parse(address).decode(ShieldedAddress, networkIdForName(networkName));
  } catch (err: any) {
    throw new UsageError(
      `Invalid shielded address: ${err.message}\n` +
      `Expected a shielded address (mn_shield-addr_...) for network "${networkName}"`
    );
  }
}

function decodeUnshieldedRecipient(address: string, networkName: NetworkName): UnshieldedAddress {
  try {
    return MidnightBech32m.parse(address).decode(UnshieldedAddress, networkIdForName(networkName));
  } catch (err: any) {
    throw new UsageError(
      `Invalid recipient address: ${err.message}\n` +
      `Expected a bech32m address (mn_addr_...) for network "${networkName}"`
    );
  }
}

/**
 * An address (mn_addr_ or mn_shield-addr_ prefix) is used as given. Anything
 * else is a wallet name, and the address comes from that wallet's file.
 */
function resolveRecipient(input: string, args: ParsedArgs, shielded: boolean): string {
  if (input.startsWith('mn_addr_') || input.startsWith('mn_shield-addr_')) {
    return input;
  }

  const recipientConfig = loadWalletConfig(resolveWalletPath(input));
  const networkName = resolveNetworkName({ args });

  if (shielded) {
    const shieldedAddr = recipientConfig.shieldedAddresses?.[networkName];
    if (!shieldedAddr) {
      throw new Error(
        `Wallet "${input}" has no shielded address for network "${networkName}".\n` +
        `Regenerate the wallet or run "midnight balance --shielded" first.`
      );
    }
    return shieldedAddr;
  }

  const address = recipientConfig.addresses[networkName];
  if (!address) {
    throw new Error(`Wallet "${input}" has no address for network "${networkName}". Regenerate the wallet to derive one.`);
  }
  return address;
}
