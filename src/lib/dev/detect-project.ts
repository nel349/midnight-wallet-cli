// Project detection for `mn dev`.
// Finds .compact source files and determines how to invoke the Compact compiler.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface ProjectInfo {
  /** Absolute path to the project root (where package.json lives, or startDir if none). */
  projectRoot: string;
  /** Absolute paths to every .compact source file discovered. */
  sourceFiles: string[];
  /** Absolute paths to the directories that should be watched for .compact changes. */
  sourceDirs: string[];
  /**
   * Name of the npm script to invoke for compiling (e.g. "compact" or "compile"),
   * or null if no recognised script is defined.
   */
  compileScript: string | null;
  /**
   * True when `compileScript` is non-null. Kept for call-site readability —
   * equivalent to `compileScript !== null`.
   */
  hasNpmCompileScript: boolean;
  /**
   * Name of the npm script to invoke for tests (e.g. "test:dev" or "test"),
   * or null if no recognised script is defined.
   */
  testScript: string | null;
  /** Parsed package.json contents if one was found, else null. */
  packageJson: Record<string, unknown> | null;
}

/**
 * Candidate npm script names, in priority order. Different Compact project
 * templates use different names — `compact` is the Midnight-starship/create-mn-app
 * convention, `compile` is generic.
 */
const COMPILE_SCRIPT_CANDIDATES = ['compact', 'compile'] as const;

/**
 * Candidate npm script names for running tests, in priority order.
 * `test:dev` for projects that define a fast dev-loop test target;
 * `test` as the universal fallback (will still run whatever's wired).
 */
const TEST_SCRIPT_CANDIDATES = ['test:dev', 'test'] as const;

/**
 * Directories we scan for .compact files, relative to the start dir.
 * Matches the conventions `create-mn-app` and the `mn contract` commands use.
 */
const CANDIDATE_DIRS = ['.', 'contract/src', 'contract', 'src'] as const;

/**
 * Max directory depth we recurse into when searching for .compact files.
 * Prevents accidentally scanning node_modules or deep artifact trees.
 */
const MAX_SCAN_DEPTH = 4;

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'managed', 'target']);

export function detectProject(startDir: string): ProjectInfo {
  const rootDir = resolve(startDir);

  const sourceFiles = new Set<string>();
  const sourceDirs = new Set<string>();

  for (const candidate of CANDIDATE_DIRS) {
    const dir = resolve(rootDir, candidate);
    if (!existsSync(dir)) continue;
    findCompactFiles(dir, 0, sourceFiles, sourceDirs);
  }

  if (sourceFiles.size === 0) {
    throw new Error(
      `No .compact source files found under ${rootDir}\n` +
      `Run "mn dev" from a Midnight project directory (expected .compact files in ./, ./src, ./contract, or ./contract/src).`,
    );
  }

  // Walk up from each source dir looking for a package.json that exposes a
  // recognised compile script. Supports monorepos like midnight-starship
  // where .compact files live in a sub-package with its own package.json.
  const located = locateCompilerPackageJson([...sourceDirs], rootDir);
  const projectRoot = located?.dir ?? rootDir;
  const packageJson = located?.packageJson ?? parsePackageJson(join(rootDir, 'package.json'));
  const compileScript = located?.script ?? resolveCompileScript(packageJson);

  // Restrict watched sources to what lives under projectRoot — keeps the
  // watcher from recompiling when unrelated .compact files elsewhere in a
  // monorepo (e.g. exercises/) change.
  const scopedFiles = [...sourceFiles].filter((p) => isPathUnder(p, projectRoot)).sort();
  const scopedDirs = [...sourceDirs].filter((d) => isPathUnder(d, projectRoot)).sort();

  const testScript = resolveTestScript(packageJson);

  return {
    projectRoot,
    sourceFiles: scopedFiles.length > 0 ? scopedFiles : [...sourceFiles].sort(),
    sourceDirs: scopedDirs.length > 0 ? scopedDirs : [...sourceDirs].sort(),
    compileScript,
    hasNpmCompileScript: compileScript !== null,
    testScript,
    packageJson,
  };
}

function resolveTestScript(packageJson: Record<string, unknown> | null): string | null {
  for (const candidate of TEST_SCRIPT_CANDIDATES) {
    if (hasScript(packageJson, candidate)) return candidate;
  }
  return null;
}

function isPathUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const prefix = parent.endsWith('/') ? parent : parent + '/';
  return child.startsWith(prefix);
}

interface LocatedPackage {
  dir: string;
  packageJson: Record<string, unknown>;
  script: string;
}

/**
 * For each source dir, walk up toward rootDir looking for a package.json
 * that defines one of the recognised compile scripts. Returns the first
 * match (scanning is deterministic via the sorted sourceDirs order).
 */
function locateCompilerPackageJson(sourceDirs: string[], rootDir: string): LocatedPackage | null {
  for (const sourceDir of sourceDirs) {
    let dir = sourceDir;
    // Bound the walk at rootDir; don't escape above where the user launched.
    while (true) {
      const pkgPath = join(dir, 'package.json');
      const pkg = parsePackageJson(pkgPath);
      const script = resolveCompileScript(pkg);
      if (pkg && script) return { dir, packageJson: pkg, script };

      if (dir === rootDir) break;
      const parent = dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
  }
  return null;
}

function resolveCompileScript(packageJson: Record<string, unknown> | null): string | null {
  for (const candidate of COMPILE_SCRIPT_CANDIDATES) {
    if (hasScript(packageJson, candidate)) return candidate;
  }
  return null;
}

function parsePackageJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

function hasScript(packageJson: Record<string, unknown> | null, name: string): boolean {
  if (!packageJson) return false;
  const scripts = packageJson.scripts;
  if (!scripts || typeof scripts !== 'object') return false;
  return typeof (scripts as Record<string, unknown>)[name] === 'string';
}

function findCompactFiles(
  dir: string,
  depth: number,
  outFiles: Set<string>,
  outDirs: Set<string>,
): void {
  if (depth > MAX_SCAN_DEPTH) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.startsWith('.') || IGNORED_DIRS.has(entry)) continue;

    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }

    if (isDir) {
      findCompactFiles(full, depth + 1, outFiles, outDirs);
    } else if (entry.endsWith('.compact')) {
      outFiles.add(full);
      outDirs.add(dir);
    }
  }
}
