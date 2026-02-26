import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  header, divider, keyValue,
  formatNight, formatAddress,
  box, errorBox, successMessage,
} from '../ui/format.ts';

// Run format tests with NO_COLOR so we can assert exact string content
// without ANSI escape codes getting in the way
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.NO_COLOR = '';
});

afterEach(() => {
  delete process.env.NO_COLOR;
  Object.assign(process.env, originalEnv);
});

describe('formatNight', () => {
  it('formats zero correctly', () => {
    expect(formatNight(0n)).toBe('0.000000 NIGHT');
  });

  it('formats whole NIGHT amounts with 6 decimal places', () => {
    expect(formatNight(1_000_000n)).toBe('1.000000 NIGHT');
  });

  it('formats fractional amounts', () => {
    expect(formatNight(1_500_000n)).toBe('1.500000 NIGHT');
  });

  it('pads fractional part with leading zeros', () => {
    expect(formatNight(1n)).toBe('0.000001 NIGHT');
  });

  it('formats large values', () => {
    expect(formatNight(123_456_789_000_000n)).toBe('123456789.000000 NIGHT');
  });

  it('formats values with both whole and fractional parts', () => {
    expect(formatNight(42_123_456n)).toBe('42.123456 NIGHT');
  });

  it('handles max micro-precision', () => {
    expect(formatNight(999_999n)).toBe('0.999999 NIGHT');
  });

  it('handles negative values', () => {
    expect(formatNight(-1_500_000n)).toBe('-1.500000 NIGHT');
  });
});

describe('formatAddress', () => {
  const addr = 'mn_addr_preprod1abc123def456ghi789jkl012';

  it('returns full address by default', () => {
    const result = formatAddress(addr);
    // In NO_COLOR mode, should be the plain address
    expect(result).toBe(addr);
  });

  it('truncates long addresses when requested', () => {
    const result = formatAddress(addr, true);
    expect(result.length).toBeLessThan(addr.length);
    expect(result).toContain('…');
  });

  it('preserves start and end of truncated address', () => {
    const result = formatAddress(addr, true);
    expect(result.startsWith(addr.slice(0, 10))).toBe(true);
    expect(result.endsWith(addr.slice(-8))).toBe(true);
  });

  it('does not truncate short addresses even when truncate is true', () => {
    const short = 'mn_addr_short';
    expect(formatAddress(short, true)).toBe(short);
  });

  it('applies teal coloring when colors enabled', () => {
    delete process.env.NO_COLOR;
    const result = formatAddress('test_addr');
    expect(result).toContain('\x1b[');
    expect(result).toContain('test_addr');
    process.env.NO_COLOR = '';
  });
});

describe('keyValue', () => {
  it('formats key-value pair with default padding', () => {
    const result = keyValue('Network', 'preprod');
    expect(result).toContain('Network:');
    expect(result).toContain('preprod');
  });

  it('pads key to specified width', () => {
    const result = keyValue('A', 'val', 10);
    // "A:" padded to 10 chars
    expect(result).toContain('A:        ');
  });

  it('indents with 2 spaces', () => {
    const result = keyValue('Key', 'Value');
    expect(result.startsWith('  ')).toBe(true);
  });
});

describe('header', () => {
  it('uses ═ border characters', () => {
    const result = header('Test');
    expect(result).toContain('═');
    expect(result).toContain('Test');
  });

  it('centers the title', () => {
    const result = header('Title', 30);
    const idx = result.indexOf('Title');
    const leftBorder = result.slice(0, idx).replace(/ /g, '');
    const rightBorder = result.slice(idx + 'Title'.length).replace(/ /g, '');
    // Left and right ═ counts should be roughly equal (within 1)
    expect(Math.abs(leftBorder.length - rightBorder.length)).toBeLessThanOrEqual(1);
  });

  it('respects custom width', () => {
    const result = header('Hi', 40);
    // Total visible chars should be the width (accounting for the spaces around title)
    const stripped = result.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped.length).toBe(40);
  });
});

describe('divider', () => {
  it('uses ─ characters', () => {
    const result = divider();
    expect(result).toContain('─');
  });

  it('respects custom width', () => {
    const result = divider(30);
    const dashes = result.match(/─/g);
    expect(dashes?.length).toBe(30);
  });
});

describe('box', () => {
  it('wraps content in light box by default', () => {
    const result = box(['Hello']);
    expect(result).toContain('┌');
    expect(result).toContain('┐');
    expect(result).toContain('└');
    expect(result).toContain('┘');
    expect(result).toContain('│');
    expect(result).toContain('─');
    expect(result).toContain('Hello');
  });

  it('wraps content in heavy box when specified', () => {
    const result = box(['Hello'], 'heavy');
    expect(result).toContain('╔');
    expect(result).toContain('╗');
    expect(result).toContain('╚');
    expect(result).toContain('╝');
    expect(result).toContain('║');
    expect(result).toContain('═');
    expect(result).toContain('Hello');
  });

  it('handles multiple lines', () => {
    const result = box(['Line 1', 'Line 2', 'Line 3']);
    const lines = result.split('\n');
    // top + 3 content + bottom = 5 lines
    expect(lines.length).toBe(5);
  });

  it('pads shorter lines to match longest', () => {
    const result = box(['Short', 'A much longer line']);
    const lines = result.split('\n');
    // All content lines should have the same total length
    const contentLines = lines.slice(1, -1);
    const lengths = contentLines.map(l => l.length);
    expect(new Set(lengths).size).toBe(1);
  });
});

describe('errorBox', () => {
  it('contains the error message', () => {
    const result = errorBox('Something failed');
    expect(result).toContain('Something failed');
  });

  it('contains "Error:" label', () => {
    const result = errorBox('Bad thing');
    expect(result).toContain('Error:');
  });

  it('includes suggestion when provided', () => {
    const result = errorBox('No wallet', 'Run wallet generate');
    expect(result).toContain('Run wallet generate');
    expect(result).toContain('Suggestion:');
  });

  it('uses heavy box style', () => {
    const result = errorBox('Fail');
    expect(result).toContain('╔');
    expect(result).toContain('╝');
  });
});

describe('successMessage', () => {
  it('includes checkmark and message', () => {
    const result = successMessage('Transfer complete');
    expect(result).toContain('✓');
    expect(result).toContain('Transfer complete');
  });

  it('includes transaction hash when provided', () => {
    const result = successMessage('Done', 'abc123');
    expect(result).toContain('abc123');
    expect(result).toContain('Transaction');
  });

  it('omits transaction line when no hash', () => {
    const result = successMessage('Done');
    expect(result).not.toContain('Transaction');
  });
});
