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
traffic through Shroudly as well, and for Roblox and other programs that ignore
it, so does [Games and apps mode](#games-and-apps-mode-roblox).

While Shroudly is active it points the system (or your browser) at its local
proxy, and it always restores the previous setting on stop, crash, or logout —
so your internet is never left broken.

How the system is pointed at it, on every OS and in both routing modes: a
proxy auto-config (PAC) file served on `127.0.0.1` (the first free port from
10840 to 10859), set as the system's automatic proxy configuration. Through
it every browser speaks SOCKS5 to Shroudly and leaves the name lookup to it.
This machine and the local network always connect directly; every other site
Shroudly routes goes only through it, never quietly around it. The one
exception is XFCE, LXQt and other desktops without a proxy setting: a browser
there keeps Shroudly's address from when it started, so whenever Shroudly is
not answering (stopped, quit, restarting) it connects directly instead of not
at all.

| System | Where the setting goes |
|---|---|
| Windows | The per-user automatic configuration script (no admin rights). Your own manual proxy setting is left as it is. |
| macOS | Automatic proxy configuration on every network service. An administrator account needs no password; a Standard account needs an administrator's password once per session (the setting then also stays through an engine restart), and Shroudly puts the setting back without asking again, also on logout or shutdown. Only after a restart of the Mac under it is the password asked for again, once (at login, or when Shroudly's window is next opened), never while quitting; if you dismiss it, Shroudly does not ask again by itself, and the window offers a button to put the settings back. |
| Linux, GNOME / Cinnamon / Unity / MATE | GNOME's proxy setting, in automatic mode. |
| Linux, KDE Plasma | KDE's proxy setting (`kioslaverc`), as a proxy configuration script. |
| Linux, XFCE / LXQt / window managers | These desktops have no system proxy. Firefox follows GNOME's setting wherever it is installed, so Shroudly sets that, and Firefox goes through Shroudly at once. Chrome, Edge, Brave and other Chromium browsers read the `auto_proxy` variable they were started with, so Shroudly writes it where the next login picks it up: `~/.config/environment.d/90-shroudly.conf`, LXQt's `~/.config/lxqt/session.conf` (`[Environment]`), or a marked block in `~/.xprofile` (XFCE and other X11 sessions), and into the systemd and D-Bus activation environment. After you log out and back in they go through Shroudly too; the window says which browsers are covered. A session that does not read these files (`startx`, or a Wayland compositor started from a text console) is noticed at the next login, and the window shows the address to set by hand instead. Chromium browsers and apps (VS Code, Slack, Discord) read the address when they start: one that was already open before Shroudly started may connect directly until it is reopened, and the window says so. |

On XFCE, LXQt and similar desktops these login entries stay while protection
is on, through quitting, logging out and crashes (a browser started while
Shroudly is not running finds nothing at that address and connects
directly; while Shroudly runs with protection off, the address answers
"connect directly"), and are removed exactly as they were found when you
switch protection off, or when Shroudly starts with protection off.
Uninstalling a Linux package cannot remove files in your home folder; switch
protection off before uninstalling, or delete
`~/.config/environment.d/90-shroudly.conf`, the `auto_proxy` line in
`~/.config/lxqt/session.conf` and the Shroudly block in `~/.xprofile`
yourself.

If another program (a VPN client, another proxy tool) takes the system proxy
over while Shroudly is on, Shroudly notices within a minute and says so, and
it does not undo that program's setting when it stops.

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

Since **2.5.5** it also carries the TCP techniques GoodbyeDPI and zapret use
and that users on Türk Telekom, Turkcell and Superonline rely on. Each is a flag
(`core/src/raw_desync.h`), and the common path is unchanged from earlier
releases:

