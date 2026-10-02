// This build of mn speaks ledger 9 only. wallet-sdk 2.0 can't sync against a
// ledger-8 indexer (it retries forever), and mn's own readers decode ledger-9
// events. So check the chain's protocol version up front and fail with a
// clear message instead of hanging or failing on a deserialize error.

import { FORK_SCHEDULE, type NetworkConfig } from './network.ts';
import { getChainGenesisHash } from './chain-id.ts';

export class UnsupportedLedgerError extends Error {
  readonly code = 'UNSUPPORTED_LEDGER';
  constructor(network: string, protocolVersion: bigint) {
    super(
      `${network} is on ledger 8 (protocol version ${protocolVersion}), and this build of mn supports ledger 9 only.\n` +
      `Use midnight-wallet-cli 0.5.x for ledger-8 networks.`,
    );
    this.name = 'UnsupportedLedgerError';
  }
}

/**
 * Throw if the chain is below the ledger-9 fork. An unknown version (indexer
 * unreachable) passes: the real network error surfaces from the call itself.
 */
export function checkLedgerSupported(network: string, protocolVersion: bigint | null): void {
  if (protocolVersion !== null && protocolVersion < FORK_SCHEDULE.v9) {
    throw new UnsupportedLedgerError(network, protocolVersion);
  }
}

const PROBE_TIMEOUT_MS = 5_000;

/** The chain tip's protocol version from the indexer, or null if it can't be read. */
export async function fetchProtocolVersion(indexerHttpUrl: string): Promise<bigint | null> {
  try {
    const res = await fetch(indexerHttpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ block { protocolVersion } }' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await res.json() as { data?: { block?: { protocolVersion?: number } } };
    const version = body.data?.block?.protocolVersion;
    return typeof version === 'number' ? BigInt(version) : null;
  } catch {
    return null;
  }
}

/** Probe the network's indexer and throw UnsupportedLedgerError on a ledger-8 chain. */
export async function assertLedgerSupported(
  networkName: string,
  network: NetworkConfig,
  fetchVersion: (indexerHttpUrl: string) => Promise<bigint | null> = fetchProtocolVersion,
): Promise<void> {
  checkLedgerSupported(networkName, await fetchVersion(network.indexer));
}

/**
 * No ledger-9 stack answers at the configured endpoints. This build can't
 * start one (`mn localnet` refuses), so the user has to run it and point mn
 * at it.
 */
export class LocalStackUnreachableError extends Error {
  readonly code = 'LOCAL_STACK_UNREACHABLE';
  constructor(component: 'indexer' | 'node', url: string) {
    super(
      `No ledger-9 stack is reachable: the ${component} at ${url} did not answer.\n` +
      `This build of mn can't start a localnet (no published indexer image runs ledger 9 yet).\n` +
      `Start a ledger-9 stack (node 2.1.0-rc.2, proof-server 9.0.0-rc.8, a 4.4 indexer) and point mn at it:\n` +
      `  midnight config set network undeployed, then midnight config set node / indexer-ws / proof-server <url>`,
    );
    this.name = 'LocalStackUnreachableError';
  }
}

export interface StackProbes {
  fetchVersion?: (indexerHttpUrl: string) => Promise<bigint | null>;
  fetchGenesis?: (nodeWsUrl: string) => Promise<string | null>;
}

/**
 * Require a running ledger-9 stack at the network's endpoints: the indexer
 * answers with a ledger-9 protocol version, and the node answers.
 */
export async function assertLedger9StackReachable(
  networkName: string,
  network: NetworkConfig,
  probes: StackProbes = {},
): Promise<void> {
  const version = await (probes.fetchVersion ?? fetchProtocolVersion)(network.indexer);
  if (version === null) throw new LocalStackUnreachableError('indexer', network.indexer);
  checkLedgerSupported(networkName, version);
  const genesis = await (probes.fetchGenesis ?? getChainGenesisHash)(network.node);
  if (genesis === null) throw new LocalStackUnreachableError('node', network.node);
}

type WalletKind = 'shielded' | 'unshielded' | 'dust';

/**
 * The wallets (shielded, unshielded, dust) still below the ledger-9 fork. The
 * facade reads a dApp's transaction at the lowest of the three versions, so
 * until this is empty it would read ledger-9 bytes as ledger 8 and refuse them.
 */
export function walletsBelowLedger9(versions: Readonly<Record<WalletKind, bigint>>): WalletKind[] {
  return (['shielded', 'unshielded', 'dust'] as const).filter((wallet) => versions[wallet] < FORK_SCHEDULE.v9);
}
