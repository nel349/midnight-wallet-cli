// This build of mn speaks ledger 9 only. wallet-sdk 2.0 can't sync against a
// ledger-8 indexer (it retries forever), and mn's own readers decode ledger-9
// events. So check the chain's protocol version up front and fail with a
// clear message instead of hanging or failing on a deserialize error.

import { FORK_SCHEDULE, type NetworkConfig } from './network.ts';

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
