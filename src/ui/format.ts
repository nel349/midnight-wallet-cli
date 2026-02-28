// Text formatting utilities for Midnight CLI
// All functions return strings — callers decide where to write (stdout vs stderr)

import { TOKEN_DECIMALS } from '../lib/constants.ts';
import { teal, red, green, bold, dim, gray, isColorEnabled } from './colors.ts';

const DEFAULT_WIDTH = 60;

// ═══ Header ═══
export function header(title: string, width: number = DEFAULT_WIDTH): string {
  const paddedTitle = ` ${title} `;
  const remaining = width - paddedTitle.length;
  if (remaining <= 0) return bold(paddedTitle);
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return bold('═'.repeat(left) + paddedTitle + '═'.repeat(right));
}

// ─── Divider ───
export function divider(width: number = DEFAULT_WIDTH): string {
  return dim('─'.repeat(width));
}

// Key: Value with aligned padding
export function keyValue(key: string, value: string, padWidth: number = 16): string {
  const paddedKey = (key + ':').padEnd(padWidth);
  return `  ${gray(paddedKey)}${value}`;
}

// Format micro-NIGHT bigint to human-readable NIGHT with 6 decimal places
export function formatNight(microNight: bigint): string {
  const isNegative = microNight < 0n;
  const abs = isNegative ? -microNight : microNight;
  const multiplier = BigInt(10 ** TOKEN_DECIMALS);
  const whole = abs / multiplier;
  const frac = abs % multiplier;
  const fracStr = frac.toString().padStart(TOKEN_DECIMALS, '0');
  const sign = isNegative ? '-' : '';
  return `${sign}${whole}.${fracStr} NIGHT`;
}

// Format Specks bigint to human-readable DUST with 15 decimal places
// 1 DUST = 10^15 Specks (per midnight-ledger spec)
const DUST_DECIMALS = 15;

export function formatDust(specks: bigint): string {
  const isNegative = specks < 0n;
  const abs = isNegative ? -specks : specks;
  const multiplier = 10n ** BigInt(DUST_DECIMALS);
  const whole = abs / multiplier;
  const frac = abs % multiplier;
  // Trim trailing zeros for readability, but keep at least 6 decimal places
  const fracStr = frac.toString().padStart(DUST_DECIMALS, '0');
  const trimmed = fracStr.replace(/0+$/, '').padEnd(6, '0');
  const sign = isNegative ? '-' : '';
  return `${sign}${whole}.${trimmed} DUST`;
}

// Format address with optional truncation and teal coloring
export function formatAddress(address: string, truncate: boolean = false): string {
  const display = truncate && address.length > 20
    ? address.slice(0, 10) + '…' + address.slice(-8)
    : address;
  return teal(display);
}

// Strip ANSI escape codes for visible length measurement
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Word-wrap a string to a max visible width, preserving ANSI codes
function wrapLine(line: string, maxWidth: number): string[] {
  const visible = stripAnsi(line);
  if (visible.length <= maxWidth) return [line];

  // Split on word boundaries for the visible text, then reconstruct with ANSI
  const words = line.split(/(\s+)/);
  const result: string[] = [];
  let currentLine = '';
  let currentLen = 0;

  for (const word of words) {
    const wordLen = stripAnsi(word).length;
    if (currentLen + wordLen > maxWidth && currentLen > 0) {
      result.push(currentLine);
      currentLine = word.trimStart();
      currentLen = stripAnsi(currentLine).length;
    } else {
      currentLine += word;
      currentLen += wordLen;
    }
  }
  if (currentLine.length > 0) result.push(currentLine);
  return result;
}

// Box drawing — light or heavy style
export function box(lines: string[], style: 'light' | 'heavy' = 'light', maxWidth: number = 70): string {
  const chars = style === 'heavy'
    ? { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' }
    : { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };

  // Expand multi-line strings and wrap long lines
  const contentMaxWidth = maxWidth - 4; // account for "║ " and " ║"
  const expanded: string[] = [];
  for (const line of lines) {
    const subLines = line.split('\n');
    for (const sub of subLines) {
      expanded.push(...wrapLine(sub, contentMaxWidth));
    }
  }

  const maxLen = Math.max(...expanded.map(l => stripAnsi(l).length));
  const innerWidth = Math.max(maxLen + 2, 20); // minimum inner width of 20, +2 for padding

  const top = chars.tl + chars.h.repeat(innerWidth) + chars.tr;
  const bottom = chars.bl + chars.h.repeat(innerWidth) + chars.br;
  const body = expanded.map(line => {
    const visibleLen = stripAnsi(line).length;
    const padding = innerWidth - visibleLen - 2; // -2 for the space padding on each side
    return `${chars.v} ${line}${' '.repeat(Math.max(0, padding))} ${chars.v}`;
  });

  return [top, ...body, bottom].join('\n');
}

// Error box with red border and optional recovery suggestion
export function errorBox(error: string, suggestion?: string): string {
  // Split error on newlines and color each line separately to avoid ANSI bleed
  const errorLines = error.split('\n');
  const lines = errorLines.map((line, i) =>
    i === 0 ? red(bold('Error: ')) + red(line) : red(line)
  );
  if (suggestion) {
    lines.push('');
    lines.push(dim('Suggestion: ') + suggestion);
  }
  const output = box(lines, 'heavy');
  // Color the border red if colors enabled
  if (isColorEnabled()) {
    return output.replace(/[╔╗╚╝═║]/g, match => red(match));
  }
  return output;
}

// Success message with green checkmark
export function successMessage(msg: string, txHash?: string): string {
  const check = green('✓');
  const parts = [`${check} ${msg}`];
  if (txHash) {
    parts.push(keyValue('Transaction', teal(txHash)));
  }
  return parts.join('\n');
}
