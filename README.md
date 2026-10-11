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

  > Break through internet censorship on **Windows, macOS and Linux**. No VPN, no drivers, no third-party tools, and nothing that permanently changes your network settings.

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
portable C. It uses nothing but the operating system's own socket API, so the
exact same technique works unprivileged on every platform. There is no kernel
driver, no WinDivert, no external library.

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
> stateless SNI/Host DPI. A raw-socket mode (`SHROUDLY_RAW`) is reserved for a
> future optional elevated build.

---

## Features

- **Cross-platform** — one engine, native builds for Windows, macOS and Linux (x64 and arm64).
- **No elevation, no driver** — runs as a normal user; nothing is installed into the kernel.
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

No administrator / root rights are required to run it.

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
```

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
      main.c                  CLI + stdin control protocol
    test/test_proto.c         unit tests
  electron/
    main.js                   app shell, tray, IPC, auto-start
    engine-manager.js         spawns shroudly-core, parses JSON, restarts
    system-proxy.js           set/restore OS proxy (Win/mac/Linux)
    tools/core/<os>-<arch>/   built engine binaries (per platform)
  app/ components/ contexts/  Next.js + React UI
  translations.js             15-language strings
  scripts/build-core.js       native + cross compile
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
