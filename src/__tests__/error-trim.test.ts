import { describe, it, expect } from 'vitest';
import { trimAgentMessage } from '../lib/error-trim.ts';

describe('trimAgentMessage', () => {
  it('returns the input unchanged when there are no suggestions or paragraphs', () => {
    expect(trimAgentMessage('Wallet sync timed out')).toBe('Wallet sync timed out');
  });

  it('drops everything after a blank line (paragraph break)', () => {
    const raw = 'Insufficient Funds: could not balance dust\n\nOn a fresh localnet, the minimum airdrop is ~1 NIGHT.\nTry: midnight airdrop 1';
    expect(trimAgentMessage(raw)).toBe('Insufficient Funds: could not balance dust');
  });

  it('drops trailing CLI-suggestion line ("midnight ...")', () => {
    const raw = 'Wallet file not found: /path/to/x.json\nGenerate a wallet first: midnight wallet generate <name> --network <name>';
    expect(trimAgentMessage(raw)).toBe('Wallet file not found: /path/to/x.json');
  });

  it('drops trailing "Try:" / "Run:" prefixed suggestions', () => {
    const raw = 'Insufficient dust for transaction fees.\nTry: midnight dust register';
    expect(trimAgentMessage(raw)).toBe('Insufficient dust for transaction fees.');
  });

  it('preserves multi-line FACTS that do not reference a CLI command', () => {
    const raw = 'Insufficient dust for transaction fees.\nAvailable: 0.300000 DUST, need ≥0.500000 DUST.\nDust regenerates over time from registered NIGHT UTXOs.';
    expect(trimAgentMessage(raw)).toBe(
      'Insufficient dust for transaction fees.\nAvailable: 0.300000 DUST, need ≥0.500000 DUST.\nDust regenerates over time from registered NIGHT UTXOs.',
    );
  });

  it('falls back to the first paragraph when every line looks like a suggestion', () => {
    // Pathological: the entire first paragraph IS a suggestion. Don't return ''.
    const raw = 'Try: midnight wallet list';
    expect(trimAgentMessage(raw)).toBe('Try: midnight wallet list');
  });

  it('handles an `mn` (alias) command in a suggestion line', () => {
    const raw = 'Cache is stale.\nRun mn cache clear --wallet alice and retry.';
    expect(trimAgentMessage(raw)).toBe('Cache is stale.');
  });

  it('does not over-trim a line that mentions "midnight" without a command shape', () => {
    // "the midnight chain" isn't `midnight <subcommand>` — should be kept.
    const raw = 'The midnight chain rejected the proof.\nAvailable: 5 NIGHT.';
    expect(trimAgentMessage(raw)).toBe('The midnight chain rejected the proof.\nAvailable: 5 NIGHT.');
  });
});
