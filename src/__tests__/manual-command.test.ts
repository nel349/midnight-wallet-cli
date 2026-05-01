import { describe, it, expect } from 'vitest';
import { buildManual } from '../commands/manual.ts';

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('mn manual', () => {
  it('contains the canonical sections in order', () => {
    const m = stripAnsi(buildManual());
    const sections = [
      'NAME',
      'SYNOPSIS',
      'DESCRIPTION',
      'INSTALLATION',
      'CONCEPTS',
      'COMMANDS',
      'COMMON FLOWS',
      'CONFIGURATION',
      'JSON OUTPUT',
      'EXIT CODES',
      'TROUBLESHOOTING',
      'SEE ALSO',
    ];
    let cursor = 0;
    for (const section of sections) {
      const idx = m.indexOf(section, cursor);
      expect(idx, `expected ${section} after position ${cursor}`).toBeGreaterThanOrEqual(0);
      cursor = idx + section.length;
    }
  });

  it('renders every command from COMMAND_SPECS', () => {
    const m = stripAnsi(buildManual());
    const expected = [
      'wallet', 'balance', 'address', 'genesis-address', 'inspect-cost',
      'airdrop', 'transfer', 'dust', 'config', 'cache', 'localnet',
      'serve', 'test', 'dev', 'contract', 'help', 'manual',
    ];
    for (const cmd of expected) {
      expect(m, `missing entry for ${cmd}`).toContain(`▸ ${cmd}`);
    }
  });

  it('lists the stable error code strings', () => {
    const m = stripAnsi(buildManual());
    for (const code of [
      'DUST_REQUIRED', 'STALE_UTXO', 'PROOF_TIMEOUT', 'PROOF_FAILURE',
      'INVALID_DUST_PROOF', 'STALE_CACHE', 'SYNC_TIMEOUT',
    ]) {
      expect(m).toContain(code);
    }
  });

  it('documents the network-id config alias', () => {
    const m = stripAnsi(buildManual());
    expect(m).toContain('network-id');
  });

  it('documents exit codes 0 through 7', () => {
    const m = stripAnsi(buildManual());
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(m, `expected exit code ${n}`).toContain(`  ${n}  `);
    }
  });

  it('mentions "mn manual" in the SEE ALSO section indirectly via help/agent pointers', () => {
    const m = stripAnsi(buildManual());
    expect(m).toContain('mn help --agent');
    expect(m).toContain('mn help <command>');
  });

  it('produces non-trivial length (at least 200 lines)', () => {
    const m = stripAnsi(buildManual());
    expect(m.split('\n').length).toBeGreaterThanOrEqual(200);
  });
});
