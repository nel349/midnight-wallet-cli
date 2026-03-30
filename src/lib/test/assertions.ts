// Assertions — run post-test checks defined in assertions.json.
// v1 supports: balance-changed, process-exit-code, port-listening
// v2 will add: ledger-field, contract-deployed (requires contract state queries)

import net from 'node:net';
import type { AssertionCheck, AssertionResult } from './types.ts';

/**
 * Run all assertion checks and return results.
 * Each check is independent — a failure in one doesn't stop the others.
 */
export async function runAssertions(
  checks: AssertionCheck[],
  context: AssertionContext,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];

  for (const check of checks) {
    try {
      const passed = await evaluateCheck(check, context);
      // If expect is 'fail', the check passes when the evaluation fails
      const matches = check.expect === 'pass' ? passed : !passed;
      results.push({
        id: check.id,
        status: matches ? 'pass' : 'fail',
        message: matches ? undefined : `Expected ${check.expect}, got ${passed ? 'pass' : 'fail'}`,
      });
    } catch (err) {
      results.push({
        id: check.id,
        status: 'fail',
        message: (err as Error).message,
      });
    }
  }

  return results;
}

// ── Context for assertions ──

export interface AssertionContext {
  /** Balance before the test (in micro-NIGHT, bigint as string) */
  preBalance?: string;
  /** Balance after the test (in micro-NIGHT, bigint as string) */
  postBalance?: string;
  /** Claude process exit code */
  processExitCode?: number;
}

// ── Check evaluation ──

async function evaluateCheck(check: AssertionCheck, ctx: AssertionContext): Promise<boolean> {
  switch (check.type) {
    case 'balance-changed':
      return checkBalanceChanged(check, ctx);
    case 'process-exit-code':
      return checkProcessExitCode(check, ctx);
    case 'port-listening':
      return checkPortListening(check);
    default:
      throw new Error(`Unsupported assertion type: "${check.type}" (available in v2)`);
  }
}

function checkBalanceChanged(check: AssertionCheck, ctx: AssertionContext): boolean {
  if (ctx.preBalance === undefined || ctx.postBalance === undefined) {
    throw new Error('Balance data not available — balance:N prep step may not have run');
  }

  const pre = BigInt(ctx.preBalance);
  const post = BigInt(ctx.postBalance);
  const direction = check.params.direction as string | undefined;

  if (direction === 'decreased') return post < pre;
  if (direction === 'increased') return post > pre;
  if (direction === 'unchanged') return post === pre;

  // Default: any change
  return post !== pre;
}

function checkProcessExitCode(check: AssertionCheck, ctx: AssertionContext): boolean {
  if (ctx.processExitCode === undefined) {
    throw new Error('Process exit code not available');
  }

  const expected = check.params.code as number;
  return ctx.processExitCode === expected;
}

function checkPortListening(check: AssertionCheck): Promise<boolean> {
  const port = check.params.port as number;
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2_000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}
