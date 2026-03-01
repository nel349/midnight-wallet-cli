// Operation animations for Midnight CLI
// Each animation is a standalone async function writing to stderr
// All respect NO_COLOR and accept AbortSignal for cancellation

import { teal, white, purple, green, red, bold, dim, isColorEnabled } from './colors.ts';
import { getMaterializeFrame, getWordmarkTypingFrame, getWordmarkMaterializeFrame, WORDMARK_BIG, MIDNIGHT_LOGO } from './art.ts';

const FRAME_MS = 80;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function clearLine(): void {
  process.stderr.write('\r\x1b[K');
}

function writeLine(text: string): void {
  process.stderr.write(`\r${text}\x1b[K`);
}

// Logo materialize: noise → resolved logo on left
// Right side: big wordmark types in (rows 0-2), then commands appear below
// sideContent[0..2] = wordmark lines, sideContent[3+] = commands
export async function animateMaterialize(signal?: AbortSignal, sideContent?: string[]): Promise<void> {
  const totalFrames = 20;
  const logoLines = MIDNIGHT_LOGO.split('\n');
  const logoLineCount = logoLines.length;
  const rightCol = 36; // column where right side starts
  const totalHeight = Math.max(logoLineCount, sideContent?.length ?? 0);
  const wordmarkLineCount = 3; // first 3 lines of sideContent are the wordmark

  if (!isColorEnabled()) {
    // Static render: side by side
    for (let j = 0; j < totalHeight; j++) {
      const left = (j < logoLineCount ? logoLines[j]! : '').padEnd(rightCol - 1);
      const right = sideContent?.[j] ?? '';
      process.stderr.write(left + right + '\n');
    }
    return;
  }

  // Render a full frame (totalHeight lines) — helper
  function renderFrame(frameLogoLines: string[], rightLines: (string | null)[]) {
    for (let j = 0; j < totalHeight; j++) {
      const left = j < frameLogoLines.length ? white(frameLogoLines[j]!) : '';
      const right = rightLines[j] ?? '';
      if (right) {
        process.stderr.write(left + `\x1b[${rightCol}G` + right + '\x1b[K\n');
      } else {
        process.stderr.write(left + '\x1b[K\n');
      }
    }
  }

  function moveUp() {
    process.stderr.write(`\x1b[${totalHeight}A`);
  }

  // Phase 1: Materialize logo (right side blank)
  for (let i = 0; i <= totalFrames; i++) {
    if (signal?.aborted) break;
    const progress = i / totalFrames;
    const frame = getMaterializeFrame(progress);
    const frameLines = frame.split('\n');

    if (i > 0) moveUp();
    renderFrame(frameLines, []);

    await sleep(FRAME_MS, signal);
  }

  // Phase 2: Type out big wordmark on right (columns reveal left-to-right)
  const typingFrames = 20;
  for (let i = 0; i <= typingFrames; i++) {
    if (signal?.aborted) break;
    const progress = i / typingFrames;
    const typedLines = getWordmarkTypingFrame(progress);

    moveUp();
    const rightLines: (string | null)[] = new Array(totalHeight).fill(null);
    for (let j = 0; j < typedLines.length; j++) {
      rightLines[j] = bold(white(typedLines[j]!));
    }
    renderFrame(logoLines, rightLines);

    await sleep(FRAME_MS, signal);
  }

  // Phase 3: Materialize flash on the wordmark (noise → resolved)
  const flashFrames = 12;
  for (let i = 0; i <= flashFrames; i++) {
    if (signal?.aborted) break;
    const progress = i / flashFrames;
    const flashedLines = getWordmarkMaterializeFrame(progress);

    moveUp();
    const rightLines: (string | null)[] = new Array(totalHeight).fill(null);
    for (let j = 0; j < flashedLines.length; j++) {
      rightLines[j] = bold(white(flashedLines[j]!));
    }
    renderFrame(logoLines, rightLines);

    await sleep(FRAME_MS, signal);
  }

  // Phase 4: Show commands (everything on right)
  moveUp();
  const fullRight: (string | null)[] = new Array(totalHeight).fill(null);
  if (sideContent) {
    for (let j = 0; j < sideContent.length; j++) {
      if (j < wordmarkLineCount) {
        fullRight[j] = bold(white(sideContent[j]!));
      } else {
        fullRight[j] = sideContent[j]!;
      }
    }
  }
  renderFrame(logoLines, fullRight);
}

// Sync animation: starfield dots with progress counter
export async function animateSync(
  onProgress: () => number | null, // returns 0-100 or null when done
  signal?: AbortSignal,
): Promise<void> {
  const starChars = ['·', '✦', '✧', '⋆', '∗'];
  let tick = 0;

  while (!signal?.aborted) {
    const progress = onProgress();
    if (progress === null) break;

    if (!isColorEnabled()) {
      writeLine(`Syncing... ${Math.round(progress)}%`);
    } else {
      const fieldWidth = 30;
      const stars = Array.from({ length: fieldWidth }, (_, i) => {
        const idx = (i + tick) % starChars.length;
        const visible = Math.random() < 0.3;
        return visible ? dim(starChars[idx]!) : ' ';
      }).join('');
      writeLine(`${dim(stars)} ${teal(`${Math.round(progress)}%`)}`);
    }

    tick++;
    await sleep(FRAME_MS * 2, signal);
  }

  clearLine();
}

