'use strict';

/* A stand-in for macOS's networksetup, for tests/net/system-proxy.test.js:
 * the services and their proxy settings live in a JSON file, and it answers
 * in the real tool's words — including its quirks: "Server: Port: 0" when no
 * SOCKS server is set, "URL: (null)" when no PAC is, and setting a server or
 * URL switching that proxy on. Every change is logged, so a test can see the
 * order things happened in.
 *
 * Used two ways: required by the test (as the unprivileged tool, which a
 * Standard account is refused), and run as a program by the shell script
 * that would run as root (FAKE_NS_STATE names the file). */

const fs = require('fs');

const HEAD = 'An asterisk (*) denotes that a network service is disabled.';

function fail(msg, code = 4) { const e = new Error(msg); e.status = code; throw e; }

function handle(state, args, { root = false } = {}) {
  const [verb, svc, ...rest] = args;
  if (verb === '-version') return 'networksetup version 1.0\n';
  if (verb === '-listallnetworkservices') return `${HEAD}\n${Object.keys(state.services).join('\n')}\n*Bluetooth PAN\n`;
  const s = state.services[svc];
  if (!s) fail(`** Error: The parameters were not valid.`);
  if (verb === '-getsocksfirewallproxy') {
    const p = s.socks;
    return `Enabled: ${p.enabled ? 'Yes' : 'No'}\n${p.server ? `Server: ${p.server}\nPort: ${p.port}` : 'Server: Port: 0\nPort: 0'}\nAuthenticated Proxy Enabled: 0\n`;
  }
  if (verb === '-getautoproxyurl') return `URL: ${s.auto.url || '(null)'}\nEnabled: ${s.auto.enabled ? 'Yes' : 'No'}\n`;
  if (state.denied && !root) fail('** Error: Command requires admin privileges.', 14);
  state.log.push([verb, svc, ...rest]);
  if (verb === '-setautoproxyurl') { s.auto.url = rest[0]; s.auto.enabled = true; }
  else if (verb === '-setautoproxystate') s.auto.enabled = rest[0] === 'on';
  else if (verb === '-setsocksfirewallproxy') { s.socks.server = rest[0]; s.socks.port = String(rest[1]); s.socks.enabled = true; }
  else if (verb === '-setsocksfirewallproxystate') s.socks.enabled = rest[0] === 'on';
  else fail(`unknown ${verb}`);
  return '';
}

function load(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function save(file, state) { fs.writeFileSync(file, JSON.stringify(state)); }

if (require.main === module) {
  const file = process.env.FAKE_NS_STATE;
  try {
    const state = load(file);
    process.stdout.write(handle(state, process.argv.slice(2), { root: true }));
    save(file, state);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(e.status || 1);
  }
}

module.exports = { handle, load, save };
