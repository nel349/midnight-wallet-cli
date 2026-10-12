// Asked before a wallet sync starts: the wallet SDK retries an endpoint that
// refuses it without saying why, so mn finds out first. The endpoints mn
// connects to itself are checked where the connection is made.

import { assertEndpointUsable, endpointRefusal, isBlockfrostUrl } from './blockfrost.ts';
import type { NetworkConfig } from './network.ts';

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Throws when the network's endpoints can't serve a sync: one was shut down,
 * Blockfrost has no project id to go with, or it refuses the one it is given
 * (asked with one small query; the node takes the same project id). An
 * endpoint that simply can't be reached is left to the sync to report.
 */
export async function assertNetworkAnswers(
  network: Pick<NetworkConfig, 'indexer' | 'indexerWS' | 'node'>,
  request: typeof fetch = fetch,
): Promise<void> {
  for (const url of [network.indexer, network.indexerWS, network.node]) assertEndpointUsable(url);
  if (!isBlockfrostUrl(network.indexer)) return;

  let status: number;
  try {
    const response = await request(network.indexer, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    status = response.status;
  } catch {
    return;
  }
  const refusal = endpointRefusal(network.indexer, status);
  if (refusal !== undefined) throw refusal;
}
