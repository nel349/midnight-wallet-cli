// Checks on a contract request that need only the compiled contract, made
// before mn starts a wallet or touches the network. Without them a wrong
// circuit name or address surfaced as a runtime TypeError from the script
// ("deployed.callTx.x is not a function", "Expected an input string with byte
// length of 32"), and a wrong argument count as the runtime's count, which
// includes its own context ("expected 1 argument ... received 4" for 3 args).

import { UsageError } from '../errors.ts';
import type { ContractInfo } from './inspect.ts';

/** A contract address is 32 bytes as 64 hex characters. */
export function validateContractAddress(address: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(address)) {
    throw new UsageError(`A contract address is 64 hex characters (32 bytes); got "${address}" (${address.length} characters).`);
  }
}

/** The circuit exists in the compiled contract and is given as many arguments as it takes. */
export function validateCallRequest(info: ContractInfo, circuitName: string, args: readonly unknown[]): void {
  const circuit = info.circuits.find((c) => c.name === circuitName);
  if (!circuit) {
    const names = info.circuits.map((c) => c.name);
    throw new UsageError(
      `${info.name} has no circuit "${circuitName}". `
      + (names.length > 0 ? `Its circuits: ${names.join(', ')}.` : 'It has no circuits to call.'),
    );
  }
  const takes = circuit.arguments.length;
  if (args.length !== takes) {
    const params = circuit.arguments.map((a) => a.name).join(', ');
    throw new UsageError(
      `${circuitName} takes ${takes} argument${takes === 1 ? '' : 's'}${takes > 0 ? ` (${params})` : ''}; --args gave ${args.length}.`,
    );
  }
}
