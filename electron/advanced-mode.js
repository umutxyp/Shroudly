'use strict';

/*
 * AdvancedMode — the optional packet-layer backend for STATEFUL DPI (Iran/China).
 *
 * The default engine (userspace proxy, split/disorder) defeats stateless DPI and
 * needs no privileges. When a probe reports a site stays blocked ("suggest":
 * "advanced"), the UI offers this mode. It is privileged and platform-specific:
 *
 *   Linux  : installs an nftables/iptables NFQUEUE rule on outbound 80/443 and
 *            runs shroudly-core-adv (libnetfilter_queue + raw sockets). Needs
 *            root / CAP_NET_ADMIN + CAP_NET_RAW.
 *   Windows: (planned) WinDivert backend.
 *   macOS  : (planned) pf/divert backend.
 *
 * Everything is reverted on stop/crash/exit: the firewall rule is always removed.
 */

const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const QUEUE_NUM = 200;

function advBinaryPath() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const plat = process.platform;
  const name = plat === 'win32' ? 'shroudly-core-adv.exe' : 'shroudly-core-adv';
  const rel = path.join('electron', 'tools', 'core', `${plat}-${arch}`, name);
  const packaged = __dirname.includes('app.asar');
  if (packaged) {
    const res = process.resourcesPath || path.join(__dirname, '..', '..', '..');
    return path.join(res, 'app.asar.unpacked', rel);
  }
  return path.join(__dirname, 'tools', 'core', `${plat}-${arch}`, name);
}

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, out) => err ? reject(err) : resolve(String(out || '')));
  });
}

class AdvancedMode {
  constructor(log) {
    this.log = log || (() => {});
    this.platform = process.platform;
    this.proc = null;
    this.active = false;
    this.ruleInstalled = false;
    this.fakeTtl = 4;
  }

  available() {
    // Advanced backend is built only where we have a packet layer implementation.
    return this.platform === 'linux' && fs.existsSync(advBinaryPath());
  }

  reason() {
    if (this.platform !== 'linux') {
      return `Advanced mode is not yet available on ${this.platform}. It is implemented on Linux today; Windows (WinDivert) and macOS (pf) backends are planned.`;
    }
    if (!fs.existsSync(advBinaryPath())) {
      return 'Advanced engine not built. Run: npm run build:core:advanced (needs libnetfilter-queue-dev).';
    }
    return null;
  }

  async _iptables(action) {
    // action: 'add' | 'del'. Try nft first, then iptables; both are reverted.
    const chainArgs = ['OUTPUT', '-p', 'tcp', '-m', 'multiport', '--dports', '80,443',
      '-j', 'NFQUEUE', '--queue-num', String(QUEUE_NUM), '--queue-bypass'];
    const flag = action === 'add' ? '-A' : '-D';
    try {
      await run('iptables', ['-t', 'mangle', flag, ...chainArgs], 6000);
      return true;
    } catch (e) {
      this.log('warning', `iptables ${action} failed: ${e.message}`);
      return false;
    }
  }

  async start(fakeTtl) {
    if (this.active) return { success: true, alreadyActive: true };
    const why = this.reason();
    if (why) { this.log('error', why); throw new Error(why); }
    this.fakeTtl = Number(fakeTtl) > 0 ? Number(fakeTtl) : 4;

    // 1. install the NFQUEUE firewall rule
    const ruleOk = await this._iptables('add');
    if (!ruleOk) throw new Error('Could not install firewall rule (need root / CAP_NET_ADMIN).');
    this.ruleInstalled = true;

    // 2. spawn the advanced engine
    const bin = advBinaryPath();
    const ready = await new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        this.proc = spawn(bin, ['--advanced', '--queue', String(QUEUE_NUM), '--fake-ttl', String(this.fakeTtl)],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { this.log('error', `spawn adv failed: ${e.message}`); return finish(false); }
      let buf = '';
      this.proc.stdout.on('data', (d) => {
        buf += d.toString(); let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          try { const m = JSON.parse(line); if (m.type === 'raw_ready') { this.log('success', `Advanced backend active (fake TTL ${m.ttl})`); finish(true); } }
          catch { this.log('info', `adv: ${line}`); }
        }
      });
      this.proc.stderr.on('data', (d) => { const t = d.toString().trim(); if (t) this.log('warning', `adv: ${t}`); });
      this.proc.on('error', (e) => { this.log('error', `adv error: ${e.message}`); finish(false); });
      this.proc.on('close', () => { this._onClose(); finish(false); });
      setTimeout(() => finish(false), 6000);
    });

    if (!ready) { await this._cleanup(); throw new Error('Advanced engine failed to start (check privileges / libnetfilter_queue).'); }
    this.active = true;
    return { success: true };
  }

  async _onClose() {
    if (!this.active) return;
    this.active = false;
    this.proc = null;
    this.log('warning', 'Advanced backend exited; removing firewall rule');
    if (this.ruleInstalled) { await this._iptables('del'); this.ruleInstalled = false; }
  }

  async stop() {
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
    if (this.ruleInstalled) { await this._iptables('del'); this.ruleInstalled = false; }
    this.active = false;
    this.log('success', 'Advanced mode stopped; firewall rule removed');
    return { success: true };
  }

  async _cleanup() {
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
    if (this.ruleInstalled) { await this._iptables('del').catch(() => {}); this.ruleInstalled = false; }
    this.active = false;
  }

  cleanupSync() {
    try { if (this.proc) this.proc.kill(); } catch {}
    if (this.ruleInstalled) {
      try {
        execFileSync('iptables', ['-t', 'mangle', '-D', 'OUTPUT', '-p', 'tcp', '-m', 'multiport',
          '--dports', '80,443', '-j', 'NFQUEUE', '--queue-num', String(QUEUE_NUM), '--queue-bypass'],
          { timeout: 4000 });
      } catch {}
      this.ruleInstalled = false;
    }
  }
}

module.exports = AdvancedMode;
