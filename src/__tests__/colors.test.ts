import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isColorEnabled,
  fg, bg, bold, dim,
  teal, purple, red, green, yellow,
  midnightBlue, white, gray,
  TEAL, PURPLE, RED_CODE, GREEN_CODE, YELLOW_CODE,
  MIDNIGHT_BLUE, WHITE_CODE, DIM_GRAY,
} from '../ui/colors.ts';

const ESC = '\x1b[';
const RESET = '\x1b[0m';

describe('isColorEnabled', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore original env
    delete process.env.NO_COLOR;
    Object.assign(process.env, originalEnv);
  });

  it('returns true when NO_COLOR is not set', () => {
    delete process.env.NO_COLOR;
    expect(isColorEnabled()).toBe(true);
  });

  it('returns false when NO_COLOR is set', () => {
    process.env.NO_COLOR = '';
    expect(isColorEnabled()).toBe(false);
  });

  it('returns false when NO_COLOR is set to any value', () => {
    process.env.NO_COLOR = '1';
    expect(isColorEnabled()).toBe(false);
  });
});

describe('low-level helpers with colors enabled', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    delete process.env.NO_COLOR;
    Object.assign(process.env, originalEnv);
  });

  it('fg wraps text with 256-color foreground code', () => {
    const result = fg('hello', 38);
    expect(result).toBe(`${ESC}38;5;38mhello${RESET}`);
  });

  it('bg wraps text with 256-color background code', () => {
    const result = bg('hello', 17);
    expect(result).toBe(`${ESC}48;5;17mhello${RESET}`);
  });

  it('bold wraps text with bold code', () => {
    const result = bold('hello');
    expect(result).toBe(`${ESC}1mhello${RESET}`);
  });

  it('dim wraps text with dim code', () => {
    const result = dim('hello');
    expect(result).toBe(`${ESC}2mhello${RESET}`);
  });

  it('every color function appends RESET to prevent color bleed', () => {
    const functions = [
      () => fg('x', 100),
      () => bg('x', 100),
      () => bold('x'),
      () => dim('x'),
      () => teal('x'),
      () => purple('x'),
      () => red('x'),
      () => green('x'),
      () => yellow('x'),
      () => midnightBlue('x'),
      () => white('x'),
      () => gray('x'),
    ];

    for (const fn of functions) {
      const result = fn();
      expect(result.endsWith(RESET)).toBe(true);
    }
  });
});

describe('named shortcuts with colors enabled', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    delete process.env.NO_COLOR;
    Object.assign(process.env, originalEnv);
  });

  it('teal uses TEAL color code', () => {
    expect(teal('x')).toBe(fg('x', TEAL));
  });

  it('purple uses PURPLE color code', () => {
    expect(purple('x')).toBe(fg('x', PURPLE));
  });

  it('red uses RED_CODE', () => {
    expect(red('x')).toBe(fg('x', RED_CODE));
  });

  it('green uses GREEN_CODE', () => {
    expect(green('x')).toBe(fg('x', GREEN_CODE));
  });

  it('yellow uses YELLOW_CODE', () => {
    expect(yellow('x')).toBe(fg('x', YELLOW_CODE));
  });

  it('midnightBlue uses MIDNIGHT_BLUE', () => {
    expect(midnightBlue('x')).toBe(fg('x', MIDNIGHT_BLUE));
  });

  it('white uses WHITE_CODE', () => {
    expect(white('x')).toBe(fg('x', WHITE_CODE));
  });

  it('gray uses DIM_GRAY', () => {
    expect(gray('x')).toBe(fg('x', DIM_GRAY));
  });
});

describe('NO_COLOR mode — all helpers return plain text', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NO_COLOR = '';
  });

  afterEach(() => {
    delete process.env.NO_COLOR;
    Object.assign(process.env, originalEnv);
  });

  it('fg returns plain text', () => {
    expect(fg('hello', 38)).toBe('hello');
  });

  it('bg returns plain text', () => {
    expect(bg('hello', 17)).toBe('hello');
  });

  it('bold returns plain text', () => {
    expect(bold('hello')).toBe('hello');
  });

  it('dim returns plain text', () => {
    expect(dim('hello')).toBe('hello');
  });

  it('teal returns plain text', () => {
    expect(teal('hello')).toBe('hello');
  });

  it('purple returns plain text', () => {
    expect(purple('hello')).toBe('hello');
  });

  it('red returns plain text', () => {
    expect(red('hello')).toBe('hello');
  });

  it('green returns plain text', () => {
    expect(green('hello')).toBe('hello');
  });

  it('yellow returns plain text', () => {
    expect(yellow('hello')).toBe('hello');
  });

  it('midnightBlue returns plain text', () => {
    expect(midnightBlue('hello')).toBe('hello');
  });

  it('white returns plain text', () => {
    expect(white('hello')).toBe('hello');
  });

  it('gray returns plain text', () => {
    expect(gray('hello')).toBe('hello');
  });

  it('no ANSI escape codes present in any output', () => {
    const results = [
      fg('test', 38), bg('test', 17), bold('test'), dim('test'),
      teal('test'), purple('test'), red('test'), green('test'),
      yellow('test'), midnightBlue('test'), white('test'), gray('test'),
    ];
    for (const result of results) {
      expect(result).not.toContain('\x1b[');
    }
  });
});
