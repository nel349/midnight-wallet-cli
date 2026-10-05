// Decoding the data a dApp asks the wallet to sign. Strict: Node's base64
// decoder skips characters it doesn't know, so "@@@not base64@@@" decoded to
// other bytes and was signed as if the dApp had sent them.

import { fromHex } from './tx-serde.ts';

export type SignDataEncoding = 'hex' | 'base64' | 'text';

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The bytes to sign. Throws, saying why, when `data` isn't valid in `encoding`. */
export function decodeSignPayload(data: string, encoding: string): Uint8Array {
  switch (encoding) {
    case 'hex':
      try {
        return fromHex(data);
      } catch (err) {
        throw new Error(`data is not valid hex: ${(err as Error).message}`);
      }
    case 'base64':
      if (!BASE64.test(data)) throw new Error('data is not valid base64 (standard alphabet, padded)');
      return new Uint8Array(Buffer.from(data, 'base64'));
    case 'text':
      return new Uint8Array(Buffer.from(data, 'utf-8'));
    default:
      throw new Error(`Unknown encoding: ${encoding} (use hex, base64 or text)`);
  }
}