- **Drops the forged resets** some networks inject to tear a blocked connection
  down (GoodbyeDPI `-p`). Only inbound 80/443 segments that match the forged
  signature are dropped — a payload-less RST whose IPv4 IP ID is in the tiny
  0x0–0xF range the reference tools key on (on Windows, an IPv6 RST with a zero
  flow label too; the Linux backend queues IPv4 only, as GoodbyeDPI's passive
  drop also does). A real server's reset normally carries a per-connection IP ID
  well above that window and is kept; the one genuine reset that lands inside it
  — Linux's socket-less reset for a closed port, sent with DF set and IP ID 0 —
  is recognised by that DF-with-zero-ID fingerprint and kept too, so a
  connection a real server refuses still fails fast. **On by default**, because
  it only ever removes a packet that matches the forged signature.
- **Measures the decoy's TTL** from the hop distance to the server, read off the
  SYN-ACK (GoodbyeDPI/zapret `autottl`), so the decoy dies just before the
  server instead of at a fixed guess; it falls back to the fixed TTL when the
  distance can't be measured. **On by default** (the decoy keeps its bad
  checksum, so a wrong guess still can't reach the server).
- **Sequence overlap** for the real first segment (zapret `split-seqovl`): the
  DPI reads overlap junk first while the server keeps the real bytes. Switchable,
  with a configurable size and pattern; **off by default**.
- **Faked split / faked disorder** (zapret `fakedsplit` / `fakeddisorder`): the
  ClientHello is split into two real segments with a low-TTL junk fake at the
  boundary, in order or with the second real part sent first. Selectable by
  flag; the decoy stays the proven plain fake **by default**.

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
says which, as a clue for whoever reads it. What Shroudly does about a network
is decided by what the network does, the same way everywhere: Advanced mode is
offered once a site connects and is then cut, never because of which country
the network resembles.
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

Discord app mode fixes it on Windows and macOS, without admin rights, for every
Discord build: Stable, PTB, Canary and Development. (Discord's Linux builds use
an older updater that does not read this setting.)

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

## Games and apps mode (Roblox)

Some programs bring their own HTTP library and never look at the system proxy.
The Roblox app and its installer are the best-known case: in Turkey, for
example, roblox.com opens in the browser through Shroudly while the installer
stops at *Continue installation without flag settings from
clientsettingscdn.roblox.com* and the app cannot reach a single Roblox server.
The one proxy setting they do read is the `HTTPS_PROXY` environment variable,
and so do many other games, launchers and command-line tools.

Games and apps mode sets it, on Windows and macOS, without admin rights:

