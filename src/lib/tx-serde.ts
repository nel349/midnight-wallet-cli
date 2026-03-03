// Transaction hex serialization/deserialization helpers
// Used by the DApp Connector to pass transactions as hex strings over JSON-RPC

import { Transaction } from '@midnight-ntwrk/ledger-v7';
import type {
  SignatureEnabled,
  Proof,
  PreProof,
  Binding,
  PreBinding,
} from '@midnight-ntwrk/ledger-v7';

// ── Type aliases matching DApp Connector terminology ──

/** Unsealed = proven but not bound (Transaction<SignatureEnabled, Proof, PreBinding>) */
export type UnsealedTransaction = Transaction<SignatureEnabled, Proof, PreBinding>;

/** Sealed = proven and bound (Transaction<SignatureEnabled, Proof, Binding>) */
export type SealedTransaction = Transaction<SignatureEnabled, Proof, Binding>;

/** Unproven = not yet proven (Transaction<SignatureEnabled, PreProof, PreBinding>) */
export type UnprovenTransaction = Transaction<SignatureEnabled, PreProof, PreBinding>;

// ── Hex conversion ──

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex string: contains non-hex characters');
  }
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string: odd length');
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

// ── Serialize ──

export function serializeTx(tx: Transaction<any, any, any>): string {
  return toHex(tx.serialize());
}

// ── Deserialize ──

export function deserializeUnsealed(hex: string): UnsealedTransaction {
  return Transaction.deserialize<SignatureEnabled, Proof, PreBinding>(
    'signature' as any,
    'proof' as any,
    'pre-binding' as any,
    fromHex(hex),
  );
}

export function deserializeSealed(hex: string): SealedTransaction {
  return Transaction.deserialize<SignatureEnabled, Proof, Binding>(
    'signature' as any,
    'proof' as any,
    'binding' as any,
    fromHex(hex),
  );
}

export function deserializeUnproven(hex: string): UnprovenTransaction {
  return Transaction.deserialize<SignatureEnabled, PreProof, PreBinding>(
    'signature' as any,
    'pre-proof' as any,
    'pre-binding' as any,
    fromHex(hex),
  );
}
