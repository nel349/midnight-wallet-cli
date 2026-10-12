// What a user gets from npm, checked: packs this package, installs the tarball
// into an empty directory (no lockfile there, as for any consumer), and checks
// that the dependency tree npm resolves today still works.
//
// The test suite runs on the lockfile's tree, which a consumer never sees. Two
// features broke that way without a test noticing: a newer @scure/base refused
// every shielded address, and a second copy of ledger-v8 made contract calls
// fail with "expected instance of LedgerParameters".
//
//   node scripts/fresh-install-check.mjs      (after `npm run build`)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = new URL('..', import.meta.url).pathname;
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Every installed copy of a package under `root`, as its versions. */
function copiesOf(root, name) {
  const found = [];
  const walk = (dir) => {
    const modules = join(dir, 'node_modules');
    if (!existsSync(modules)) return;
    const manifest = join(modules, name, 'package.json');
    if (existsSync(manifest)) found.push(JSON.parse(readFileSync(manifest, 'utf-8')).version);
    for (const entry of readdirSync(modules)) {
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@')) for (const scoped of readdirSync(join(modules, entry))) walk(join(modules, entry, scoped));
      else walk(join(modules, entry));
    }
  };
  walk(root);
  return found;
}

const failures = [];
const check = (what, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(what);
};

const work = mkdtempSync(join(tmpdir(), 'mn-fresh-install-'));
try {
  const tarball = run('npm', ['pack', '--pack-destination', work], repo).trim().split('\n').pop();
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'fresh-install-check', private: true }));
  run('npm', ['install', '--no-audit', '--no-fund', join(work, tarball)], work);

  const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf-8')).version;
  const mn = join(work, 'node_modules', '.bin', 'mn');
  check('the installed mn runs', run(mn, ['--version'], work).trim() === version, version);

  // One copy each: an object made by one copy of a WASM package is refused by another.
  for (const name of ['@midnight-ntwrk/ledger-v8', '@midnight-ntwrk/onchain-runtime-v3', '@midnight-ntwrk/compact-runtime']) {
    const copies = copiesOf(work, name);
    check(`one copy of ${name}`, copies.length === 1, copies.join(', '));
  }

  // A shielded address is longer than bech32's 90 characters; the address
  // library must still read the one the installed mn derives.
  const home = join(work, 'home');
  const wallet = JSON.parse(execFileSync(mn, ['wallet', 'generate', 'check', '--json'], {
    cwd: work, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, HOME: home },
  }));
  const address = wallet.shieldedAddresses.undeployed;
  const parsed = run(process.execPath, ['--input-type=module', '-e', `
    import { MidnightBech32m, ShieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
    try {
      MidnightBech32m.parse(${JSON.stringify(address)}).decode(ShieldedAddress, 'undeployed');
      console.log('parsed');
    } catch (error) {
      console.log(error.message);
    }
  `], join(work, 'node_modules', 'midnight-wallet-cli'));
  check('a shielded address parses', parsed.trim() === 'parsed' && address.length > 90, `${address.length} characters${parsed.trim() === 'parsed' ? '' : `, ${parsed.trim()}`}`);
} catch (error) {
  check('the fresh install and its checks ran', false, String(error.stderr || error.message).trim().split('\n').slice(-3).join(' | '));
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed on a fresh install. The lockfile's tree passes its tests; this one is what users get.`);
  process.exit(1);
}
console.log('\nA fresh install works.');
