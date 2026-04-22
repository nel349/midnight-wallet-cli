// Project detection for `mn dev`.
// Finds .compact source files and determines how to invoke the Compact compiler.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ProjectInfo {
  /** Absolute path to the project root (where package.json lives, or startDir if none). */
  projectRoot: string;
  /** Absolute paths to every .compact source file discovered. */
  sourceFiles: string[];
  /** Absolute paths to the directories that should be watched for .compact changes. */
  sourceDirs: string[];
  /** True when package.json defines an npm script named "compile". */
  hasNpmCompileScript: boolean;
  /** Parsed package.json contents if one was found, else null. */
  packageJson: Record<string, unknown> | null;
}

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
  const packageJsonPath = join(rootDir, 'package.json');
  const packageJson = parsePackageJson(packageJsonPath);

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

  return {
    projectRoot: rootDir,
    sourceFiles: [...sourceFiles].sort(),
    sourceDirs: [...sourceDirs].sort(),
    hasNpmCompileScript: hasScript(packageJson, 'compile'),
    packageJson,
  };
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
