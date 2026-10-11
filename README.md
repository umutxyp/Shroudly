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
opt-in [Advanced mode](#advanced-mode-stateful-dpi) for Windows and Linux that
works at the packet layer. It asks for administrator rights when you turn it
on and, on Windows, uses the bundled WinDivert driver. It is never used unless
you turn it on.

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
- **Asks first.** Turning it on shows a Windows UAC prompt or a Linux password
  prompt (polkit). Shroudly itself keeps running as a normal user.
- **Always reverted.** The packet hook and any firewall rule go away on stop,
  on crash, and when Shroudly quits.
- **Graceful fallback.** If the backend can't start, the default engine keeps
  running.

| OS | Backend | Needs |
|----|---------|-------|
| Windows x64 | WinDivert 2.2 (signed driver, bundled) | Administrator (UAC prompt) |
| Linux x64 / arm64 | NFQUEUE + raw socket (`iptables`, else `nftables` rule) | Password prompt via `pkexec`, and `libnetfilter-queue1` (the `.deb` pulls it in; AppImage users: `sudo apt install libnetfilter-queue1`) |
| Windows on ARM | — | Not available: WinDivert has no ARM64 driver |
| macOS | — | Not possible: macOS has no packet-divert interface without an Apple-signed Network Extension |

> Some antivirus products flag WinDivert, as they do for every tool built on
> it. It is only loaded while Advanced mode is on.

See [`core/src/CAPABILITIES.md`](core/src/CAPABILITIES.md) for the full threat
model and test results.

---

## Features

- **Cross-platform** — one engine, native builds for Windows, macOS and Linux (x64 and arm64).
- **No elevation, no driver** (default mode) — runs as a normal user; nothing is installed into the kernel.
- **Optional Advanced mode** — packet-layer fake-packet desync for stateful DPI (Iran/China), opt-in and privileged.
- **Never breaks your connection** — your proxy settings are saved before Shroudly changes them and put back on stop, crash, forced kill, shutdown, power loss (at next sign-in) and uninstall.
- **Real auto-probe** — finds and learns a working strategy per host.
- **Anti-poisoning resolver** — optional multi-resolver DNS that filters spoofed answers.
- **Honest live stats** — connections, bytes, TLS/HTTP seen and desyncs applied are real counters streamed from the engine, not estimates.
- **Live user count** — Stats shows how many people are using Shroudly right now (see [Privacy](#privacy)).
- **Automatic updates** — new releases from GitHub install themselves (Windows, macOS, Linux AppImage and .deb).
- **System tray, auto-start, auto mode** — per-OS login item on Windows/macOS, `.desktop` entry on Linux.
- **15 languages** with automatic detection.

### Languages

English, 中文, हिन्दी, Español, العربية, Русский, Português, Français, فارسی, Türkçe, বাংলা, اردو, Bahasa Indonesia, 日本語, Deutsch

---

## Install

**Latest version: [v2.0.7](https://github.com/umutxyp/Shroudly/releases/tag/v2.0.7)**: pick the file for your OS and CPU:

| OS | Intel / AMD (x64) | ARM |
|----|-------------------|-----|
| **Windows** | [Installer (.exe)](https://github.com/umutxyp/Shroudly/releases/download/v2.0.7/Shroudly-2.0.7-Windows-x64-Setup.exe) | [Installer (.exe)](https://github.com/umutxyp/Shroudly/releases/download/v2.0.7/Shroudly-2.0.7-Windows-arm64-Setup.exe) |
| **macOS** | Intel Macs: [.dmg](https://github.com/umutxyp/Shroudly/releases/download/v2.0.7/Shroudly-2.0.7-macOS-x64.dmg) · [.zip](https://github.com/umutxyp/Shroudly/releases/download/v2.0.7/Shroudly-2.0.7-macOS-x64.zip) | Apple Silicon (M1–M4): [.dmg](https://github.com/umutxyp/Shroudly/releases/download/v2.0.7/Shroudly-2.0.7-macOS-arm64.dmg) · [.zip](https://github.com/umutxyp/Shroudly/releases/download/v2.0.7/Shroudly-2.0.7-macOS-arm64.zip) |
| **Linux** | [AppImage](https://github.com/umutxyp/Shroudly/releases/download/v2.0.7/Shroudly-2.0.7-Linux-x86_64.AppImage) · [.deb (Debian/Ubuntu)](https://github.com/umutxyp/Shroudly/releases/download/v2.0.7/Shroudly-2.0.7-Linux-amd64.deb) | [AppImage](https://github.com/umutxyp/Shroudly/releases/download/v2.0.7/Shroudly-2.0.7-Linux-arm64.AppImage) |

Shroudly updates itself after that: it checks for new versions when it starts
and every 30 minutes, installs them in the background and restarts (you can
postpone it, or turn automatic installs off in Settings).

- **Windows** — run the `.exe` installer.
- **macOS** — open the `.dmg` (or unzip the `.zip`) and drag `Shroudly.app` into Applications.
- **Linux** — `chmod +x Shroudly-*.AppImage` and run it, or `sudo apt install ./Shroudly-2.0.7-Linux-amd64.deb`.

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

Linux advanced builds need `libnetfilter-queue-dev` and `libmnl-dev` (or, when
cross-building, a sysroot; see `scripts/build-core-advanced.js`). Windows
packages also need `npm run fetch:windivert`, which downloads the official
WinDivert release, verifies it and puts the driver next to
`shroudly-core-adv.exe`.

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
      raw_windows.[ch]        Advanced mode: WinDivert backend
      supervise.[ch]          Advanced mode: stop / status-file handling
      main.c                  CLI + stdin control protocol
    test/test_proto.c         unit tests
  electron/
    main.js                   app shell, tray, IPC, auto-start
    engine-manager.js         spawns shroudly-core, parses JSON, restarts
    system-proxy.js           set/restore OS proxy (Win/mac/Linux), crash-safe
    proxy-watchdog.js         restores the proxy if the app is killed
    updater.js                automatic updates from GitHub releases
    advanced-mode.js          Advanced mode: elevation (UAC / pkexec) + lifecycle
    main-i18n.js              tray + notification strings (15 languages)
    tools/core/<os>-<arch>/   built engine binaries (per platform)
  app/ components/ contexts/  Next.js + React UI
  translations.js             15-language strings
  scripts/build-core.js       native + cross compile
  scripts/build-core-advanced.js   Advanced-mode engine build
  scripts/fetch-windivert.js       fetch + verify the WinDivert driver
  scripts/after-pack.js            stamp icon + version info into Shroudly.exe
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

## Privacy

Shroudly does not collect personal data. Two things contact servers:

- **Live user count** (`shroudly.codeshare.me`): while the app runs, it sends a
  random id that is created fresh at every launch and never stored. The
  server only keeps those ids and when each was last seen, in memory, to count
  how many apps are online. An id disappears when the app quits or stops
  pinging. No IP addresses or other details are logged. The server code is in
  [`server/stats-worker`](server/stats-worker/worker.js).
- **Update checks** (GitHub): the app downloads the release feed from
  `github.com/umutxyp/Shroudly`.

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
