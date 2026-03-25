// Transaction hex serialization/deserialization helpers
// Used by the DApp Connector to pass transactions as hex strings over JSON-RPC

import { Transaction } from '@midnight-ntwrk/ledger-v8';
import type {
  SignatureEnabled,
  Proof,
  PreProof,
  Binding,
  PreBinding,
} from '@midnight-ntwrk/ledger-v8';

// ── Type aliases matching DApp Connector terminology ──

/** Unsealed = proven but not bound (Transaction<SignatureEnabled, Proof, PreBinding>) */
export type UnsealedTransaction = Transaction<SignatureEnabled, Proof, PreBinding>;

/** Sealed = proven and bound (Transaction<SignatureEnabled, Proof, Binding>) */
export type SealedTransaction = Transaction<SignatureEnabled, Proof, Binding>;

/** Unproven = not yet proven (Transaction<SignatureEnabled, PreProof, PreBinding>) */
export type UnprovenTransaction = Transaction<SignatureEnabled, PreProof, PreBinding>;

// ── Type markers ──
// Transaction.deserialize() requires marker strings matching the `instance`
// property of each class (e.g. SignatureEnabled.instance = 'signature').
// TS can't infer `S['instance']` from a bare string literal, so we cast
// through the branded instance types to preserve type safety.

const SIGNATURE_MARKER = 'signature' as SignatureEnabled['instance'];
const PROOF_MARKER = 'proof' as Proof['instance'];
const PRE_PROOF_MARKER = 'pre-proof' as PreProof['instance'];
const BINDING_MARKER = 'binding' as Binding['instance'];
const PRE_BINDING_MARKER = 'pre-binding' as PreBinding['instance'];

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
    SIGNATURE_MARKER,
    PROOF_MARKER,
    PRE_BINDING_MARKER,
    fromHex(hex),
  );
}

export function deserializeSealed(hex: string): SealedTransaction {
  return Transaction.deserialize<SignatureEnabled, Proof, Binding>(
    SIGNATURE_MARKER,
    PROOF_MARKER,
    BINDING_MARKER,
    fromHex(hex),
  );
}

export function deserializeUnproven(hex: string): UnprovenTransaction {
  return Transaction.deserialize<SignatureEnabled, PreProof, PreBinding>(
    SIGNATURE_MARKER,
    PRE_PROOF_MARKER,
    PRE_BINDING_MARKER,
    fromHex(hex),
  );
}
