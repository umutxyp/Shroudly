<div align="center">
  <img src="public/logo.png" alt="Shroudly Logo" width="160"/>

  # Shroudly

  **Unseen. Unstoppable.**

  [![Release](https://img.shields.io/github/v/release/umutxyp/Shroudly)](https://github.com/umutxyp/Shroudly/releases/latest)
  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
  [![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron)](https://www.electronjs.org/)
  [![Next.js](https://img.shields.io/badge/Next.js-14-000000?logo=next.js)](https://nextjs.org/)
  [![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows)](#)
  [![macOS](https://img.shields.io/badge/macOS-000000?logo=apple)](#)
  [![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black)](#)

  > Break through internet censorship on **Windows, macOS and Linux**. No VPN, no drivers by default, no third-party tools, and nothing that permanently changes your network settings.

  **A [Codeshare](https://codeshare.me) product**
</div>

---

## What is Shroudly?

Shroudly runs a tiny local proxy and reshapes the **first packet** of each
connection — the one that carries the TLS SNI or the HTTP `Host` header — so that
Deep Packet Inspection (DPI) systems can no longer read which site you are
visiting. Your traffic still goes straight to the real server; only the DPI in
the middle is defeated.

It is built on its own engine, **`shroudly-core`**, written from scratch in
portable C. Its default mode uses nothing but the operating system's own socket
API, so the exact same technique works unprivileged on every platform — no
kernel driver, no WinDivert, no external library.

For countries with **stateful** DPI (Iran, China) there is an optional,
opt-in [Advanced mode](#advanced-mode-stateful-dpi) that works at the packet
layer. It needs administrator/root rights and, on Windows, the WinDivert
driver. It is never used unless you turn it on.

While Shroudly is active it points the system (or your browser) at its local
proxy, and it always restores the previous setting on stop, crash, or logout —
so your internet is never left broken.

---

## How it works

```
Without Shroudly:
  [Browser] --> [DPI reads SNI "example.com" -> BLOCKED] --> X

With Shroudly:
  [Browser] --> [shroudly-core local proxy]
                     |  splits / reorders the ClientHello so the SNI is never
                     |  readable in a single segment
                     v
                [DPI sees fragments it cannot reassemble -> passes]
                     v
                [Real server reassembles normally -> OK]
```

The engine inspects the first client payload, finds the exact SNI/Host position
(parsing the whole TLS ClientHello, even when it spans several TCP segments —
which modern post-quantum Chrome hellos routinely do), and applies a **desync
strategy**:

| Technique | What it does |
|-----------|--------------|
| **Split at SNI** | Sends the ClientHello in separate writes so the SNI is cut across segment boundaries. |
| **Disorder** | Sends the later segment first; the server's TCP stack reorders it correctly, a stateless DPI cannot. |
| **Mid-SNI / double split** | Extra split points inside and around the hostname for stubborn DPI. |
| **HTTP Host scramble** | Rewrites `Host:` casing for plain HTTP. |
| **Anti-poisoning DNS** | Resolves names against several independent public resolvers in parallel and drops spoofed / bogon answers, defeating DNS-based blocking without any encrypted-DNS dependency. |
| **Auto-probe** | Tests strategies against a host with a real handshake and remembers the one that works — like `goodbyeDPI`/`zapret` blockcheck, built in. |

> **Note on "fake packets".** Low-TTL decoy packets (as used by driver-based
> tools) require raw-socket injection and cannot be done correctly through a
> userspace proxy without corrupting the real stream. Shroudly therefore relies
> on split/disorder in its default driver-free mode, which is sufficient against
> stateless SNI/Host DPI (e.g. Turkey). Fake packets live in the separate,
> privileged [Advanced mode](#advanced-mode-stateful-dpi).

---

## Advanced mode (stateful DPI)

Iran's and China's DPI reassemble the whole TCP stream before inspecting it, so
splitting the ClientHello alone does not help. Advanced mode adds a
packet-layer backend, `shroudly-core-adv`. It injects a decoy copy of the first
packet with a low TTL, a bad TCP checksum and a scrambled SNI. The decoy reaches
the DPI and poisons its state, then dies before it reaches the real server.

- **Opt-in only.** It is offered in Settings only after a probe finds that a
  site stays blocked with the default engine.
- **Always reverted.** The firewall rule it installs is removed on stop, crash
  or exit.
- **Graceful fallback.** If the backend can't start, the default engine keeps
  running.

| OS | Backend | Needs | Status in v2.0.0 |
|----|---------|-------|------------------|
| Linux | NFQUEUE + raw socket (`iptables` rule) | root / `CAP_NET_ADMIN` + `CAP_NET_RAW`, `libnetfilter_queue` | Included (x64 only) |
| macOS | pf divert socket + raw socket (own pf anchor; no kext, no SIP changes) | root | Included |
| Windows | WinDivert 2.2 (signed driver) | Administrator + `WinDivert.dll` / `WinDivert64.sys` | **Not usable yet:** the driver is not bundled, so Settings shows it as unavailable |

> Shroudly does not ask for elevation by itself yet. On Linux and macOS, Advanced
> mode only starts when the app already has the privileges listed above.
> Otherwise it reports an error and stays on the default engine.

See [`core/src/CAPABILITIES.md`](core/src/CAPABILITIES.md) for the full threat
model and test results.

---

## Features

- **Cross-platform** — one engine, native builds for Windows, macOS and Linux (x64 and arm64).
- **No elevation, no driver** (default mode) — runs as a normal user; nothing is installed into the kernel.
- **Optional Advanced mode** — packet-layer fake-packet desync for stateful DPI (Iran/China), opt-in and privileged.
- **Never breaks your connection** — system proxy is snapshotted and restored on stop/crash/exit.
- **Real auto-probe** — finds and learns a working strategy per host.
- **Anti-poisoning resolver** — optional multi-resolver DNS that filters spoofed answers.
- **Honest live stats** — connections, bytes, TLS/HTTP seen and desyncs applied are real counters streamed from the engine, not estimates.
- **System tray, auto-start, auto mode** — per-OS login item on Windows/macOS, `.desktop` entry on Linux.
- **15 languages** with automatic detection.

### Languages

English, 中文, हिन्दी, Español, العربية, Русский, Português, Français, فارسی, Türkçe, বাংলা, اردو, Bahasa Indonesia, 日本語, Deutsch

---

## Install

**Latest version: [v2.0.0](https://github.com/umutxyp/Shroudly/releases/tag/v2.0.0)** — pick the file for your OS and CPU:

| OS | Intel / AMD (x64) | ARM (arm64) |
|----|-------------------|-------------|
| **Windows** | [Shroudly-2.0.0-x64.exe](https://github.com/umutxyp/Shroudly/releases/download/v2.0.0/Shroudly-2.0.0-x64.exe) | [Shroudly-2.0.0-arm64.exe](https://github.com/umutxyp/Shroudly/releases/download/v2.0.0/Shroudly-2.0.0-arm64.exe) |
| **macOS** | [Shroudly-2.0.0-mac.zip](https://github.com/umutxyp/Shroudly/releases/download/v2.0.0/Shroudly-2.0.0-mac.zip) (Intel) | [Shroudly-2.0.0-arm64-mac.zip](https://github.com/umutxyp/Shroudly/releases/download/v2.0.0/Shroudly-2.0.0-arm64-mac.zip) (Apple Silicon) |
| **Linux** | [Shroudly-2.0.0.AppImage](https://github.com/umutxyp/Shroudly/releases/download/v2.0.0/Shroudly-2.0.0.AppImage) · [shroudly_2.0.0_amd64.deb](https://github.com/umutxyp/Shroudly/releases/download/v2.0.0/shroudly_2.0.0_amd64.deb) | [Shroudly-2.0.0-arm64.AppImage](https://github.com/umutxyp/Shroudly/releases/download/v2.0.0/Shroudly-2.0.0-arm64.AppImage) |

- **Windows** — run the `.exe` installer.
- **macOS** — unzip and drag `Shroudly.app` into Applications.
- **Linux** — `chmod +x Shroudly-*.AppImage` and run it, or `sudo apt install ./shroudly_2.0.0_amd64.deb`.

> **The builds are not code-signed yet.** On first launch Windows SmartScreen may
> show *"Windows protected your PC"* → click **More info → Run anyway**. On macOS
> Gatekeeper may block it → right-click the app → **Open**, or allow it under
> **System Settings → Privacy & Security**.

Older versions are on the [Releases](https://github.com/umutxyp/Shroudly/releases) page.

No administrator / root rights are required to run it (only the optional
[Advanced mode](#advanced-mode-stateful-dpi) needs them).

---

## Build from source

**Requirements:** Node.js 20+, plus a C compiler. Any of these works:
- a system compiler (`cc`/`clang`/`gcc`, or MSVC `cl` on Windows), **or**
- [`zig`](https://ziglang.org/) (`npm i -g zig` or `pip install ziglang`) — this also lets one machine cross-build every OS.

```bash
git clone https://github.com/umutxyp/Shroudly.git
cd Shroudly
npm install            # also compiles shroudly-core for your OS

# run in dev
npm run electron:dev

# package for your OS
npm run dist:win       # or dist:mac / dist:linux

# cross-build the engine for every OS/arch from one machine
npm run build:core:all

# optional: the privileged Advanced-mode engine
npm run build:core:advanced   # or build:core:advanced:all to cross-build
```

Linux advanced builds need `libnetfilter-queue-dev` and `libmnl-dev`. On
Windows, Advanced mode also needs `WinDivert.dll` + `WinDivert64.sys` next to
`shroudly-core-adv.exe`. `npm run fetch:windivert` downloads the official
release, but you still have to copy those two files in by hand.

### Project layout

```
Shroudly/
  core/                       the engine - portable C, no dependencies
    src/
      platform.[ch]           OS abstraction (Winsock / BSD sockets, threads)
      proto.[ch]              TLS ClientHello + HTTP request parsing
      strategy.[ch]           desync strategy spec parser + presets
      desync.[ch]             applies a strategy to the first payload
      doh.[ch]                anti-poisoning DNS resolver
      probe.[ch]              per-host auto-probe
      engine.[ch]             SOCKS5 listener + relay
      raw_linux.[ch]          Advanced mode: NFQUEUE backend
      raw_macos.[ch]          Advanced mode: pf divert backend
      raw_windows.[ch]        Advanced mode: WinDivert backend
      main.c                  CLI + stdin control protocol
    test/test_proto.c         unit tests
  electron/
    main.js                   app shell, tray, IPC, auto-start
    engine-manager.js         spawns shroudly-core, parses JSON, restarts
    system-proxy.js           set/restore OS proxy (Win/mac/Linux)
    advanced-mode.js          Advanced mode: firewall rule + backend lifecycle
    tools/core/<os>-<arch>/   built engine binaries (per platform)
  app/ components/ contexts/  Next.js + React UI
  translations.js             15-language strings
  scripts/build-core.js       native + cross compile
  scripts/build-core-advanced.js   Advanced-mode engine build
```

---

## Engine control protocol

`shroudly-core` is a standalone program. The UI drives it over stdin and reads
JSON on stdout, but you can run it directly too:

```bash
shroudly-core --port 10808 --strategy "split(sni)" --auto --doh
# then point any app at socks5://127.0.0.1:10808
```

Commands on stdin: `STATS`, `PROBE <host>`, `STOP`.
Strategy syntax: `split(sni)`, `disorder(sni)`, `split(sni_mid)`,
`split(1),split(sni)`, `split(2)`, and so on.

---

## Testing

```bash
npm run test:core        # unit tests for protocol + strategy parsing
```

---

## Legal & responsible use

Shroudly exists to help people reach the free and open internet where it is
unjustly censored. You are solely responsible for complying with the laws that
apply to you. Do not use it to attack systems or to access things you are not
entitled to.

---

## License

MIT — see [LICENSE](LICENSE).

## Credits

- [Electron](https://www.electronjs.org/), [Next.js](https://nextjs.org/), [Tailwind CSS](https://tailwindcss.com/)
- Desync techniques inspired by the research behind `goodbyeDPI` and `zapret` — reimplemented independently in `shroudly-core`.

---

<div align="center">

**Shroudly — Unseen. Unstoppable.**

*A Codeshare Technology Ltd product*

</div>
