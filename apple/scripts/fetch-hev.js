#!/usr/bin/env node
'use strict';

/*
 * Fetches hev-socks5-tunnel for the Apple app into apple/third_party (not
 * committed), at the Android app's pin: the same release, commit and tree
 * hash (android/scripts/fetch-hev.js), so both apps carry the very same
 * tunnel and moving to a newer release is one change.
 *
 *   node apple/scripts/fetch-hev.js           fetch (or confirm) the pinned tree
 *   node apple/scripts/fetch-hev.js --verify  exit 1 unless what is there is the pinned tree
 */

const path = require('path');

process.env.SHROUDLY_HEV_DIR = path.join(__dirname, '..', 'third_party', 'hev-socks5-tunnel');
require('../../android/scripts/fetch-hev.js');
