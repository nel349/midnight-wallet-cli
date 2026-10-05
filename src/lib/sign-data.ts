// What the wallet signs when a dApp asks it to sign data.

/**
 * The dApp's bytes behind "midnight_signed_message:<byte length>:". The same
 * key signs the wallet's unshielded spends, over a transaction's signature
 * data, so signing a dApp's bytes as given would let it pass that signature
 * data as a "message" and get back a valid spend signature. The connector spec
 * requires the prefix.
 */
export function signedMessageBytes(payload: Uint8Array): Uint8Array {
  const prefix = Buffer.from(`midnight_signed_message:${payload.length}:`, 'utf-8');
  return new Uint8Array(Buffer.concat([prefix, payload]));
}