// ZK proof animation: hex stream resolving to "PROVED ✓"
export async function animateProving(
  onProgress: () => number | null, // 0-100 or null when done
  signal?: AbortSignal,
): Promise<void> {
  const hexChars = '0123456789abcdef';
  const target = 'PROVED';

  while (!signal?.aborted) {
    const progress = onProgress();
    if (progress === null) break;
    const pct = Math.min(progress / 100, 1);

    if (!isColorEnabled()) {
      writeLine(`Proving... ${Math.round(progress)}%`);
    } else {
      const line = Array.from({ length: 20 }, (_, i) => {
        const charProgress = i / 20;
        if (pct > charProgress && i < target.length) {
          return green(target[i]!);
        }
        return purple(hexChars[Math.floor(Math.random() * hexChars.length)]!);
      }).join('');
      writeLine(`${line} ${dim(`${Math.round(progress)}%`)}`);
    }

    await sleep(FRAME_MS, signal);
  }

  if (!signal?.aborted) {
    writeLine(`${green(bold('PROVED ✓'))}\n`);
  }
}

// Transfer animation: byte flow trail ████░░░░████
export async function animateTransfer(
  onProgress: () => number | null, // 0-100 or null when done
  signal?: AbortSignal,
): Promise<void> {
  const width = 30;
  let tick = 0;

  while (!signal?.aborted) {
    const progress = onProgress();
    if (progress === null) break;
    const pct = Math.min(progress / 100, 1);

    if (!isColorEnabled()) {
      writeLine(`Transferring... ${Math.round(progress)}%`);
    } else {
      const filled = Math.floor(pct * width);
      const trailPos = (tick % (width - 4));
      const bar = Array.from({ length: width }, (_, i) => {
        if (i < filled) return teal('█');
        if (i >= trailPos && i < trailPos + 4) return dim('░');
        return ' ';
      }).join('');
      writeLine(`${bar} ${dim(`${Math.round(progress)}%`)}`);
    }

    tick++;
    await sleep(FRAME_MS, signal);
  }

  if (!signal?.aborted) {
    writeLine(`${teal('█'.repeat(width))} ${green('✓')}\n`);
  }
}

// Dust accumulation: dots slowly appearing
export async function animateDust(
  onProgress: () => number | null, // 0-100 or null when done
  signal?: AbortSignal,
): Promise<void> {
  const width = 30;

  while (!signal?.aborted) {
    const progress = onProgress();
    if (progress === null) break;
    const pct = Math.min(progress / 100, 1);

    if (!isColorEnabled()) {
      writeLine(`Dust accumulating... ${Math.round(progress)}%`);
    } else {
      const dots = Array.from({ length: width }, (_, i) => {
        const threshold = i / width;
        return pct >= threshold ? dim('·') : ' ';
      }).join('');
      writeLine(`${dots} ${purple(`${Math.round(progress)}%`)}`);
    }

    await sleep(FRAME_MS * 2, signal);
  }

  if (!signal?.aborted) {
    writeLine(`${'·'.repeat(width)} ${green('✓')}\n`);
  }
}

// Success: brief burst then clean message
export async function animateSuccess(message: string, signal?: AbortSignal): Promise<void> {
  if (!isColorEnabled()) {
    process.stderr.write(`✓ ${message}\n`);
    return;
  }

  const burstChars = ['✦', '✧', '⋆', '∗', '·'];
  // Brief burst effect
  for (let i = 0; i < 4; i++) {
    if (signal?.aborted) break;
    const burst = burstChars.slice(0, i + 1).map(c => green(c)).join(' ');
    writeLine(burst);
    await sleep(FRAME_MS, signal);
  }

  writeLine(`${green(bold('✓'))} ${message}\n`);
}

// Error: red flash on current line
export async function animateError(signal?: AbortSignal): Promise<void> {
  if (!isColorEnabled()) return;

  // Brief red flash
  for (let i = 0; i < 3; i++) {
    if (signal?.aborted) break;
    process.stderr.write(`\r\x1b[41m${' '.repeat(40)}\x1b[0m`);
    await sleep(60, signal);
    clearLine();
    await sleep(60, signal);
  }
}

// Idle: twinkling dots until cancelled
export async function animateIdle(signal: AbortSignal): Promise<void> {
  const dots = ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'];
  let tick = 0;

  while (!signal.aborted) {
    if (!isColorEnabled()) {
      writeLine('Waiting...');
    } else {
      const width = 20;
      const frame = Array.from({ length: width }, (_, i) => {
        const active = ((i + tick) % 8) < 2;
        return active ? dim(dots[(i + tick) % dots.length]!) : ' ';
      }).join('');
      writeLine(dim(frame));
    }

    tick++;
    await sleep(FRAME_MS * 2, signal);
  }

  clearLine();
}
