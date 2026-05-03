// Screen discovery — walk a dApp UI source tree for likely page-level
// React components. Used by `mn test create --strategy ui` to give the
// user a numbered list of screens to scaffold a test for, rather than
// asking them to type a path.
//
// Heuristic-only: we don't import or parse the React tree, just scan
// .tsx files in conventional dApp UI directories and rank by signal.
// Misses are recoverable — the user can always type a free-form name.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

export interface ScreenCandidate {
  /** Slug derived from the component name (kebab-case). Used for the suite name. */
  name: string;
  /** PascalCase component name as it appears in the source. */
  component: string;
  /** Absolute filesystem path to the component file. */
  path: string;
  /** Relative path from the UI root, for display. */
  relativePath: string;
}

/**
 * Conventional locations where dApp UIs put their top-level views.
 * Order doesn't matter — we walk all that exist and merge.
 */
const SCAN_DIRS = ['src/components', 'src/pages', 'src/screens', 'src/views'] as const;

/** TSX-only — JSX-in-JS dApps are rare on Midnight. Easy to add .jsx if needed. */
const VIEW_EXT = '.tsx';

/**
 * Walk known UI directories under `uiRoot` and return components that look
 * like screens. Returned in alphabetical order by name for stable presentation.
 *
 * Returns empty when no scan dir exists — caller decides whether to fall back
 * to a free-form prompt or report a hint to the user.
 */
export function discoverScreens(uiRoot: string): ScreenCandidate[] {
  const out = new Map<string, ScreenCandidate>();

  for (const sub of SCAN_DIRS) {
    const dir = join(uiRoot, sub);
    if (!existsSync(dir)) continue;
    walkForScreens(dir, uiRoot, out);
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Walk a given directory directly (no `src/components` requirement) and
 * return screen candidates. Used when the user hands us a path that is
 * itself the components directory — common in monorepos where the UI
 * lives in a workspace child like `<dappDir>/<name>-ui/src/components/`.
 *
 * `displayRoot` controls how the relative path on each candidate is
 * rendered for display. Defaults to `dir` itself.
 */
export function discoverScreensInDir(dir: string, displayRoot: string = dir): ScreenCandidate[] {
  if (!existsSync(dir)) return [];
  const out = new Map<string, ScreenCandidate>();
  walkForScreens(dir, displayRoot, out);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function walkForScreens(dir: string, uiRoot: string, out: Map<string, ScreenCandidate>): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      // One level of recursion is enough for the projects we see in the wild
      // (nested layout components are rarely top-level screens). Going deeper
      // means more noise to filter; skip subdirs whose name suggests they're
      // implementation details, not pages.
      if (LAYOUT_DIRS.has(entry.toLowerCase())) continue;
      walkForScreens(fullPath, uiRoot, out);
      continue;
    }

    if (extname(entry) !== VIEW_EXT) continue;
    if (entry.endsWith('.test.tsx') || entry.endsWith('.spec.tsx')) continue;

    const component = basename(entry, VIEW_EXT);
    if (!looksLikeScreen(component, fullPath)) continue;

    const name = toKebabCase(component);
    if (out.has(name)) continue; // first match wins; later duplicates ignored

    out.set(name, {
      name,
      component,
      path: fullPath,
      relativePath: relative(uiRoot, fullPath),
    });
  }
}

/**
 * Subdirectory names that signal "this is layout/infrastructure, not a page."
 * Skipped during recursion to keep the candidate list focused on real screens.
 */
const LAYOUT_DIRS = new Set(['layout', 'layouts', 'shared', 'common', 'ui', 'icons', 'styles']);

/**
 * A file looks like a screen when:
 *   - filename is PascalCase (React component convention), AND
 *   - source contains a top-level export — `export default`, `export const Foo =`,
 *     or `export function Foo`. This filters out type-only files, hook helpers,
 *     and generic utility components that happen to be .tsx.
 *
 * The check is intentionally cheap (one regex sweep over the file). False
 * positives are recoverable (user picks a different option or types their own).
 */
function looksLikeScreen(component: string, filePath: string): boolean {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(component)) return false;

  let source: string;
  try {
    source = readFileSync(filePath, 'utf-8');
  } catch {
    return false;
  }

  return EXPORT_PATTERN.test(source);
}

const EXPORT_PATTERN = /\bexport\s+(default\b|const\s+[A-Z]|function\s+[A-Z])/;

/** PascalCase → kebab-case. `LoanRequestForm` → `loan-request-form`. */
function toKebabCase(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}
