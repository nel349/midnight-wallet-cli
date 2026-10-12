// Is there a contract at this address? Asked of the indexer directly, so the
// answer is about the chain as it is now.

const CONTRACT_AT = 'query($address: HexEncoded!) { contractAction(address: $address) { address } }';

/**
 * Whether a contract is deployed at `address`, by the indexer's account: true,
 * false, or undefined when the indexer couldn't be asked or didn't answer the
 * question (unreachable, an HTTP error, a GraphQL error).
 */
export async function contractExists(indexerUrl: string, address: string, timeoutMs = 10_000): Promise<boolean | undefined> {
  try {
    const response = await fetch(indexerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: CONTRACT_AT, variables: { address } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const answer = await response.json() as { data?: { contractAction?: unknown }; errors?: unknown };
    if (answer.errors !== undefined || answer.data === undefined || answer.data === null) return undefined;
    return answer.data.contractAction !== null && answer.data.contractAction !== undefined;
  } catch {
    return undefined;
  }
}
