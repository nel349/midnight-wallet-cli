// Midnight logo and animation frame data
// Static data module — no timers, no side effects

export const MIDNIGHT_LOGO = [
  '        ██████████████        ',
  '      ██              ██      ',
  '    ██      ██████      ██    ',
  '   ██       ██████       ██   ',
  '   ██                    ██   ',
  '   ██       ██████       ██   ',
  '   ██       ██████       ██   ',
  '    ██                  ██    ',
  '      ██              ██      ',
  '        ██████████████        ',
].join('\n');

export const WORDMARK = 'm i d n i g h t';

// Short descriptions for the compact horizontal help layout (≤30 chars each)
export const COMMAND_BRIEFS: [name: string, brief: string][] = [
  ['generate',        'Generate or restore a wallet'],
  ['info',            'Display wallet metadata'],
  ['balance',         'Check unshielded balance'],
  ['address',         'Derive address from seed'],
  ['genesis-address', 'Show genesis address'],
  ['inspect-cost',    'Display block limits'],
  ['airdrop',         'Fund from genesis wallet'],
  ['transfer',        'Send NIGHT tokens'],
  ['dust',            'Manage dust (fee tokens)'],
  ['config',          'Manage CLI config'],
  ['localnet',        'Manage local network'],
  ['help',            'Show command usage'],
];

// Characters used for noise/static effect
const NOISE_CHARS = ['░', '▒', '▓', '█', '·', ' '];

// Deterministic pseudo-random based on position — avoids flickering on same progress
function noiseChar(row: number, col: number, seed: number): string {
  const hash = ((row * 131 + col * 997 + seed * 7919) % 65537) / 65537;
  return NOISE_CHARS[Math.floor(hash * NOISE_CHARS.length)]!;
}

// Generate a materialize frame: 0.0 = all noise, 1.0 = clean logo
export function getMaterializeFrame(progress: number): string {
  const clamped = Math.max(0, Math.min(1, progress));
  const lines = MIDNIGHT_LOGO.split('\n');
  const seed = Math.floor(progress * 100); // stable per progress step

  if (clamped >= 1) return MIDNIGHT_LOGO;
  if (clamped <= 0) {
    return lines.map((line, row) =>
      Array.from(line).map((_, col) => noiseChar(row, col, 0)).join('')
    ).join('\n');
  }

  return lines.map((line, row) =>
    Array.from(line).map((ch, col) => {
      if (ch === ' ') return ' '; // preserve spacing structure
      // Each character has a threshold — resolve when progress passes it
      const threshold = ((row * 131 + col * 997) % 100) / 100;
      return clamped >= threshold ? ch : noiseChar(row, col, seed);
    }).join('')
  ).join('\n');
}

// Generate wordmark typing frame: 0.0 = empty, 1.0 = full wordmark
export function getWordmarkFrame(progress: number): string {
  const clamped = Math.max(0, Math.min(1, progress));
  const visibleChars = Math.floor(clamped * WORDMARK.length);
  return WORDMARK.slice(0, visibleChars);
}
