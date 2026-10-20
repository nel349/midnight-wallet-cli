// The account package's owner store conformance suite, run against mn's
// sealed owner store. The suite is written for node:test, so this file runs
// under `node --test`, driven by sealed-account.test.ts.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after } from 'node:test';
import { ownerStoreConformance } from '@kuiralabs/midnight-account-chain/testing';
import { createAccountKey, sealedOwnerStore } from '../lib/grant/sealed-account.ts';

const made: string[] = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

// A data key is made with the passphrase once, and every fresh store shares
// it: the suite asks for many stores, and each key costs a key derivation.
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-sealed-conformance-key-'));
made.push(keyDir);
const key = createAccountKey(keyDir, 'correct horse battery staple');

ownerStoreConformance('mn\'s sealed owner store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mn-sealed-conformance-'));
  made.push(dir);
  return sealedOwnerStore(dir, key);
});
