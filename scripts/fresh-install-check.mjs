// What a user gets from npm, checked: packs this package, installs the tarball
// into an empty directory (no lockfile there, as for any consumer), and checks
// that the dependency tree npm resolves today still works.
//
// The test suite runs on the lockfile's tree, which a consumer never sees. Two
// features broke that way without a test noticing: a newer @scure/base refused
// every shielded address, and a second copy of ledger-v8 made contract calls
// fail with "expected instance of LedgerParameters". A third thing only a
// packed install shows: a file the code reads at run time that the package's
// `files` list leaves out (the MCP server's core skill document was one).
//
//   node scripts/fresh-install-check.mjs      (after `npm run build`)

import { execFileSync, spawn } from 'node:child_process';
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

/**
 * Every resource the MCP server at `server` lists, read over stdio as an MCP
 * client would: its URI with the length of its text, or with the error.
 */
function readMcpResources(server, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(server, [], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const results = [];
    const waiting = new Map();
    let nextId = 0;
    let buffered = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('the MCP server did not answer in 60 s')); }, 60_000);
    const done = (outcome) => { clearTimeout(timer); child.kill(); outcome(); };
    const request = (method, params) => new Promise((answer) => {
      const id = ++nextId;
      waiting.set(id, answer);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    child.on('error', (error) => done(() => reject(error)));
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString();
      for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      }
    });
    (async () => {
      await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fresh-install-check', version: '1' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const listed = await request('resources/list', {});
      for (const { uri } of listed.result.resources) {
        const read = await request('resources/read', { uri });
        results.push({ uri, length: read.result?.contents?.[0]?.text?.length ?? 0, error: read.error?.message });
      }
      done(() => resolve(results));
    })().catch((error) => done(() => reject(error)));
  });
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

  // The MCP server reads its skill documents from the installed package.
  const resources = await readMcpResources(join(work, 'node_modules', '.bin', 'midnight-wallet-mcp'), { ...process.env, HOME: home });
  check('the MCP server lists its skill resources', resources.length >= 2, `${resources.length}`);
  for (const { uri, length, error } of resources) {
    check(`the MCP server serves ${uri}`, error === undefined && length > 0, error ? error.replace(work, '<install>') : `${length} characters`);
  }
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
