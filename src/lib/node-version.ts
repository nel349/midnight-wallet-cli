// The oldest Node.js mn runs on. The wallet SDK calls iterator helpers
// (Map.entries().find), which Node 22 added: on Node 20 a wallet sync times
// out and a fee can't be worked out, with errors that name neither.

export const MIN_NODE_MAJOR = 22;

/** This Node.js is too old to run the wallet SDK. */
export class UnsupportedNodeError extends Error {
  readonly code = 'UNSUPPORTED_NODE';

  constructor(version: string) {
    super(
      `midnight-wallet-cli needs Node.js ${MIN_NODE_MAJOR} or newer; this is Node.js ${version}. `
      + `The Midnight wallet SDK uses features older versions lack. Install a current Node.js (https://nodejs.org) and run the command again.`,
    );
    this.name = 'UnsupportedNodeError';
    Object.setPrototypeOf(this, UnsupportedNodeError.prototype);
  }
}

/**
 * Throws on a Node.js older than mn supports. Under Bun, which reports the
 * Node.js version it is compatible with and has the features itself, nothing
 * is checked.
 */
export function assertNodeSupported(versions: { node: string; bun?: string } = process.versions): void {
  if (versions.bun !== undefined) return;
  const major = Number(versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) throw new UnsupportedNodeError(versions.node);
}
