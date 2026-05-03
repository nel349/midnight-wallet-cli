// Assertions — run post-test checks defined in assertions.json.
// Supported: balance-changed, process-exit-code, port-listening,
//            agent-report-no-failure
// v2 will add: ledger-field, contract-deployed (requires contract state queries)

import { existsSync, readFileSync } from 'node:fs';
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
  /** Path to the Claude session log (only set for browser-strategy runs) */
  agentLogPath?: string;
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
    case 'agent-report-no-failure':
      return checkAgentReportNoFailure(check, ctx);
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

// ── Agent report parsing ──

/**
 * Failure markers we look for in Claude's report. Each one is a phrase the
 * model uses when reporting that a step or scenario failed.
 *
 * Word-boundary matching (`\b`) prevents the false positives substring
 * matching produced — "fail" must not match "failure" in "not a current
 * failure" or "failsafe" in unrelated prose. Code blocks are stripped
 * before scanning so dApp error quotes don't count as Claude saying
 * "the test failed".
 *
 * Custom marker lists (passed via params.markers) take the strings
 * verbatim and apply the same word-boundary rule for ASCII; the emoji
 * marker uses a plain substring check since `\b` doesn't apply.
 *
 * Customize per-suite via params.markers (string[]).
 */
const DEFAULT_FAILURE_MARKERS = [
  'FAILED',
  '❌',
  'did not pass',
  'test failed',
  'overall: fail',
  'result: fail',
];

interface AgentReportNoFailureParams {
  /** Optional override of the failure markers. Falls back to DEFAULT_FAILURE_MARKERS. */
  markers?: string[];
  /** Optional explicit log path. Falls back to ctx.agentLogPath. */
  logPath?: string;
}

/**
 * Pass when Claude's session log contains NO failure markers outside code
 * blocks. Counters the false-PASS pattern where Claude finishes its prompt
 * by reporting "## Step 5: FAILED" but exits 0 — process-exit-code alone
 * counts that as a successful run.
 *
 * Best-effort: missing log = pass (no signal to fail on). The intent is to
 * catch unambiguous failure reports, not to litigate every "fail" word the
 * model might emit in passing.
 */
function checkAgentReportNoFailure(check: AssertionCheck, ctx: AssertionContext): boolean {
  const params = (check.params ?? {}) as AgentReportNoFailureParams;
  const path = params.logPath ?? ctx.agentLogPath;
  if (!path || !existsSync(path)) {
    // Nothing to scan — treat as no-failure-signal-found, i.e. pass.
    // The runner's own port-listening / exit-code checks still gate the suite.
    return true;
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return true;
  }

  const stripped = stripCodeBlocks(raw);
  const markers = params.markers ?? DEFAULT_FAILURE_MARKERS;
  for (const marker of markers) {
    if (markerMatches(stripped, marker)) {
      // Found a failure phrase outside fenced code — treat the run as failed.
      return false;
    }
  }
  return true;
}

/**
 * Match a marker against the stripped text. Word-boundary matching for
 * ASCII tokens (so "fail" doesn't hit "failure"); plain substring for
 * non-ASCII (emoji + multi-token phrases where boundaries would be
 * over-restrictive).
 */
function markerMatches(haystack: string, marker: string): boolean {
  // Plain substring for emoji and any marker containing whitespace —
  // word boundaries don't behave intuitively for either.
  if (/\s/.test(marker) || /[^ -~]/.test(marker)) {
    return haystack.toLowerCase().includes(marker.toLowerCase());
  }
  // Word-boundary regex for ASCII single-token markers.
  // Escape regex metachars defensively in case a caller passes one.
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`, 'i');
  return re.test(haystack);
}

/**
 * Remove fenced code blocks (```…```) and inline code (`…`) from text.
 * Used to keep dApp error messages, file paths, or stack traces that
 * Claude quoted from blowing up our failure-marker scan. The intent is to
 * judge Claude's narrative voice, not the artifacts it cites.
 */
function stripCodeBlocks(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '');
}