- Shroudly runs a small HTTPS proxy on `127.0.0.1` (port 10810, or the next
  free one). It only tunnels (`CONNECT`), and only for this machine. Each
  tunnel goes to the engine **by name**, so the engine's encrypted DNS and its
  desync apply exactly as they do for the browser; while protection is off it
  goes out directly. The local network is always reached directly, and so
  are names your own DNS puts on a private network (a company's internal
  servers), which are never sent to public resolvers. A private answer that
  is a known block page (Iran's 10.10.34.34), and a `0.0.0.0` / `::` answer
  (how DNS filters say "blocked"), still go through the engine.
  With *only listed sites*, only listed sites go through the engine here
  too. Tunnels to this machine itself, or to link-local addresses, are
  refused.
- It puts `HTTPS_PROXY=http://127.0.0.1:10810` (and a `NO_PROXY` for the local
  network) in your session. On **macOS** that is `launchctl setenv`: every app
  the system starts afterwards gets it, from the Dock, from Finder, or from a
  browser opening a Roblox link — Roblox closes and starts itself again to join
  a game, and the new copy gets it too. It is held in memory and gone after
  logout. On **Windows** it is your user environment, and Explorer is told
  about the change: programs started from the Start menu, the desktop or File
  Explorer get it.
- A program reads it when it starts. If Roblox is already open, Shroudly offers
  to restart it. On Windows, a browser that was already open keeps its old
  environment, and so does everything it starts: the website's *Play* button
  and an installer opened from the download bar. So Shroudly starts Roblox
  itself: **Open Roblox** (Settings, under the mode) starts it, or the
  Bloxstrap / Fishstrap that handles Roblox's links, with the setting in
  place; **Install Roblox** (Windows) asks Roblox which version is current,
  downloads that installer through the engine, checks that it is signed by
  Roblox Corporation and starts it the same way. Starting Roblox from the
  Start menu works too.
- Shroudly checks what actually happens, not just that the setting was
  written: the first program, and the first Roblox connection, to go through
  it are logged, and on Windows a Roblox player that has been running for
  half a minute without a single request reaching Shroudly (started by an
  older browser) is reported within a minute, in the window and as a
  notification, with a button that restarts it through Shroudly. The
  Microsoft Store edition of Roblox runs in a sandbox that cannot reach
  Shroudly on this computer; the window says so.
- It is offered and explained in the app first, never done unasked. A proxy you
  set yourself (for your session or, on Windows, for the whole machine) is
  never replaced, and an `HTTPS_PROXY` of your own is never removed:
  `SHROUDLY_APP_PROXY`, set alongside, marks which value is Shroudly's.
- It is removed when you turn the mode off, when you quit Shroudly, at logout
  and shutdown, by a watchdog within a second if Shroudly is killed, at the
  next sign-in after a power cut (Windows), and by the Windows uninstaller. A
  program started without Shroudly connects as it always did. One that was
  started while the mode was on keeps the setting it started with until it
  is restarted; if such a program cannot connect after you quit Shroudly,
  restart it.

Game traffic itself (Roblox's UDP) does not use a proxy and goes direct; it is
the HTTPS part — sign-in, the game list, joining, assets — that filters block.

Linux has no single place every desktop reads the environment from, and Roblox
has no Linux client, so the mode is not offered there.

## What Shroudly cannot fix

Shroudly gets past filters on your network. It never changes your address, so
it cannot help when the **service itself** turns you away because of where you
are. Some services refuse whole countries: because a law there requires a
separate local edition (Roblox in Vietnam, for example, sends people to Roblox
VN), or because of sanctions or their own policy (some AI services, games and
stores). They decide from your address, account or payment country, and
getting past the network's block, which Shroudly does, only uncovers the
service's own refusal.

Shroudly tells the two apart the same way in every country, from what the
service does rather than from where you are: when a site answers but says it
does not serve you (HTTP 451, or a page saying the service is not available
in your country or region), the site test in Settings says so instead of
suggesting another technique, and a site whose own page keeps being cut off
(as often as Shroudly needs before it believes a cut) is checked once and
explained in the window. A plain "access denied" is not taken for a refusal:
storage and CDN servers answer that way to everyone. A site that completes
the handshake and then says nothing is reported with both possible causes,
because a network that stops connections once they are made looks exactly
the same from here. Only a connection that leaves from another country gets
around a real refusal, and the service may treat that as breaking its rules
(Roblox does).

---

## The automatic site list

By default everything goes through Shroudly, so no list is needed: any site
that is blocked opens, including ones nobody has heard of yet. Settings also
offer **only listed sites**, for people who want everything else to connect
directly. That list maintains itself:

- **Services, whole.** Each service is listed with every domain it needs: Roblox
  with its CDN, sign-in captcha and age check; YouTube with its video servers
  and the attestation host playback needs; Discord, Steam, Epic, Riot,
  Telegram, Signal, Wattpad and the rest likewise. A service listed without its
  CDN or captcha loads broken, which is worse than not listing it.
  ([`scripts/site-list/families.json`](scripts/site-list/families.json))
- **Measured every week.** A GitHub Actions job reads
  [OONI](https://ooni.org)'s measurements of the last 30 days in more than 30
  filtering countries, Turkey first. A site from
  [Citizen Lab's test lists](https://github.com/citizenlab/test-lists) that is
  blocked there is added. A site that has not been blocked anywhere for 90 days
  is dropped. The waiting period stops the list from flapping while a block
  comes and goes.
- **Within a policy.** Gambling, adult content, piracy, drugs and extremist
  material are never added, whatever the measurements say. Shared
  infrastructure (Google, Cloudflare, Akamai, AWS) is never listed whole, or
  half the internet would be routed by accident. Some sites are left out by
  the maintainer's decision because of where they stand legally in Turkey.
  They still open in the default mode.
  ([`scripts/site-list/policy.json`](scripts/site-list/policy.json))
- **Fail-safe.** A country whose data cannot be fetched changes nothing. A run
  that would shrink the list by more than half is refused. The app keeps
  the list it shipped with if the published one cannot be fetched or does not
  look right.
- **Published as data, not as commits.** The list lives on the `site-list`
  branch, so main's history stays readable. The app fetches it about once a
  day, only while protection is on and through the engine (see
  [Privacy](#privacy)).
- **Yours if you want it.** Edit the list in Settings and it becomes your own:
  it stops updating, until you choose *Use the automatic list* again.

## Features

- **One button** — start and stop protection; it can start with your computer, from the tray.
- **Light in the background** — the window is closed for real, not hidden, when it goes to the tray or sits unused for three minutes; protection keeps running without it, with nothing in the taskbar or the Dock, only the tray / menu bar icon. Protecting in the background, Shroudly 2.5.3 uses about 30–75 MB depending on the OS, about half of what 2.5.2 did ([measured](tests/e2e/app.test.js) by every [Tests](.github/workflows/test.yml) run).
- **Cross-platform** — native builds for Windows, macOS and Linux, x64 and ARM.
- **No admin rights, no driver** in the default mode — it runs as a normal program.
- **Learns what works** — tests each blocked site and remembers the technique that opens it; switches technique by itself if a network starts cutting a site.
- **Encrypted DNS** — on by default, over routes that are hard to block, refusing known forged answers.
- **Discord app mode** — lets the Discord app update and open through Shroudly on Windows and macOS ([details](#discord-app-mode)).
- **Games and apps mode** — Roblox, its installer and other programs that ignore the system proxy go through Shroudly too, on Windows and macOS ([details](#games-and-apps-mode-roblox)).
- **Advanced mode** — packet-level desync for networks that follow whole connections (Iran, China, Russia), on Windows and Linux.
- **Tells you what is going on** — another VPN or bypass tool fighting it, a site the network cuts, encrypted DNS blocked, a program that must be restarted: said plainly, with the fix one click away.
- **Never breaks your connection** — your proxy settings are saved before Shroudly changes them and put back on stop, crash, forced kill, shutdown, power loss (at next sign-in) and uninstall.
- **Routing** — everything through Shroudly (the default), or only the sites on a list, with the rest — banking, government — connecting directly. The list keeps itself current ([how](#the-automatic-site-list)); you can also write your own.
- **Port conflicts handled** — if another program holds its port, Shroudly moves to a free one and remembers it.
- **Honest live stats** — connections, bytes and techniques applied are real counters from the engine.
- **Automatic updates** — for every package: Windows, macOS, AppImage, `.deb`, `.rpm` and `.pacman`.
- **31 languages**, detected automatically, including those of the countries that filter the internet hardest (Azerbaijani, Persian, Russian, Turkmen, Burmese, Vietnamese and more).

## What it runs on

| | Minimum | Notes |
|---|---|---|
| Windows | **Windows 10** (x64 or ARM64) | The installer stops with a clear message on Windows 8.1 and earlier, which Electron no longer supports. |
| macOS | **macOS 12 Monterey** (Intel or Apple Silicon) | Older versions are told so by macOS itself rather than failing to launch. |
| Linux | **glibc 2.28+** — Debian 10, Ubuntu 18.04, Fedora 29 or newer | AppImage (x64, ARM64), plus native packages: .deb for Debian/Ubuntu, .pacman for Arch/Manjaro, .rpm for Fedora/openSUSE/RHEL. The bypass engine itself only needs glibc 2.17, so it is never the limiting part. |

Advanced mode needs administrator rights, and is available on Windows and Linux only.


### Languages

English, 中文, हिन्दी, Español, العربية, Русский, Português, Français, فارسی, Türkçe, বাংলা, اردو, Bahasa Indonesia, 日本語, Deutsch, Azərbaycanca, עברית, Tiếng Việt, Українська, Беларуская, Oʻzbekcha, Қазақша, Кыргызча, Türkmençe, Тоҷикӣ, پښتو, Kurdî (Kurmancî), မြန်မာ, ไทย, አማርኛ, Bahasa Melayu

The app opens in your system's language when it is one of these, and you can change it in Settings. Arabic, Persian, Urdu, Hebrew and Pashto are shown right to left.

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
it, or turn automatic installs off in Settings. While a Roblox game or Discord
goes through Shroudly (Games and apps mode, Discord app mode), the restart
waits until they are closed; after a few hours of waiting it also installs
once the computer has been left alone for ten minutes or is locked, and on
Windows and Linux at the next start, before protection comes on. Linux
packages ask for your password to install an update, as any system package
does.

> **The builds are not code-signed yet** (Windows signing is being set up, see the
> [code signing policy](#code-signing-policy)). On first launch Windows SmartScreen may
> show *"Windows protected your PC"* → click **More info → Run anyway**. On macOS
> Gatekeeper may block it: open it once, then **System Settings → Privacy &
> Security → Open Anyway** (on macOS 15 and later right-click → Open no longer
> offers that).

No administrator or root rights are needed to run it; only the optional
[Advanced mode](#advanced-mode-stateful-dpi) asks for them, and on a Standard
macOS account, setting the system proxy (see [What is Shroudly?](#what-is-shroudly)).

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
      engine.[ch]             SOCKS5/4/4a listener + relay
      raw_linux.[ch]          Advanced mode: NFQUEUE backend
      raw_windows.[ch]        Advanced mode: WinDivert backend
      supervise.[ch]          Advanced mode: stop / status-file handling
      watchdog.[ch]           --watchdog: has settings restored if the app is killed
      main.c                  CLI + stdin control protocol
    test/                     unit tests, sanitizer tests, fuzzers
  electron/
    main.js                   app shell, tray, IPC, auto-start
    engine-manager.js         spawns shroudly-core, parses JSON, restarts
    system-proxy.js           set/restore OS proxy (Win/mac/Linux), crash-safe
    restore-proxy.js          --restore-proxy: the login hook's and the watchdog's restore
    doh-forwarder.js          local DNS-over-HTTPS forwarder: routes, health, failover
    censor-fingerprints.js    known block-page / sinkhole addresses by country (OONI)
    diagnostics.js            what the log needs: OS, network, other VPNs, forged DNS
    discord-relay.js          Discord app mode: local relay for Discord's updater
    discord-app.js            Discord app mode: Discord's settings.json, restart
    app-proxy.js              Games and apps mode: local HTTPS proxy into the engine
    app-env.js                Games and apps mode: HTTPS_PROXY in the session, crash-safe
    roblox-app.js             Games and apps mode: finding and restarting Roblox
    watchdog.js               starts the engine's --watchdog and tells it what to look after
    proxy-watchdog.js         the same job in JavaScript, used only if the engine binary is missing
    updater.js                automatic updates from GitHub releases
    site-list.js              the automatic site list: fetch, check, keep
    data/sites.json           the site list as it was at release
    advanced-mode.js          Advanced mode: elevation (UAC / pkexec) + lifecycle
    main-i18n.js              tray + notification strings, read from locales/
    tools/core/<os>-<arch>/   built engine binaries (per platform)
  app/ components/ contexts/  Next.js + React UI
  locales/<code>.json         every string, one file per language (31)
  scripts/build-core.js       native + cross compile
  scripts/build-core-advanced.js   Advanced-mode engine build
  scripts/fetch-windivert.js       fetch + verify the WinDivert driver
  scripts/after-pack.js            stamp icon + version info into Shroudly.exe
  scripts/installer.nsh            Windows installer hooks (proxy reset, Discord and HTTPS_PROXY clean-up)
  scripts/site-list/               weekly site-list build: families, policy, OONI
  tests/net/                  network tests (fake censor, hostile servers, DNS, Discord, games and apps, site list, watchdog)
  tests/e2e/                  the real app driven end to end: window life cycle, memory per state
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
                         # games and apps mode (with the real Roblox installer
                         # on Windows CI), the block-page list, the Windows
                         # uninstaller hook
cd core && make test-asan fuzz   # sanitizers and fuzzing
```

The [Tests workflow](.github/workflows/test.yml) runs all of it on every push,
on Windows, Linux and macOS, x64 and ARM, and the engine tests a second time on
an AddressSanitizer/UBSan build.

---

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/),
certificate by [SignPath Foundation](https://signpath.org/).

- **What is signed:** the Windows installers (`Shroudly-<version>-Windows-x64-Setup.exe`
  and `-arm64-Setup.exe`). They are built from this repository by the
  [release workflow](.github/workflows/release.yml) on GitHub's own runners and
  sent to SignPath from there; nothing built elsewhere is signed. Bundled
  third-party binaries (Electron, the WinDivert driver) keep their own
  publishers' signatures.
- **Committers and reviewers:** [umutxyp](https://github.com/umutxyp). Changes from
  anyone else are reviewed before they are merged.
- **Approvers:** [umutxyp](https://github.com/umutxyp). Every release is approved by
  hand before it is signed.
- **Privacy:** see [Privacy](#privacy). Shroudly sends nothing about you to any
  server; the only things it contacts are listed there, and the one optional
  report, the anonymous live count, can be turned off in Settings.

macOS builds are not covered: Apple requires its own Developer ID for those.

---

## Privacy

Shroudly does not collect personal data. These are the only things that contact servers:

- **Live user count** (`shroudly.codeshare.me`): only while protection is on,
  and only if *Share online count* is left on in Settings, it sends a random
  id that is created fresh at every launch and never stored. It travels through
  the protected connection like everything else. The
  server only keeps those ids and when each was last seen, to count how many
  apps are online. An id disappears when the app quits or stops pinging. No IP
  addresses or other details are logged: the server keeps no access log, and it
  is reached through a Cloudflare tunnel, so it never sees your address anyway.
  The server code, with its service and web-server settings, is in
  [`server/stats`](server/stats/server.js).
- **Update checks** (GitHub): the app downloads the release feed from
  `github.com/umutxyp/Shroudly`.
- **The site itself**, when you test a site in Settings, when the front page
  of a site you use keeps being cut off, and Roblox's once Roblox connects
  through Games and apps mode: one request for its front page, through the
  protected connection and the way an ordinary browser makes it, to see
  whether the site turns you away itself.
- **The site list** (GitHub): about once a day, only while protection is on
  and through the protected connection, the app downloads
  [the published list](#the-automatic-site-list) from
  `raw.githubusercontent.com/umutxyp/Shroudly/site-list/sites.json`. It sends
  nothing but the request itself.
- **DNS lookups**, while DNS protection is on: names you visit are resolved
  over encrypted DNS by the resolvers listed under
  [Encrypted DNS routes](#encrypted-dns-routes), not by your provider.
- **Discord's update servers**, only with Discord app mode on: the relay asks
  them on the Discord app's behalf, exactly what Discord would have asked.

Games and apps mode contacts nothing of its own: it only carries what the
programs using it were going to send anyway.

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
