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

export function isReadOnlyMethod(method: string): boolean {
  return READ_ONLY_METHODS.has(method);
}

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
    return 'approve';
  }

  // Render the approval box to stderr
  process.stderr.write('\n' + renderApprovalBox(request) + '\n\n');

  // Prompt for user input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise<ApprovalResult>((resolve) => {
    rl.question(yellow('  Approve? [A/r] '), (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      if (normalized === 'r' || normalized === 'reject') {
        resolve('reject');
      } else {
        // Default to approve (empty input, 'a', 'approve', 'y', 'yes')
        resolve('approve');
      }
    });
  });
}
