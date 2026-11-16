#!/usr/bin/env node
'use strict';

/*
 * Signs remote.json (electron/remote-config.js: what it may hold) into
 * remote.json.sig, after checking the file is one the apps take: it parses,
 * its serial is higher than the one on main, and every key in it is known.
 *
 *   node scripts/sign-remote.js            sign (the key: SHROUDLY_REMOTE_KEY,
 *                                          else ~/Desktop/Shroudly/uzak-ayar-imza.pem)
 *   node scripts/sign-remote.js --check    only check remote.json.sig against remote.json
 *
 * The private key never goes into the repository or anywhere else.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const R = require('../electron/remote-config');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'remote.json');
const SIG = path.join(ROOT, 'remote.json.sig');
const KNOWN = new Set(['engineArgs', 'quicOff', 'torAllowed', 'torBridges', 'decoyNames', 'reportOffer']);

const text = fs.readFileSync(FILE, 'utf8');
const c = R.parse(text);
if (!c) { console.error('[remote] remote.json is not one the apps take (v: 1, a serial, set/rules as objects/arrays, not expired)'); process.exit(1); }
const sets = [c.set || {}, ...(c.rules || []).map((r) => (r && r.set) || {})];
for (const s of sets) for (const k of Object.keys(s)) if (!KNOWN.has(k)) { console.error(`[remote] unknown key "${k}": the apps would not read it`); process.exit(1); }
for (const s of sets) if (s.engineArgs !== undefined && R.engineArgs(s.engineArgs).length !== s.engineArgs.length) {
  console.error(`[remote] engineArgs holds something the apps refuse: ${JSON.stringify(s.engineArgs)} (allowed: ${Object.keys(R.ENGINE_ALLOWED).join(' ')})`); process.exit(1);
}

if (process.argv.includes('--check')) {
  const ok = fs.existsSync(SIG) && R.verify(text, fs.readFileSync(SIG, 'utf8'));
  console.log(ok ? `[remote] remote.json.sig checks (serial ${c.serial})` : '[remote] remote.json.sig does not check against remote.json');
  process.exit(ok ? 0 : 1);
}

const keyPath = process.env.SHROUDLY_REMOTE_KEY || path.join(os.homedir(), 'Desktop', 'Shroudly', 'uzak-ayar-imza.pem');
const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
const sig = crypto.sign('sha256', Buffer.from(text), key).toString('base64');
if (!R.verify(text, sig)) { console.error('[remote] the key does not match the public key the apps carry'); process.exit(1); }
fs.writeFileSync(SIG, sig + '\n');
console.log(`[remote] signed remote.json (serial ${c.serial})`);
