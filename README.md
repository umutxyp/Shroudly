<div align="center">
  <img src="public/logo.png" alt="Shroudly Logo" width="160"/>

  # Shroudly

  **Unseen. Unstoppable.**

  [![Release](https://img.shields.io/github/v/release/umutxyp/Shroudly)](https://github.com/umutxyp/Shroudly/releases/latest)
  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
  [![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron)](https://www.electronjs.org/)
  [![Next.js](https://img.shields.io/badge/Next.js-14-000000?logo=next.js)](https://nextjs.org/)
  [![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows)](#)
  [![macOS](https://img.shields.io/badge/macOS-000000?logo=apple)](#)
  [![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black)](#)

  > Break through internet censorship on **Windows, macOS and Linux**. No VPN, no drivers by default, no third-party tools, and nothing that permanently changes your network settings.

  **A [Codeshare](https://codeshare.me) product**

  <br/>

  <a href="https://www.youtube.com/watch?v=Mb4Zkq1din8">
    <img src="https://img.youtube.com/vi/Mb4Zkq1din8/maxresdefault.jpg" alt="Shroudly launch video" width="720"/>
  </a>

  ▶ **[Watch the 2-minute launch video](https://www.youtube.com/watch?v=Mb4Zkq1din8)**
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

Names are looked up over encrypted DNS, so forged DNS answers — the most common
kind of blocking — stop working too. For the Discord app, whose own updater
ignores the system proxy, [Discord app mode](#discord-app-mode) brings that
traffic through Shroudly as well.

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
| **TLS record split** | Re-frames the handshake as two TLS records (allowed by RFC 8446 §5.1), with the name split between them. Beats filters that reassemble TCP, which plain splitting cannot. |
| **Split** | Sends the ClientHello as several TCP segments so the name is cut across segment boundaries. |
| **Disorder** | The halves really arrive out of order; the server's TCP stack reorders them, a stateless filter cannot. |
| **Out-of-band byte** | One byte goes as TCP urgent data: the server drops it from the stream, a filter that ignores the urgent pointer does not. |
| **Decoy (Linux)** | A first segment the server is guaranteed to discard (TCP signature option), so only the filter reads it. No privileges needed. |
| **HTTP Host scramble** | Rewrites `Host:` casing for plain HTTP. |
| **Encrypted DNS** | DNS-over-HTTPS over [17 routes from 6 operators](#encrypted-dns-routes); answers pointing at ~180 known block pages are refused. On by default. |
| **Auto-probe** | Opens each blocked site with a real handshake, trying combinations of the above, and remembers the one that works per site. If a site connects and is then cut, the next connection tries the next technique. |

> **Note on fake packets.** Low-TTL decoys like those used by driver-based tools
> need raw packet injection, which a userspace proxy cannot do without
> corrupting the real stream. They live in the separate, privileged
> [Advanced mode](#advanced-mode-stateful-dpi). The default mode's techniques
> are enough for filters that read the first packet (Turkey, for one).

---

## Advanced mode (stateful DPI)

Iran's and China's DPI reassemble the whole TCP stream before inspecting it, so
splitting the ClientHello alone does not help. Advanced mode adds a
packet-layer backend, `shroudly-core-adv`. It injects a decoy copy of the first
packet with a low TTL, a bad TCP checksum and a scrambled SNI. The decoy reaches
the DPI and poisons its state, then dies before it reaches the real server.

- **Opt-in.** Always available under Settings on Windows and Linux. Shroudly
  also offers it by itself when a network filters the way Iran's, China's or
  Russia's do, and when sites connect and are then cut.
- **Asks first.** Turning it on shows a Windows UAC prompt or a Linux password
  prompt (polkit). Shroudly itself keeps running as a normal user.
- **Always reverted.** The packet hook and any firewall rule go away on stop,
  on crash, and when Shroudly quits.
- **Graceful fallback.** If the backend can't start, the default engine keeps
  running.

| OS | Backend | Needs |
|----|---------|-------|
| Windows x64 | WinDivert 2.2 (signed driver, bundled) | Administrator (UAC prompt) |
| Linux x64 / arm64 | NFQUEUE + raw socket (`iptables`, else `nftables` rule) | Password prompt via `pkexec`, and libnetfilter_queue. The `.deb` brings it along; otherwise the app shows the command for your distribution: `sudo pacman -S libnetfilter_queue` (Arch), `sudo dnf install libnetfilter_queue` (Fedora/RHEL), `sudo zypper install libnetfilter_queue1` (openSUSE), `sudo apt install libnetfilter-queue1` (Debian/Ubuntu) |
| Windows on ARM | — | Not available: WinDivert has no ARM64 driver |
| macOS | — | Not possible: macOS has no packet-divert interface without an Apple-signed Network Extension |

> Some antivirus products flag WinDivert, as they do for every tool built on
> it. It is only loaded while Advanced mode is on.

See [`core/src/CAPABILITIES.md`](core/src/CAPABILITIES.md) for the full threat
model and test results.

---

## Where it works, and what it does about each kind of filter

Censors combine a few techniques, and each needs a different answer. What
Shroudly does on its own, without the user having to know any of this:

| Filter | Where (examples) | What Shroudly does |
|--------|------------------|--------------------|
| **Forged DNS answers** (block page, sinkhole, injected reply) | Turkey, Iran, Russia, Indonesia, India, Pakistan, China | Encrypted DNS over 17 routes from 6 operators (below). Plain-DNS answers that point at any of ~180 known block pages from 24 countries are refused. |
| **Blocked encrypted DNS** | Iran, China, Turkmenistan | Routes reached by address with no name to filter on, plus routes by name through the engine on addresses shared with millions of sites. Routes that fail rest and are retried; the one that works is remembered. |
| **Name (SNI) filtering on the first packet** | Turkey, Russia, India, Pakistan, many ISPs | Desync techniques, learned per site. |
| **Filters that follow the whole connection** | Iran, China, Russia | Noticed when a site connects and is then cut (a stall halfway through a record, a reset, a request never answered): the next connection tries another technique, and the user is told, with Advanced mode offered where the machine has it. |
| **Blocking by server address, protocol whitelisting, shutdowns** | Russia's throttling of some hosting providers, Iran during shutdowns | Cannot be fixed by any technique that leaves the address unchanged. Shroudly says so plainly and points to a VPN, rather than looking like it works. |

When DNS answers on a network match a country's known block pages, the log
says which, and on networks whose filters follow whole connections (Iran,
China, Russia, Turkmenistan, Belarus) Advanced mode is offered up front.
Another VPN or bypass tool running alongside (Cloudflare WARP, for one) is
named in the window until it is closed, because two tools rewriting the same
connections is the most common reason nothing works.

Block-page addresses come from [OONI's blocking fingerprints](https://github.com/ooni/blocking-fingerprints),
without anything in shared cloud space that could later belong to a real site.
Background: [Iran's 2026 shutdowns](https://arxiv.org/html/2603.28753v1),
[China's QUIC SNI filtering](https://gfw.report/publications/usenixsecurity25/en/),
[Russia's 16 KB throttling](https://en.zona.media/article/2025/06/19/cloudflare).

### Encrypted DNS routes

| Kind | Routes |
|------|--------|
| By address, no name in the handshake | Cloudflare (1.1.1.1, 1.0.0.1, 162.159.36.1, 162.159.46.1), Google (8.8.8.8, 8.8.4.4), Quad9 (9.9.9.9, 149.112.112.112), AdGuard unfiltered (94.140.14.140/141), OpenDNS (208.67.222.222/220.220), DNS.SB (185.222.222.222, 45.11.45.11) |
| By name, through the engine | Cloudflare's shared front end (104.16.248.249, 104.16.249.249), Mullvad (194.242.2.2) |

All over HTTP/2, one connection per route, each certificate checked against
the resolver it claims to be. Lookups race the best route, then two more of
other kinds, then the rest.

---

## Discord app mode

The Discord app checks for updates before it opens, with its own native
updater. That updater ignores the system proxy, so Shroudly never sees it. On
macOS and on older Windows it also speaks at most TLS 1.2, where the server's
certificate travels unencrypted: a filter can read `discord.com` in the
server's reply and cut the connection, and nothing done on the client side
helps, Advanced mode included. That is why Discord can sit on
*Checking for updates* while discord.com works in the browser.

Discord app mode fixes it on Windows and macOS, without admin rights. (Discord's
Linux builds use an older updater that does not read this setting.)

- Shroudly runs a small relay on `127.0.0.1` (port 10809, or the next free
  one). It forwards only `GET`/`HEAD` requests for Discord's own domains, and
  only from this machine.
- Each request goes to Discord over **TLS 1.3**, which keeps the certificate
  encrypted: through the engine while protection is on, directly while it is
  off. Download links and redirects come back through the relay too.
  Packages are passed on unchanged, and Discord checks each one against the
  SHA-256 in its manifest.
- To point Discord at the relay, Shroudly adds **one line to another app's
  file**: `"NEW_UPDATE_ENDPOINT": "http://127.0.0.1:10809/"` in Discord's
  `settings.json`. It is offered and explained in the app first, never done
  unasked. An endpoint you set yourself is never touched.
- The line is removed when you turn the mode off, when you quit Shroudly, and
  by the Windows uninstaller, so a Discord started without Shroudly connects
  as it always did. It stays across logout and shutdown, so a Discord that
  starts at login finds the relay as soon as Shroudly is up.
- Discord reads the line when it starts. If it is already open, Shroudly
  offers to restart it.
- On macOS, the system may ask once before Shroudly can change another app's
  files.

If Shroudly is removed on macOS without being quit first (after a crash, say),
delete that line from Discord's `settings.json` yourself.

---

## Features

- **One button** — start and stop protection; it can start with your computer, from the tray.
- **Cross-platform** — native builds for Windows, macOS and Linux, x64 and ARM.
- **No admin rights, no driver** in the default mode — it runs as a normal program.
- **Learns what works** — tests each blocked site and remembers the technique that opens it; switches technique by itself if a network starts cutting a site.
- **Encrypted DNS** — on by default, over routes that are hard to block, refusing known forged answers.
- **Discord app mode** — lets the Discord app update and open through Shroudly on Windows and macOS ([details](#discord-app-mode)).
- **Advanced mode** — packet-level desync for networks that follow whole connections (Iran, China, Russia), on Windows and Linux.
- **Tells you what is going on** — another VPN or bypass tool fighting it, a site the network cuts, encrypted DNS blocked, a program that must be restarted: said plainly, with the fix one click away.
- **Never breaks your connection** — your proxy settings are saved before Shroudly changes them and put back on stop, crash, forced kill, shutdown, power loss (at next sign-in) and uninstall.
- **Routing** — everything through Shroudly (the default), or only the sites on an editable list, with the rest — banking, government — connecting directly.
- **Port conflicts handled** — if another program holds its port, Shroudly moves to a free one and remembers it.
- **Honest live stats** — connections, bytes and techniques applied are real counters from the engine.
- **Automatic updates** — for every package: Windows, macOS, AppImage, `.deb`, `.rpm` and `.pacman`.
- **15 languages**, detected automatically.

## What it runs on

| | Minimum | Notes |
|---|---|---|
| Windows | **Windows 10** (x64 or ARM64) | The installer stops with a clear message on Windows 8.1 and earlier, which Electron no longer supports. |
| macOS | **macOS 12 Monterey** (Intel or Apple Silicon) | Older versions are told so by macOS itself rather than failing to launch. |
| Linux | **glibc 2.28+** — Debian 10, Ubuntu 18.04, Fedora 29 or newer | AppImage (x64, ARM64), plus native packages: .deb for Debian/Ubuntu, .pacman for Arch/Manjaro, .rpm for Fedora/openSUSE/RHEL. The bypass engine itself only needs glibc 2.17, so it is never the limiting part. |

Advanced mode needs administrator rights, and is available on Windows and Linux only.


### Languages

English, 中文, हिन्दी, Español, العربية, Русский, Português, Français, فارسی, Türkçe, বাংলা, اردو, Bahasa Indonesia, 日本語, Deutsch

---

## Install

These links always download the newest version (see [Releases](https://github.com/umutxyp/Shroudly/releases/latest) for notes and checksums):

| OS | Intel / AMD (x64) | ARM |
|----|-------------------|-----|
| **Windows 10+** | [Installer (.exe)](https://shroudly.codeshare.me/dl/windows-x64) | [Installer (.exe)](https://shroudly.codeshare.me/dl/windows-arm64) |
| **macOS 12+** | [Intel Macs (.dmg)](https://shroudly.codeshare.me/dl/macos-x64) | [Apple Silicon M1–M4 (.dmg)](https://shroudly.codeshare.me/dl/macos-arm64) |
| **Debian / Ubuntu / Mint** | [.deb](https://shroudly.codeshare.me/dl/linux-deb) | [AppImage](https://shroudly.codeshare.me/dl/linux-arm64) |
| **Arch / Manjaro / EndeavourOS** | [.pacman](https://shroudly.codeshare.me/dl/linux-pacman) | [AppImage](https://shroudly.codeshare.me/dl/linux-arm64) |
| **Fedora / openSUSE / RHEL** | [.rpm](https://shroudly.codeshare.me/dl/linux-rpm) | [AppImage](https://shroudly.codeshare.me/dl/linux-arm64) |
| **Any Linux** | [AppImage](https://shroudly.codeshare.me/dl/linux-x64) | [AppImage](https://shroudly.codeshare.me/dl/linux-arm64) |

- **Windows** — run the installer.
- **macOS** — open the `.dmg` and drag `Shroudly.app` into Applications.
- **Debian / Ubuntu** — `sudo apt install ./Shroudly-*-Linux-amd64.deb`
- **Arch** — `sudo pacman -U Shroudly-*-Linux-x64.pacman`
- **Fedora / RHEL** — `sudo dnf install ./Shroudly-*-Linux-x86_64.rpm`
- **openSUSE** — `sudo zypper install ./Shroudly-*-Linux-x86_64.rpm`
- **AppImage** — `chmod +x Shroudly-*.AppImage` and run it.

Every package is installed and started on its own system before a release is
published (Arch, Fedora, openSUSE, Debian, Ubuntu 22.04 and 24.04, both
AppImages, Windows x64 and ARM, both macOS images).

After that Shroudly updates itself: it checks when it starts and every 30
minutes, downloads in the background and installs on restart. You can postpone
it, or turn automatic installs off in Settings. Linux packages ask for your
password to install an update, as any system package does.

> **The builds are not code-signed yet.** On first launch Windows SmartScreen may
> show *"Windows protected your PC"* → click **More info → Run anyway**. On macOS
> Gatekeeper may block it → right-click the app → **Open**, or allow it under
> **System Settings → Privacy & Security**.

No administrator or root rights are needed to run it; only the optional
[Advanced mode](#advanced-mode-stateful-dpi) asks for them.

---

## Build from source

**Requirements:** Node.js 22.12+ (Electron 43's tooling needs it), plus a C compiler. Any of these works:
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
      doh.[ch]                DNS resolver (local DoH forwarder + UDP fallback)
      probe.[ch]              per-host auto-probe
      engine.[ch]             SOCKS5 listener + relay
      raw_linux.[ch]          Advanced mode: NFQUEUE backend
      raw_windows.[ch]        Advanced mode: WinDivert backend
      supervise.[ch]          Advanced mode: stop / status-file handling
      main.c                  CLI + stdin control protocol
    test/                     unit tests, sanitizer tests, fuzzers
  electron/
    main.js                   app shell, tray, IPC, auto-start
    engine-manager.js         spawns shroudly-core, parses JSON, restarts
    system-proxy.js           set/restore OS proxy (Win/mac/Linux), crash-safe
    doh-forwarder.js          local DNS-over-HTTPS forwarder: routes, health, failover
    censor-fingerprints.js    known block-page / sinkhole addresses by country (OONI)
    diagnostics.js            what the log needs: OS, network, other VPNs, forged DNS
    discord-relay.js          Discord app mode: local relay for Discord's updater
    discord-app.js            Discord app mode: Discord's settings.json, restart
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
  scripts/installer.nsh            Windows installer hooks (proxy reset, Discord clean-up)
  tests/net/                  network tests (fake censor, hostile servers, DNS, Discord)
  release-notes/              notes published with each release
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
Strategy syntax: `tlsrec(sni+1)`, `split(sni)`, `disorder(sni)`, `oob(sni+1)`,
`split(sni_mid)`, `split(1),tlsrec(sni+1)`, and so on.
Other options: `--doh-port <port>` (use a local DoH forwarder), `--block-ip <addr>`
(refuse DNS answers pointing at a block page; repeatable), `--ipv6`.

Events on stdout, one JSON object per line: `ready`, `stats`, `bypass` (a site
needed a technique), `blocked` (nothing worked), `cut` (a site connected and was
then cut: `stall`, `reset` or `noreply`), `probe`, `error`, `stopped`.

---

## Testing

```bash
npm run test:core        # engine unit tests (protocol, strategies, desync)
npm run test:net         # network tests: the engine against a fake censor and
                         # hostile servers, encrypted DNS on blocked networks
                         # and against impostor resolvers, Discord app mode,
                         # the block-page list, the Windows uninstaller hook
cd core && make test-asan fuzz   # sanitizers and fuzzing
```

The [Tests workflow](.github/workflows/test.yml) runs all of it on every push,
on Windows, Linux and macOS, x64 and ARM, and the engine tests a second time on
an AddressSanitizer/UBSan build.

---

## Privacy

Shroudly does not collect personal data. Two things contact servers:

- **Live user count** (`shroudly.codeshare.me`): only while protection is on,
  and only if *Share online count* is left on in Settings, it sends a random
  id that is created fresh at every launch and never stored. It travels through
  the protected connection like everything else. The
  server only keeps those ids and when each was last seen, in memory, to count
  how many apps are online. An id disappears when the app quits or stops
  pinging. No IP addresses or other details are logged. The server code is in
  [`server/stats-worker`](server/stats-worker/worker.js).
- **Update checks** (GitHub): the app downloads the release feed from
  `github.com/umutxyp/Shroudly`.
- **DNS lookups**, while DNS protection is on: names you visit are resolved
  over encrypted DNS by the resolvers listed under
  [Encrypted DNS routes](#encrypted-dns-routes), not by your provider.
- **Discord's update servers**, only with Discord app mode on: the relay asks
  them on the Discord app's behalf, exactly what Discord would have asked.

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
- Thanks to [Çağlar Sapmaz](https://github.com/caglarsapmaz) for reporting the Discord app's updater problem on macOS, confirming its TLS 1.2 cause and testing a fix on Türk Telekom.
- Censorship fingerprints from [OONI](https://ooni.org/)'s open [blocking-fingerprints](https://github.com/ooni/blocking-fingerprints) data.

---

<div align="center">

**Shroudly — Unseen. Unstoppable.**

*A Codeshare Technology Ltd product*

</div>
