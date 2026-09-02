// Keep the per-platform dust-sync packages and the root `optionalDependencies`
// pinned to the root package version. Run after bumping the version, and in CI
// before publishing — the CLI must load only a sidecar binary built from the same
// ledger crate version, so these are exact-pinned, never a caret range.
//
//   node scripts/sync-sidecar-versions.mjs

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = JSON.parse(readFileSync('package.json', 'utf8'));
const version = root.version;

const optionalDependencies = { ...(root.optionalDependencies ?? {}) };
let synced = 0;
for (const dir of readdirSync('packages')) {
  if (!dir.startsWith('dust-sync-')) continue;
  const manifestPath = join('packages', dir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  optionalDependencies[manifest.name] = version; // exact pin
  synced++;
}

root.optionalDependencies = optionalDependencies;
writeFileSync('package.json', JSON.stringify(root, null, 2) + '\n');
console.log(`Synced ${synced} dust-sync platform package(s) + optionalDependencies to ${version}`);
