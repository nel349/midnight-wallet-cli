// Terminal approval prompts for DApp Connector write operations
// Uses Node.js readline (per project constraints — no inquirer)

import * as readline from 'node:readline';
import { box } from '../ui/format.ts';
import { bold, teal, dim, yellow, green, red } from '../ui/colors.ts';

// ── Types ──

export interface ApprovalDetail {
  label: string;
  value: string;
}

export interface ApprovalRequest {
  /** DApp Connector method name (e.g. 'makeTransfer', 'submitTransaction') */
  method: string;
  /** Optional DApp identifier */
  dappName?: string;
  /** Network ID */
  network: string;
  /** Key-value details to display */
  details: ApprovalDetail[];
}

export type ApprovalResult = 'approve' | 'reject';

export interface ApprovalOptions {
  /** Auto-approve read-only methods without prompting */
  autoApproveReads?: boolean;
  /** Auto-approve all operations (for agent/automated use) */
  approveAll?: boolean;
}

// ── Read-only method set ──

const READ_ONLY_METHODS = new Set([
  'getShieldedBalances',
  'getUnshieldedBalances',
  'getDustBalance',
  'getShieldedAddresses',
  'getUnshieldedAddress',
  'getDustAddress',
  'getTxHistory',
  'getConfiguration',
  'getConnectionStatus',
]);

/** Prep-step methods that have no on-chain effect — safe to auto-approve when submit will prompt */
const PREP_METHODS = new Set([
  'balanceUnsealedTransaction',
  'balanceSealedTransaction',
]);

export function isReadOnlyMethod(method: string): boolean {
  return READ_ONLY_METHODS.has(method);
}

export function isPrepMethod(method: string): boolean {
  return PREP_METHODS.has(method);
}

// ── Concurrent prompt guard ──

let promptActive = false;

// ── Rendering ──

export function renderApprovalBox(request: ApprovalRequest): string {
  const lines: string[] = [];

  // Title
  const title = request.dappName
    ? `Request from "${request.dappName}"`
    : 'DApp Request';
  lines.push(bold(title));
  lines.push('');

  // Method and network
  lines.push(`  ${dim('Action:')}   ${teal(request.method)}`);
  lines.push(`  ${dim('Network:')}  ${request.network}`);

  // Details
  if (request.details.length > 0) {
    lines.push('');
    for (const detail of request.details) {
      lines.push(`  ${dim(detail.label + ':')}  ${detail.value}`);
    }
  }

  lines.push('');
  lines.push(`  ${green('[A]pprove')}  ${red('[R]eject')}`);

  return box(lines, 'heavy');
}

// ── Prompt ──

/**
 * Prompt the user to approve or reject a DApp Connector operation.
 * Returns 'approve' or 'reject'.
 *
 * If options.approveAll is true, auto-approves without prompting.
 * If options.autoApproveReads is true and the method is read-only, auto-approves.
 *
 * Rejects if stdin is not a TTY (non-interactive environment).
 * Only one prompt can be active at a time — concurrent calls are rejected.
 */
export async function promptApproval(
  request: ApprovalRequest,
  options: ApprovalOptions = {},
): Promise<ApprovalResult> {
  // Auto-approve checks
  if (options.approveAll) {
    process.stderr.write(dim(`  Auto-approved: ${request.method}`) + '\n');
    return 'approve';
  }

  if (options.autoApproveReads && isReadOnlyMethod(request.method)) {
    process.stderr.write(dim(`  Auto-approved (read-only): ${request.method}`) + '\n');
    return 'approve';
  }

  if (options.autoApproveReads && isPrepMethod(request.method)) {
    process.stderr.write(dim(`  Auto-approved (prep): ${request.method}`) + '\n');
    return 'approve';
  }

  // Non-interactive environment — reject by default
  if (!process.stdin.isTTY) {
    process.stderr.write(red('  Cannot prompt for approval: stdin is not a TTY') + '\n');
    process.stderr.write(dim('  Use --approve-all for non-interactive environments') + '\n');
    return 'reject';
  }

  // Prevent concurrent prompts from overlapping on stdin
  if (promptActive) {
    process.stderr.write(red('  Rejected: another approval prompt is active') + '\n');
    return 'reject';
  }

  // Render the approval box to stderr
  process.stderr.write('\n' + renderApprovalBox(request) + '\n\n');

  // Prompt for user input
  promptActive = true;

  let rl: readline.Interface;
  try {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
  } catch {
    promptActive = false;
    process.stderr.write(red('  Cannot create readline interface') + '\n');
    return 'reject';
  }

  return new Promise<ApprovalResult>((resolve) => {
    const cleanup = (result: ApprovalResult) => {
      promptActive = false;
      rl.close();
      resolve(result);
    };

    // Handle stdin closing before user answers (e.g. piped input ends)
    rl.on('close', () => {
      if (promptActive) {
        cleanup('reject');
      }
    });

    rl.question(yellow('  Approve? [A/r] '), (answer) => {
      const normalized = answer.trim().toLowerCase();
      if (normalized === 'r' || normalized === 'reject') {
        cleanup('reject');
      } else {
        // Default to approve (empty input, 'a', 'approve', 'y', 'yes')
        cleanup('approve');
      }
    });
  });
}
