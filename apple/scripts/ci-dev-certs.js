#!/usr/bin/env node
// The release job signs iOS and macOS with automatic signing, and each run's
// fresh machine gets a new "Apple Development: Created via API" certificate
// from Apple. They pile up until the account reaches Apple's limit and the
// next archive fails. This lists those certificates before the archive and
// revokes, at the end, only the ones that appeared during this run:
//
//   node apple/scripts/ci-dev-certs.js list > before.txt
//   node apple/scripts/ci-dev-certs.js revoke-new before.txt
//
// Never touches distribution certificates or any certificate that existed
// before the run. Needs ASC_KEY_ID, ASC_ISSUER_ID and the .p8 key at ASC_KEY_PATH.
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const NAME = 'Apple Development: Created via API';

function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', kid: process.env.ASC_KEY_ID, typ: 'JWT' });
  const body = b64({ iss: process.env.ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' });
  const key = crypto.createPrivateKey(fs.readFileSync(process.env.ASC_KEY_PATH));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

function call(method, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.appstoreconnect.apple.com', path, method,
      headers: { Authorization: `Bearer ${token()}` },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function devCerts() {
  const r = await call('GET', '/v1/certificates?limit=200&filter[certificateType]=DEVELOPMENT&fields[certificates]=name,certificateType');
  if (r.status !== 200) throw new Error(`list: HTTP ${r.status}`);
  return JSON.parse(r.body).data
    .filter((c) => c.attributes.certificateType === 'DEVELOPMENT' && c.attributes.name === NAME)
    .map((c) => c.id);
}

async function main() {
  const [cmd, file] = process.argv.slice(2);
  if (cmd === 'list') {
    process.stdout.write((await devCerts()).join('\n') + '\n');
    return;
  }
  if (cmd === 'revoke-new' && file) {
    const before = new Set(fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean));
    const fresh = (await devCerts()).filter((id) => !before.has(id));
    for (const id of fresh) {
      const r = await call('DELETE', `/v1/certificates/${id}`);
      console.log(`${r.status === 204 ? 'revoked' : `HTTP ${r.status}`}  ${id}`);
    }
    if (!fresh.length) console.log('no new development certificate');
    return;
  }
  console.error('usage: ci-dev-certs.js list | revoke-new <file>');
  process.exit(2);
}

main().catch((e) => { console.error(`ci-dev-certs: ${e.message}`); process.exit(1); });
