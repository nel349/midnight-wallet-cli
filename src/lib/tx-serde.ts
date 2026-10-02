// Transaction hex helpers — the DApp Connector passes transactions as hex
// strings over JSON-RPC. Reading the bytes as a transaction is the wallet's
// job (`facade.adoptTransaction`), which knows the chain's ledger version.

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
