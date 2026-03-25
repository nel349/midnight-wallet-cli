// Transaction inspection — extracts human-readable details from serialized transactions
// Used by the DApp Connector approval prompt to show Lace-style transaction summaries

import { Transaction } from '@midnight-ntwrk/ledger-v8';
import type { ApprovalDetail } from './approval.ts';

/**
 * Try to extract structured details from a transaction hex string.
 * Returns an array of label/value pairs for the approval prompt.
 * Falls back gracefully — never throws.
 */
export function inspectTxHex(txHex: string, stage: 'unsealed' | 'sealed'): ApprovalDetail[] {
  const details: ApprovalDetail[] = [];
  details.push({ label: 'Tx size', value: formatBytes(txHex.length / 2) });

  const summary = tryDeserializeAndSummarize(txHex, stage);
  if (summary) {
    const parsed = parseTxSummary(summary);
    if (parsed.action) details.push({ label: 'Type', value: parsed.action });
    if (parsed.circuits.length > 0) details.push({ label: 'Circuits', value: parsed.circuits.join(', ') });
    if (parsed.ttl) details.push({ label: 'TTL', value: parsed.ttl });
  }

  return details;
}

/** Try deserializing the tx and return toString(true), or null on failure. */
function tryDeserializeAndSummarize(txHex: string, stage: 'unsealed' | 'sealed'): string | null {
  const bytes = hexToBytes(txHex);

  // Try the expected format first, then fall back to alternatives
  const attempts: Array<[string, string, string]> = stage === 'sealed'
    ? [['signature', 'proof', 'binding'], ['signature', 'proof', 'pre-binding']]
    : [['signature', 'proof', 'pre-binding'], ['signature', 'pre-proof', 'pre-binding']];

  for (const [s, p, b] of attempts) {
    try {
      const tx = Transaction.deserialize(s as any, p as any, b as any, bytes);
      return tx.toString(true);
    } catch { /* try next */ }
  }
  return null;
}

interface TxSummary {
  networkId: string | null;
  action: string | null;
  circuits: string[];
  ttl: string | null;
}

/**
 * Parse the Rust debug output from Transaction.toString(true).
 * Extracts network_id, action type (Deploy/Call), circuit names, and TTL.
 */
function parseTxSummary(summary: string): TxSummary {
  const result: TxSummary = { networkId: null, action: null, circuits: [], ttl: null };

  // network_id: "preview"
  const networkMatch = summary.match(/network_id:\s*"([^"]+)"/);
  if (networkMatch) result.networkId = networkMatch[1];

  // Deploy ContractState or Call <address>
  if (summary.includes('Deploy ContractState')) {
    result.action = 'Deploy contract';
  } else if (summary.match(/Call\s/)) {
    result.action = 'Call contract';
  }

  // Verifier key names: submit_score: <verifier key>, prove_elite: <verifier key>
  const verifierPattern = /(\w+):\s*<verifier key>/g;
  let match;
  while ((match = verifierPattern.exec(summary)) !== null) {
    result.circuits.push(match[1]);
  }

  // If no verifier keys found (call tx), look for circuit name in the call
  if (result.circuits.length === 0) {
    // Call patterns vary — try to extract from actions
    const callMatch = summary.match(/Call\s+\S+\s+(\w+)/);
    if (callMatch) result.circuits.push(callMatch[1]);
  }

  // TTL: Timestamp(1773794982)
  const ttlMatch = summary.match(/ttl:\s*Timestamp\((\d+)\)/);
  if (ttlMatch) {
    const ts = parseInt(ttlMatch[1], 10);
    const date = new Date(ts * 1000);
    result.ttl = date.toISOString().replace('T', ' ').slice(0, 19);
  }

  return result;
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}
