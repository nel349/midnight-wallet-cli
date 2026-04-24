// Chain fingerprint — the genesis block hash uniquely identifies a chain
// instance. A mismatch between the hash stored in a wallet/dust cache and
// the hash the chain currently reports is a definitive "cache is from a
// different chain" signal that `applied > highest` can't detect (e.g. a
// preprod reset that advanced the chain past our cache).

import { callNodeRpc } from './node-rpc.ts';

/** Memoise genesis-hash lookups so back-to-back commands don't re-fetch. */
const CHAIN_ID_MEMO = new Map<string, { hash: string; fetchedAt: number }>();
const MEMO_TTL_MS = 60_000;

/**
 * Fetch the chain's genesis block hash via substrate JSON-RPC.
 * Returns null when the node is unreachable — caller should treat that as
 * "skip validation, proceed best-effort" rather than as a hard failure.
 */
export async function getChainGenesisHash(nodeWsUrl: string): Promise<string | null> {
  const cached = CHAIN_ID_MEMO.get(nodeWsUrl);
  if (cached && Date.now() - cached.fetchedAt < MEMO_TTL_MS) return cached.hash;
  try {
    const hash = await callNodeRpc<string>({ url: nodeWsUrl, timeoutMs: 5_000 }, 'chain_getBlockHash', [0]);
    if (typeof hash !== 'string' || !hash.startsWith('0x')) return null;
    CHAIN_ID_MEMO.set(nodeWsUrl, { hash, fetchedAt: Date.now() });
    return hash;
  } catch {
    return null;
  }
}

/** Test helper — drops the in-memory memo so fresh fetches happen. */
export function clearChainIdMemo(): void {
  CHAIN_ID_MEMO.clear();
}
