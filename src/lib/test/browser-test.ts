// Browser test — launch Claude to run a browser-based test.
// Supports three modes: vision (--chrome, screenshots), dom (accessibility tree), script (JS evaluation).

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { TestSuite, BrowserMode } from './types.ts';

export interface BrowserTestOptions {
  suite: TestSuite;
  prompt: string;
  dappDir: string;
  logFile: string;
  onMessage?: (msg: string) => void;
}

export interface BrowserTestResult {
  exitCode: number;
  logFile: string;
  timedOut: boolean;
}

// ── Prompt preambles ──

const DOM_PREAMBLE = `\
## Browser Automation Mode: DOM (Accessibility Tree)

You have chrome-devtools MCP tools available. You MUST follow these rules:

1. Use \`navigate_page\` to open URLs in Chrome.
2. Use \`take_snapshot\` to read the page — it returns a structured accessibility tree with element UIDs. This is your primary tool for understanding page state.
3. Use \`click\`, \`fill\`, and \`type_text\` with element UIDs from the snapshot to interact with the page.
4. Use \`press_key\` for keyboard input (Enter, Escape, Tab, etc.).
5. Only use \`take_screenshot\` for final visual verification or when the accessibility tree is insufficient.
6. Do NOT rely on screenshots for navigation — the accessibility tree is faster and more reliable.
7. After each interaction, take a new \`take_snapshot\` to verify the result.

---

`;

const SCRIPT_PREAMBLE = `\
## Browser Automation Mode: Script (Canvas App)

You have chrome-devtools MCP tools available. This is a canvas-based app — the accessibility tree will be empty. You MUST follow these rules:

1. Use \`navigate_page\` to open the URL in Chrome.
2. Use \`evaluate_script\` to dispatch keyboard input via \`window.dispatchEvent(new KeyboardEvent(...))\`.
3. Use \`evaluate_script\` to read DOM state (e.g., toast notifications via \`document.querySelector\`).
4. Use \`list_console_messages\` to monitor app output (contract addresses, errors, status changes).
5. Use \`take_screenshot\` at key checkpoints to verify visual state — but minimize usage (a few, not every step).
6. Do NOT use \`take_snapshot\` — the accessibility tree is empty for canvas content.
7. Between actions, use \`take_screenshot\` or \`list_console_messages\` to verify transitions — not rapid polling.

---

`;

/**
 * Resolve the effective browser mode from suite config.
 * - Explicit mode: use it directly
 * - 'auto' or omitted: default to 'vision' (backward compatible)
 *
 * Auto-detection (probing the live page to choose dom vs script vs vision)
 * is deferred to v2. For now, suite authors explicitly set the mode.
 */
export function resolveBrowserMode(suite: TestSuite): BrowserMode {
  const mode = suite.browserMode ?? 'vision';
  if (mode === 'auto') return 'vision';
  return mode;
}

/**
 * Launch Claude to run a browser-based test.
 * - Vision mode: Claude uses --chrome (screenshots + coordinate-based interaction)
 * - DOM mode: Claude uses chrome-devtools-mcp (accessibility tree + UID interaction)
 * - Script mode: Claude uses chrome-devtools-mcp (evaluate_script + test bridge)
 */
export async function runBrowserTest(options: BrowserTestOptions): Promise<BrowserTestResult> {
  const {
    suite,
    prompt,
    dappDir,
    logFile,
    onMessage = () => {},
  } = options;

  const timeout = (suite.timeout ?? 600) * 1_000;
  const mode = resolveBrowserMode(suite);

  // Ensure log directory exists
  mkdirSync(dirname(logFile), { recursive: true });
  const logStream = createWriteStream(logFile);

  const args: string[] = [];

  // Vision mode uses --chrome for built-in browser tools.
  // DOM and script modes use chrome-devtools-mcp (no --chrome flag).
  if (mode === 'vision') {
    args.push('--chrome');
  }

  args.push('--dangerously-skip-permissions');

  if (suite.model) {
    args.push('--model', suite.model);
  }
  if (suite.effort) {
    args.push('--effort', suite.effort);
  }

  // Prepend mode-specific preamble to the dApp-authored prompt
  let fullPrompt = prompt;
  if (mode === 'dom') {
    fullPrompt = DOM_PREAMBLE + prompt;
  } else if (mode === 'script') {
    fullPrompt = SCRIPT_PREAMBLE + prompt;
  }

  args.push('-p', fullPrompt);

  onMessage(`Launching Claude (mode: ${mode}, model: ${suite.model ?? 'default'}, timeout: ${suite.timeout ?? 600}s)`);

  return new Promise<BrowserTestResult>((resolve) => {
    const child = spawn('claude', args, {
      cwd: dappDir,
      // stdin + stderr inherit for display access and status output
      // stdout piped so we can tee to log file while also showing in terminal
      stdio: ['inherit', 'pipe', 'inherit'],
    });

    let timedOut = false;

    // Tee stdout to both terminal and log file
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    });

    // Timeout handler
    const timer = setTimeout(() => {
      timedOut = true;
      onMessage(`Timeout: test exceeded ${suite.timeout ?? 600}s`);
      child.kill('SIGTERM');
      // Force kill after 10 seconds
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 10_000).unref();
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      logStream.end();
      resolve({
        exitCode: code ?? 1,
        logFile,
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      logStream.end();
      onMessage(`Claude process error: ${err.message}`);
      resolve({
        exitCode: 1,
        logFile,
        timedOut: false,
      });
    });
  });
}
