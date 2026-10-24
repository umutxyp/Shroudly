<div align="center">
  <img src="public/logo.png" alt="Shroudly Logo" width="160"/>

  # Shroudly

  **Unseen. Unstoppable.**

  [![Release](https://img.shields.io/github/v/release/umutxyp/Shroudly)](https://github.com/umutxyp/Shroudly/releases/latest)
  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
  [![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron)](https://www.electronjs.org/)
  [![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js)](https://nextjs.org/)
  [![Windows](https://img.shields.io/badge/Windows-0078D6?logo=windows)](#)
  [![macOS](https://img.shields.io/badge/macOS-000000?logo=apple)](#)
  [![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black)](#)
  [![Android](https://img.shields.io/badge/Android-3DDC84?logo=android&logoColor=white)](#android)

  > Break through internet censorship on **Windows, macOS, Linux and Android**. No VPN, no drivers by default, no third-party tools, and nothing that permanently changes your network settings.

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

For networks with **stateful** DPI, which follows whole connections, there is
[Advanced mode](#advanced-mode-stateful-dpi) for Windows and Linux, which works
at the packet layer. It needs administrator rights and, on Windows, uses the
bundled WinDivert driver. It is only used when a site needs it or when you turn
it on, and the system asks for your permission first.

Names are looked up over encrypted DNS, so forged DNS answers — the most common
kind of blocking — stop working too. For the Discord app, whose own updater
ignores the system proxy, [Discord app mode](#discord-app-mode) brings that
traffic through Shroudly as well, and for Roblox, Roblox Studio and other
programs that ignore it, so does [Games and apps mode](#games-and-apps-mode-roblox).

Nobody has to know any of this. The [autopilot](#autopilot) notices what is in
the way and turns on what is needed by itself, then says what it did in one
line.

On **Android** the same engine runs inside the app, which works as a local
VPN: every app on the phone goes through Shroudly, games and voice calls
included, with nothing to turn on ([details](#android)).

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
| **TLS record split** | Re-frames the handshake as two TLS records (allowed by RFC 8446 §5.1), with the name split between them: just after its first byte, in its middle, or one byte before its end (ByeByeDPI's `-r-1+se`, which opens YouTube's video servers in Iran). Beats filters that reassemble TCP, which plain splitting cannot. |
| **Split** | Sends the ClientHello as several TCP segments so the name is cut across segment boundaries. |
| **Disorder** | The halves really arrive out of order; the server's TCP stack reorders them, a stateless filter cannot. |
| **Out-of-band byte** | One byte goes as TCP urgent data: the server drops it from the stream, a filter that ignores the urgent pointer does not. |
| **Decoy (Linux)** | A first segment the server is guaranteed to discard (TCP signature option), so only the filter reads it. No privileges needed. |
| **HTTP Host scramble** | Rewrites `Host:` casing for plain HTTP. |
| **Encrypted DNS** | DNS-over-HTTPS over [17 routes from 6 operators](#encrypted-dns-routes); answers pointing at ~180 known block pages are refused. On by default. |
| **Your own DNS server** | Optional (desktop Settings → DNS server, Android About → Settings → DNS server; [#34](https://github.com/umutxyp/Shroudly/issues/34)): DNS over HTTPS, DNS over TLS, DNS over TCP (for networks that block or forge UDP port 53 but leave TCP alone) or plain DNS, by address or by name. It is asked once before it is used and the answer shown. DoH and DoT go through the engine like any site; a server's name is looked up over the built-in encrypted DNS, never the network's. If it stops answering, the built-in encrypted DNS answers until it is back, and the log says so; with **Only this server** ticked nothing else is ever asked, and lookups fail until it answers. A "server failure" (SERVFAIL) answer, which a validating resolver gives for a name whose DNSSEC signatures are wrong, is taken as the answer and never asked of anyone else. On Android DoH speaks HTTP/1.1 (as the built-in routes there), so a server that accepts only HTTP/2 answers on the desktop only. |
| **Block ads and trackers** | Optional, off by default (desktop Settings, Android About). Names on Shroudly's ad and tracker list get 0.0.0.0 / `::` or have their connection ended inside the engine, in every app; nothing is fetched for them. The list is combined every week from [AdGuard DNS filter](https://github.com/AdguardTeam/AdGuardSDNSFilter), [HaGeZi's Multi PRO](https://github.com/hagezi/dns-blocklists), [EasyList and EasyPrivacy](https://easylist.to) and [StevenBlack/hosts](https://github.com/StevenBlack/hosts) ([`scripts/adblock-list/build.js`](scripts/adblock-list/build.js), published as `adblock.txt` on the `site-list` branch, GPL-3.0): about 345 000 names, which cover over 99% of the domains uBlock Origin Lite's lists block, plus the trackers of phones and TVs. A week whose sources fail, or whose result would block a site everyone needs, publishes nothing. It blocks by name, as AdGuard DNS or NextDNS do: what a browser extension does inside a page (hiding empty ad boxes, ads served from the site's own name, such as YouTube's) is out of its reach. The list is downloaded through the engine, checked before use, refreshed weekly; sites can be exempted. Nothing about blocked names is logged or sent. |
| **Android settings** | Under About → Settings: the app's language (the phone's, or any of the 31; on Android 13+ the system's per-app language), the accent colour (the desktop's nine, or the logo's blue), the bypass technique (the desktop's list; automatic by default), apps that skip Shroudly (their traffic goes straight out, e.g. a game), starting when the phone starts, and **automation apps** (Tasker, MacroDroid; off by default): a broadcast to `me.codeshare.shroudly` with the action `me.codeshare.shroudly.action.START`, `STOP` or `TOGGLE` turns protection on and off. |
| **Android proxy only** | Settings → Mode: instead of the VPN, Shroudly runs as a proxy on `127.0.0.1:10808` (SOCKS5 and HTTP) and leaves Android's one VPN slot to another VPN app. Apps set to use it go through Shroudly (the Wi-Fi network's proxy: host `127.0.0.1`, port `10808`, or an app's own proxy setting); the rest connect as they would without it. No VPN permission is asked for. |
| **Programs that ignore the system proxy** | On a network that forges DNS answers, the autopilot turns on Games and apps mode by itself (Windows, macOS): new programs get `HTTPS_PROXY` (and `NODE_USE_ENV_PROXY=1` for Node.js) pointing at Shroudly, so command-line tools, bots and games that never read the system proxy go through it too; restart the ones already open. Only Shroudly's own values are ever removed. |
| **Off (encrypted DNS only)** | The last choice among the bypass strategies (desktop and Android): every connection goes out exactly as the app sent it, and only name lookups go through the encrypted DNS (or your own server). For networks where DNS is the only block, or to tell whether a technique is in the way. |
| **Auto-probe** | Opens each blocked site with a real handshake, trying combinations of the above, and remembers the one that works per site. If a site connects and is then cut, the next connection tries the next technique. |

> **Note on fake packets.** Low-TTL decoys like those used by driver-based tools
> need raw packet injection, which a userspace proxy cannot do without
> corrupting the real stream. They live in the separate, privileged
> [Advanced mode](#advanced-mode-stateful-dpi). The default mode's techniques
> are enough for filters that read the first packet (Turkey, for one).

---

## Android

The Android app runs the same engine as the desktop, with the same automatic
techniques, remembered techniques and encrypted DNS. Android lets an app see
other apps' connections only as a VPN, so Shroudly is one there: nothing leaves
the phone through a server of ours, the "VPN" is local and only reshapes the
phone's own connections.

- Every app goes through it: browsers, Discord, Roblox and other games, with
  no separate Discord or Games and apps mode needed.
- A Quick Settings tile turns it on and off (Settings → Quick Settings tile
  puts it in the panel; on Android 13 and later with one tap); Android's
  "Always-on VPN" brings it back after a restart.
- Connections that stay quiet for a long time are kept open: a chat app
  waiting for the next message (Instagram, WhatsApp, Telegram) and push
  notifications keep their connection for up to an hour of silence, where
  the tunnel used to end it after five minutes and messages then went late.
- It stays on until you turn it off. Some phones end apps while the screen is
  locked (a power saver that also turns Wi-Fi and mobile data off): Shroudly
  then comes back by itself as soon as a network is there again, with no tap
  needed ([#39](https://github.com/umutxyp/Shroudly/issues/39)). The same
  happens after protection ended on its own (at most three times an hour).
  While there is no network at all, it does no checks that would wake the
  phone for nothing.
- The APK from Releases looks for updates on GitHub; a copy that Google Play
  installs or updates (same package and signing key, so either one updates
  the other) is updated by Play and does not ask GitHub.
- Advanced mode is not available (Android would need root for it).
- Android allows one VPN at a time, so another VPN app and Shroudly cannot be
  on together.
- It is counted in the live user count exactly like the desktop app: the same
  request, only while protection is on, through the engine, and it can be
  switched off under About ([Privacy](#privacy)).

Building and testing it: [android/README.md](android/README.md).

## Advanced mode (stateful DPI)

Iran's and China's DPI reassemble the whole TCP stream before inspecting it, so
splitting the ClientHello alone does not help. Advanced mode adds a
packet-layer backend, `shroudly-core-adv`. It injects a decoy copy of the first
packet with a low TTL, a bad TCP checksum and a scrambled SNI. The decoy reaches
the DPI and poisons its state, then dies before it reaches the real server.

Since **2.5.6** it also carries the TCP techniques GoodbyeDPI and zapret use
and that users on heavily filtered networks rely on. Each is a flag
(`core/src/raw_desync.h`):

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
- **Cuts the real first segment** after the decoy (zapret `multisplit` /
  `multidisorder` at `1,midsld`): one byte into the name and in the middle of
  its second-level label (`r|emote-auth-gateway.dis|cord.gg`), so no segment
  carries the name a filter matches on, even one the decoy does not fool.
  Programs that ignore the proxy (Lampcord, for one) get nothing else, since
  they only meet Advanced mode at the packet layer. Every TCP receiver puts the
  parts back together. **On by default** (`--split on`); `--split disorder`
  sends the last part first, `--split off` sends it whole. A lab in the test
  run checks it on a real packet path: network namespaces, a router that drops
  any packet carrying the blocked name, and the engine on NFQUEUE
  ([`tests/lab/advanced-lab.sh`](tests/lab/advanced-lab.sh)).
- **Faked split / faked disorder** (zapret `fakedsplit` / `fakeddisorder`): the
  ClientHello is split into two real segments with a low-TTL junk fake at the
  boundary, in order or with the second real part sent first. Selectable by
  flag; the decoy stays the proven plain fake **by default**.

- **On when needed.** Always available under Settings on Windows and Linux.
  The [autopilot](#autopilot) turns it on by itself when a site that no
  technique opens, or one that connects and is then cut, shows that this
  network needs it.
- **Asks first.** Turning it on shows a Windows UAC prompt or a Linux password
  prompt (polkit). Shroudly itself keeps running as a normal user.
- **Always reverted.** The packet hook and any firewall rule go away on stop,
  on crash, and when Shroudly quits.
- **Graceful fallback.** If the backend can't start, the default engine keeps
  running.
- **QUIC forced to TCP.** Browsers try blocked sites over HTTP/3 (QUIC, UDP
  443), which never enters Shroudly's TCP proxy and so is filtered directly —
  YouTube and Google can break even with Shroudly on. Advanced mode drops the
  QUIC *Initial* packet, exactly as GoodbyeDPI and zapret do, so the browser
  falls back to TCP, which Shroudly handles. Non-blocked sites simply lose
  QUIC's small latency benefit and keep working over TCP. On by default; can be
  turned off. IPv4 only (IPv6 QUIC is passed through unchanged).
- **Decoy packets for Discord voice.** A censor can fingerprint the first
  datagrams of a Discord voice call (its 74-byte IP-discovery request and the
  STUN binding requests). Advanced mode sends a few low-TTL decoy datagrams of
  the same size ahead of the first one or two real datagrams of each call, so
  the filter's pattern-match is poisoned before the real media goes out. On by
  default; can be turned off.
- **Encrypted DNS for programs that ignore the proxy.** A program that does not
  use the system proxy (a Discord bot on Node, a game launcher, a command-line
  tool) asks the network's DNS, which on a censoring network forges the answer:
  the program then reaches the block page and fails with a certificate error
  (`ERR_TLS_CERT_ALTNAME_INVALID`), whatever happens to its TLS. With DNS
  anti-poisoning on, Advanced mode answers every program's plain DNS question
  (UDP port 53) from Shroudly's encrypted DNS, or the DNS server you chose, as
  if from the server it asked. Only a public address or "no such record" is
  answered; a name encrypted DNS does not know (an intranet, a VPN's own names),
  a private address or no answer in time, and the question goes on to its own
  server unchanged, so local names keep working. Answers the network's DNS
  forged before are emptied from the system's DNS cache when it comes on (or
  programs would keep getting them without asking). Windows: IPv4 and IPv6;
  Linux: IPv4. Checked on a real packet path in both labs.

> The QUIC and voice ones only help where the **network** is what blocks QUIC or the voice
> packets. If a censor blocks Discord's voice servers by **IP address**, no
> packet trick reaches them — that needs a VPN. Shroudly says so rather than
> looking like it works.

| OS | Backend | Needs |
|----|---------|-------|
| Windows x64 | WinDivert 2.2 (signed driver, bundled) | Administrator (UAC prompt) |
| Linux x64 / arm64 | NFQUEUE + raw socket (`iptables`, else `nftables` rule) | Password prompt via `pkexec`. Nothing to install: the queue is spoken over netlink by the engine itself ([`core/src/nfq.c`](core/src/nfq.c)), so it works on every distribution as it comes, Arch and CachyOS included (before 2.6.20 it needed libnetfilter_queue) |
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
| **A site's addresses abroad blocked, its cache in the country open** | Iran (YouTube's videos from Google's caches in Iranian networks) | When every technique fails at the addresses encrypted DNS gives, the network's own DNS is asked too; a different public address it gives (the country's cache) is tried, and kept for the site while it works ([#37](https://github.com/umutxyp/Shroudly/issues/37)). A network DNS that answers slowly gets five seconds, and one that does not answer in time is asked again next time, not given up on ([#43](https://github.com/umutxyp/Shroudly/issues/43)). |
| **Blocking by server address, protocol whitelisting, shutdowns** | Russia's throttling of some hosting providers and its block of Roblox's servers, Iran during shutdowns | Cannot be fixed by any technique that leaves the address unchanged. Shroudly says so plainly and points to a VPN, rather than looking like it works. |

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
  `settings.json`. The [autopilot](#autopilot) does this by itself when
  Discord is blocked on the network, and says so. An endpoint you set yourself
  is never touched.
- The line is removed when you turn the mode off, when you quit Shroudly, and
  by the Windows uninstaller, so a Discord started without Shroudly connects
  as it always did. It stays across logout and shutdown, so a Discord that
  starts at login finds the relay as soon as Shroudly is up.
- Discord reads the line when it starts. A Discord that is already open and
  stuck before its window (it holds no connection to Shroudly at all) is
  restarted by itself; one that already works through the system proxy is
  left alone, so a call is never cut.
- On macOS, the system may ask once before Shroudly can change another app's
  files.

If Shroudly is removed on macOS without being quit first (after a crash, say),
delete that line from Discord's `settings.json` yourself.

Discord app mode is only about the **updater**. Voice calls are different:
Discord sends voice media over UDP, and a censor can recognise the first
datagrams of a call and block it. Where that block is on the network rather than
on Discord's servers themselves, [Advanced mode](#advanced-mode-stateful-dpi)
sends decoy datagrams ahead of the real ones to defeat the pattern-match. If the
voice servers are blocked by IP address, no packet technique reaches them and a
VPN is the only answer.

---

## Games and apps mode (Roblox)

Some programs bring their own HTTP library and never look at the system proxy.
Roblox's programs are the best-known case: on a network that filters Roblox,
roblox.com opens in the browser through Shroudly while the installer stops at
*Continue installation without flag settings from clientsettingscdn.roblox.com*
and neither the player nor Roblox Studio can reach a single Roblox server. The
one proxy setting they do read is the `HTTPS_PROXY` environment variable, and so
do many other games, launchers and command-line tools.

Games and apps mode sets it, on Windows and macOS, without admin rights:

- Shroudly runs a small HTTPS proxy on `127.0.0.1` (port 10810, or the next
  free one). It only tunnels (`CONNECT`), and only for this machine. Each
  tunnel goes to the engine **by name**, so the engine's encrypted DNS and its
  desync apply exactly as they do for the browser; while protection is off it
  goes out directly. The local network is always reached directly, and so
  are names your own DNS puts on a private network (a company's internal
  servers), which are never sent to public resolvers. A private answer that
  is a known block page (such as 10.10.34.34), and a `0.0.0.0` / `::` answer
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
- On **Windows**, a link clicked in a browser (the website's *Play* and *Edit*
  buttons: `roblox-player:`, `roblox-studio:`) is started by the browser, which
  keeps the environment it started with, usually from before Shroudly. So
  while the mode is on, Roblox's links (whichever program handles them:
  Roblox's own, or a Bloxstrap-style launcher) go through Shroudly, for your
  user only and without admin rights: Windows runs Shroudly for the link, and
  Shroudly starts the link's own program with the setting and steps aside.
  The link never depends on Shroudly: with Shroudly stopped, quit or killed it
  opens its program exactly as before. Each link is put back exactly as it was
  wherever the setting is removed (below); one that Roblox wrote again since
  (an update) keeps what Roblox wrote.
- A program reads it when it starts, so what was already open, and on Windows
  what a browser that was already open starts other than by a link (it keeps
  its old environment: an installer opened from the download bar), goes
  around Shroudly. Shroudly checks what actually happens,
  not just that the setting was written: a Roblox program that has run for
  half a minute without a single request reaching Shroudly is going around it.
  Where Roblox is blocked, such a **player** is restarted through Shroudly (or
  through the Bloxstrap-style launcher that handles Roblox's links, whatever
  its name), and such an **installer** (the player's or Studio's) is stopped
  and Roblox's current one is fetched through the engine, checked to be signed
  by Roblox Corporation, and started through Shroudly instead. **Roblox
  Studio** is never closed by Shroudly, since it may hold work that is not
  saved: the user is asked once to save, close and reopen it. Should a Studio
  go around Shroudly again, the same advice would not help, so the user is
  told once what does, naming the program that started it when Windows says
  (one that was open before Shroudly). A player that still
  does not get through after two restarts is left to Advanced mode. The first
  program, and the first Roblox connection, to go through the mode are logged.
  The Microsoft Store edition of Roblox runs in a sandbox that cannot reach
  Shroudly on this computer; Settings says so.
- The [autopilot](#autopilot) turns the mode on by itself where Roblox is
  blocked, and says so. A proxy you set yourself (for your session or, on
  Windows, for the whole machine) is never replaced, and an `HTTPS_PROXY` of
  your own is never removed: `SHROUDLY_APP_PROXY`, set alongside, marks which
  value is Shroudly's.
- It is removed when you turn the mode off, when you quit Shroudly, at logout
  and shutdown, by a watchdog within a second if Shroudly is killed, at the
  next sign-in after a power cut (Windows), and by the Windows uninstaller,
  and Roblox's links with it. A
  program started without Shroudly connects as it always did. One that was
  started while the mode was on keeps the setting it started with until it
  is restarted; if such a program cannot connect after you quit Shroudly,
  restart it.

Game traffic itself (Roblox's UDP) does not use a proxy and goes direct; it is
the HTTPS part — sign-in, the game list, joining, assets — that filters block.

Linux has no single place every desktop reads the environment from, and Roblox
has no Linux client, so the mode is not offered there.

That Roblox Studio honours the setting is tested for real on every change: on a
Windows CI machine, Studio's current installer is fetched through the engine and
run with the setting, and Studio itself then runs for a minute; every
connection Roblox's programs make must go through Shroudly
([`tests/net/studio.test.js`](tests/net/studio.test.js)). The same machine then
opens Studio by its `roblox-studio:` link from a program without the setting,
as a browser open since before Shroudly does: around Shroudly before the mode
takes the link over, through it after, and through it from the Start menu
([`tests/net/link-handlers.test.js`](tests/net/link-handlers.test.js) does the
same with a link of its own on every Windows machine, x64 and ARM).

## Autopilot

The people Shroudly is for do not read settings or banners: when something
does not open, the app "does not work". So whenever Shroudly can tell what is
in the way, it does what they would otherwise have had to do, and then says
what it did in one line, as a notification and in the window
([`electron/autopilot.js`](electron/autopilot.js)).

| It notices | It does |
|---|---|
| Discord is blocked on this network and a Discord app (any build) is installed | Turns on [Discord app mode](#discord-app-mode); restarts a Discord stuck before its window |
| Roblox is blocked on this network | Turns on [Games and apps mode](#games-and-apps-mode-roblox); restarts a player or installer that goes around Shroudly; asks the user to reopen a Roblox Studio that does |
| A site no technique opens, or one that connects and is then cut, or one that a technique opened a moment ago and that then gets no answer at all (the site is up, so the silence is the network's) | Turns on [Advanced mode](#advanced-mode-stateful-dpi) (Windows, Linux) after saying why; the system asks for permission |
| A service's servers (Discord, Roblox) take no connection at all, while the internet works: the network blocks them by address | Says so in one line, once a network: no technique on the computer gets past that, only a VPN. Checked directly before it is said, so a computer that is offline is never told this |
| A program that goes around Shroudly (a Discord bot on Node or Python, a command-line tool, a launcher) is stopped by this network: it connects to a block page the network's DNS sent it to, or straight to a service or site this network stops at the handshake | Turns on [Advanced mode](#advanced-mode-stateful-dpi) (Windows, Linux), naming the program; the system asks for permission. Read from the system's connection table, where a program that failed at once still shows by the closed connection it left; a site's addresses come from encrypted DNS, so the network's DNS is never told the sites. Shroudly's own processes and the apps a mode already carries never count, and it is looked for only on a network that shows a filter ([`electron/around-watch.js`](electron/around-watch.js)) |
| Encrypted DNS is off and the network forges answers | Turns it back on |
| A program sends everything to a proxy on this computer where nothing runs any more (a proxy tool that has gone, e.g. ByeDPI's `127.0.0.1:1080`) | **Discord Drover** (`version.dll` + `drover.ini` beside Discord): moves both files into Shroudly's folder, with a note saying how to put them back, and restarts Discord. **The system's manual proxy**: switched off, its address kept (Windows; macOS and Linux already did). **`HTTPS_PROXY` for programs**: Shroudly's in its place while Games and apps mode is on, the old one back afterwards. **Any other program** (Windows): named, with what to remove. A proxy that runs is never touched |
| Windows' WinHTTP proxy (`netsh winhttp`) points at a program that is gone: Windows Update, the Microsoft Store and some programs stop connecting | Says so and offers to clear it (one administrator prompt) |
| Android: the Wi-Fi network's proxy points at a proxy on the phone where nothing runs (no app may change it) | Says so when the app opens, with a button to Wi-Fi settings; turning Proxy only off while the network's proxy still points at it posts a notice to set it back |
| A Microsoft Store app in an app container (the Store, a UWP app or game, the Xbox app's sign-in) is in use and cannot reach Shroudly: Windows keeps app containers off loopback addresses unless they have a loopback exemption | Adds the exemption for each one that uses the network, sign-in brokers included, with one administrator prompt; with none in use (a program in an app container with a window on screen, or one a desktop Store app opened just now called on) nobody is asked, and a desktop program in a package (Windows Terminal, a Store version of a desktop app) is no sign by itself, and an account that cannot give administrator permission is never asked by itself (Windows; [`electron/store-apps.js`](electron/store-apps.js)) |

How it knows a service is blocked: by a check of its own
([`electron/blockcheck.js`](electron/blockcheck.js)): the system's DNS answers
with a block page, a sinkhole or nothing, or a TLS handshake made directly fails
twice in a row, while the same name works through Shroudly; a service that is
down is never taken for a blocked one. The check runs when protection starts
with the service's app installed, so the mode is on before the app is opened,
and whenever the engine reports something about one of the service's own names
(one that needed a technique, that no technique opened, or that the engine
believes is cut after it connects; one stalled connection alone is not
enough). Third parties the services embed (GIFs, captchas) do not count. What
was learnt is checked again after six hours and forgotten when the network
changes. Nothing is decided from which country the computer is in.

It stays out of the user's way: a switch the user turned off by hand (also
before the autopilot existed) stays off for two weeks; a mode that could not be
turned on (a permission the user did not give, a proxy of their own in the way)
is not tried again by itself that session; Advanced mode's permission prompt
comes at most once a session, and not again by itself for two weeks once
declined, also at a prompt the user started; so does the Store apps' one (one
left unanswered is asked again the next session), and only the exemptions
Shroudly added are ever taken out again (the switch in Settings, the
uninstaller), never one the user had; a program that may hold unsaved
work (Roblox Studio) is never closed; a Discord that works through Shroudly
(any of its processes holds a connection to it) is never restarted; and only
the Roblox player that goes around Shroudly is restarted, never another one in
a game through it, at most twice in ten minutes.

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
- **Light in the background** — the window is closed for real, not hidden, when it goes to the tray or sits unused for three minutes; protection keeps running without it, with nothing in the taskbar or the Dock, only the tray / menu bar icon (or not even that: Settings can hide it, and starting Shroudly again opens the window). Protecting in the background, Shroudly 2.5.3 uses about 30–75 MB depending on the OS, about half of what 2.5.2 did ([measured](tests/e2e/app.test.js) by every [Tests](.github/workflows/test.yml) run).
- **Cross-platform** — native builds for Windows, macOS and Linux, x64 and ARM, and an Android app.
- **Android** — one small APK for every phone: a local VPN that sends every app through the same engine, UDP (games, voice) and apps' own DNS included, with a Quick Settings tile and Always-on VPN ([details](#android)).
- **No admin rights, no driver** in the default mode — it runs as a normal program.
- **Learns what works** — tests each blocked site and remembers the technique that opens it; switches technique by itself if a network starts cutting a site.
- **Encrypted DNS** — on by default, over routes that are hard to block, refusing known forged answers.
- **Autopilot** — notices what is in the way and fixes it by itself: turns on the mode an app needs where its service is blocked, restarts a program stuck around Shroudly, turns on Advanced mode when a site needs it; then says what it did, in one line ([details](#autopilot)).
- **Discord app mode** — lets the Discord app (every build) update and open through Shroudly on Windows and macOS ([details](#discord-app-mode)).
- **Games and apps mode** — Roblox, Roblox Studio, their installers and other programs that ignore the system proxy go through Shroudly too, on Windows and macOS ([details](#games-and-apps-mode-roblox)).
- **Advanced mode** — packet-level desync for networks that follow whole connections, on Windows and Linux.
- **Tells you what is going on** — another VPN or bypass tool fighting it, a site the network cuts, encrypted DNS blocked, what the autopilot did: said plainly, in one line.
- **Never breaks your connection** — your proxy settings are saved before Shroudly changes them and put back on stop, crash, forced kill, shutdown, power loss (at next sign-in) and uninstall.
- **Routing** — everything through Shroudly (the default), or only the sites on a list, with the rest — banking, government — connecting directly. The list keeps itself current ([how](#the-automatic-site-list)); you can also write your own.
- **Port conflicts handled** — if another program holds its port, Shroudly moves to a free one and remembers it.
- **Honest live stats** — connections, bytes and techniques applied are real counters from the engine.
- **Automatic updates** — for every package: Windows, macOS, AppImage, `.deb`, `.rpm` and `.pacman`; the Android app tells you when a newer version is out.
- **31 languages**, detected automatically, including those of the countries that filter the internet hardest (Azerbaijani, Persian, Russian, Turkmen, Burmese, Vietnamese and more).

## What it runs on

| | Minimum | Notes |
|---|---|---|
| Windows | **Windows 10** (x64 or ARM64) | The installer stops with a clear message on Windows 8.1 and earlier, which Electron no longer supports. |
| macOS | **macOS 12 Monterey** (Intel or Apple Silicon) | Older versions are told so by macOS itself rather than failing to launch. |
| Linux | **glibc 2.28+** — Debian 10, Ubuntu 18.04, Fedora 29 or newer | AppImage (x64, ARM64), plus native packages: .deb for Debian/Ubuntu, .pacman for Arch/Manjaro, .rpm for Fedora/openSUSE/RHEL. The bypass engine itself only needs glibc 2.17, so it is never the limiting part. |
| Android | **Android 8** or newer (phones and tablets; ARM 64/32-bit, x86_64) | An APK from the releases page. It works as a VPN on the phone, so every app goes through Shroudly; no root needed. To keep another VPN app connected, Settings → Mode → Proxy only. |

Advanced mode needs administrator rights, and is available on Windows and Linux only.


### Languages

English, 中文, हिन्दी, Español, العربية, Русский, Português, Français, فارسی, Türkçe, বাংলা, اردو, Bahasa Indonesia, 日本語, Deutsch, Azərbaycanca, עברית, Tiếng Việt, Українська, Беларуская, Oʻzbekcha, Қазақша, Кыргызча, Türkmençe, Тоҷикӣ, پښتو, Kurdî (Kurmancî), မြန်မာ, ไทย, አማርኛ, Bahasa Melayu

The app opens in your system's language when it is one of these, and you can change it in Settings. Arabic, Persian, Urdu, Hebrew and Pashto are shown right to left. The Android app follows the phone's language, and from Android 13 on its own language can be chosen in the phone's settings.

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
| **Android 8+** | [APK](https://shroudly.codeshare.me/dl/android) | [APK](https://shroudly.codeshare.me/dl/android) (one APK for every phone) |

- **Windows** — run the installer.
- **macOS** — open the `.dmg` and drag `Shroudly.app` into Applications.
- **Debian / Ubuntu** — `sudo apt install ./Shroudly-*-Linux-amd64.deb`
- **Arch** — `sudo pacman -U Shroudly-*-Linux-x64.pacman`
- **Fedora / RHEL** — `sudo dnf install ./Shroudly-*-Linux-x86_64.rpm`
- **openSUSE** — `sudo zypper install ./Shroudly-*-Linux-x86_64.rpm`
- **AppImage** — `chmod +x Shroudly-*.AppImage` and run it.
- **Android** — download `Shroudly-…-Android.apk` on the phone and open it.
  Android asks once to allow installs from your browser; then tap the big
  button and allow the VPN request. Every app on the phone, Discord and games
  included, then goes through Shroudly. The app tells you when a newer version
  is out.

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

> **First install on Windows or macOS:** if Windows shows *"Windows protected
> your PC"*, click **More info → Run anyway**. If macOS will not open it, open
> it once, then **System Settings → Privacy & Security → Open Anyway** (on
> macOS 15 and later right-click → Open no longer offers that). This is needed
> only once. See the [code signing policy](#code-signing-policy).

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

Linux advanced builds need only a C compiler (or zig, to cross-build): the
packet queue is spoken over netlink, with the kernel's own headers. Windows
packages also need `npm run fetch:windivert`, which downloads the official
WinDivert release, verifies it and puts the driver next to
`shroudly-core-adv.exe`.

The Android app needs a JDK (17+) and the Android SDK with the NDK; the steps
are in [android/README.md](android/README.md):

```bash
node android/scripts/fetch-hev.js      # hev-socks5-tunnel at its pinned, verified release
cd android && ./gradlew assembleRelease   # builds the engine from core/ with the NDK as well
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
      doh.[ch]                DNS resolver (local DoH forwarder + UDP fallback)
      probe.[ch]              per-host auto-probe
      engine.[ch]             SOCKS5/4/4a listener + relay (CONNECT and UDP ASSOCIATE)
      socksudp.[ch]           SOCKS5 UDP header parsing (Android: games, voice, DNS)
      rawscope.[ch]           Advanced mode: what it may touch (never the local network)
      raw_linux.[ch]          Advanced mode: NFQUEUE backend
      raw_windows.[ch]        Advanced mode: WinDivert backend
      udpdpi.[ch]             Advanced mode: QUIC/Discord-voice UDP classifiers + decoys
      supervise.[ch]          Advanced mode: stop / status-file handling
      watchdog.[ch]           --watchdog: has settings restored if the app is killed
      main.c                  CLI + control protocol (engine_main: also the Android app's in-process run)
    test/                     unit tests, sanitizer tests, fuzzers
  electron/
    main.js                   app shell, tray, IPC, auto-start
    engine-manager.js         spawns shroudly-core, parses JSON, restarts
    system-proxy.js           set/restore OS proxy (Win/mac/Linux), crash-safe
    restore-proxy.js          --restore-proxy: the login hook's and the watchdog's restore
    doh-forwarder.js          local DNS-over-HTTPS forwarder: routes, health, failover
    custom-dns.js             the user's own DNS server: DoH, DoT, TCP, UDP (Settings)
    winhttp.js                Windows' WinHTTP proxy: read, found gone, reset
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
    around-watch.js           programs around Shroudly that the network stops: Advanced mode for them
    main-i18n.js              tray + notification strings, read from locales/
    tools/core/<os>-<arch>/   built engine binaries (per platform)
  app/ components/ contexts/  Next.js + React UI
  android/                    the Android app: VpnService + hev-socks5-tunnel + the engine (see android/README.md)
  locales/<code>.json         every string, one file per language (31)
  scripts/build-core.js       native + cross compile
  scripts/build-core-advanced.js   Advanced-mode engine build
  scripts/fetch-windivert.js       fetch + verify the WinDivert driver
  scripts/after-pack.js            stamp icon + version info into Shroudly.exe
  scripts/installer.nsh            Windows installer hooks (proxy reset, Discord, HTTPS_PROXY and Store app exemption clean-up)
  scripts/site-list/               weekly site-list build: families, policy, OONI
  scripts/adblock-list/            weekly ad and tracker list build: sources, checks
  tests/net/                  network tests (fake censor, hostile servers, DNS, Discord, games and apps, site list, watchdog)
  tests/e2e/                  the real app driven end to end: window life cycle, memory per state
  tests/lab/                  Advanced mode on real packets: a filtering router (Linux), WinDivert (Windows); Store apps and loopback in an app container (Windows)
  server/stats/               shroudly.codeshare.me: the live count and the /dl download links
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
(refuse DNS answers pointing at a block page; repeatable), `--ipv6`,
`--auth-file <path>` (require a SOCKS5 username/password, read from a file),
`--fake-net <cidr>` (refuse addresses in a range at once).

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
cd android && ./gradlew testDebugUnitTest lintDebug   # the Android app
android/scripts/emulator-smoke.sh   # the app on an Android emulator: VPN, DNS, TCP, UDP
```

The [Tests workflow](.github/workflows/test.yml) runs all of it on every push,
on Windows, Linux and macOS, x64 and ARM, and the engine tests a second time on
an AddressSanitizer/UBSan build. Advanced mode runs on real packets there too
(a filtering router in Linux network namespaces, and the WinDivert driver on
Windows), and the Android app is built, checked for 16 KB pages and run on an
Android emulator.

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
- **Privacy:** see [Privacy](#privacy), which also links the privacy policies
  of the services Shroudly talks to. Shroudly sends nothing about you to any
  server; the only things it contacts are listed there, and the one optional
  report, the anonymous live count, can be turned off in Settings (on Android,
  under About).

The Android app (`Shroudly-<version>-Android.apk`) is signed with the project's
own key, the same for every version, so an update installs over the previous
one. Its certificate's SHA-256 is
`23:AC:01:4B:72:26:34:3B:74:C7:C9:C0:A4:FD:6F:1D:ED:97:51:8A:3B:FD:35:BC:DE:65:B6:C1:EC:A8:BD:76`;
the release workflow checks every APK against it before publishing.

macOS builds are not covered: Apple requires its own Developer ID for those.

---

## Privacy

This is Shroudly's privacy policy, for the desktop app and the Android app
(the Android app links it under About). Shroudly is made by Codeshare
Technology Ltd; questions about privacy go to
[contact@codeshare.me](mailto:contact@codeshare.me).

Shroudly does not collect personal data. These are the only things that contact servers:

- **Live user count** (`shroudly.codeshare.me`): only while protection is on,
  and only if *Count me in the live total* is left on (in Settings on the
  desktop, under About on Android), it sends a random id that is created fresh
  each time protection starts and never stored on the device: the request's
  body is `{"id":"<random id>"}` and nothing else. It travels through the
  protected connection like everything else. The Android app sends the same
  request, headers included, as Shroudly on a Windows computer, so the server
  cannot tell a phone from a computer: both are counted in one total, the same
  way. The
  server only keeps those ids and when each was last seen, to count how many
  apps are online. An id disappears when protection is stopped, when the app
  quits, or a few minutes after it stops pinging (a computer or phone that
  sleeps, too). No IP addresses or other details are logged: the server keeps
  no access log, and it is reached through a Cloudflare tunnel, so it never
  sees your address anyway.
  The server code, with its service and web-server settings, is in
  [`server/stats`](server/stats/server.js).
- **Update checks** (GitHub): the app downloads the release feed from
  `github.com/umutxyp/Shroudly` (the Android app asks GitHub's API for the
  latest release; it never downloads or installs anything by itself). The
  Android app installed or updated by Google Play makes no update check at
  all: Play updates it.
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
  [Encrypted DNS routes](#encrypted-dns-routes), not by your provider; or, if
  you chose one in Settings (DNS server), by that server (and by the resolvers
  above while it does not answer, unless you ticked Only this server: then by
  that server alone). Only a name they have no public address
  for (an intranet, a VPN's own names, a hosts-file entry) is then asked of
  your system's DNS, so that it still opens. Your system's DNS is also asked
  about a site whose addresses from encrypted DNS got nowhere at all (every
  technique failed, or none of them answered): where the network's DNS gives
  another public address, such as a CDN's cache inside the country, that one
  is tried, and kept while it works. Never with **Only this server**. In
  Advanced mode, the plain DNS questions of programs that ignore the proxy
  are answered the same way (see [Advanced mode](#advanced-mode-stateful-dpi)).
- **Discord's update servers**, only with Discord app mode on: the relay asks
  them on the Discord app's behalf, exactly what Discord would have asked.
- **Whether an app's service is blocked here** (the [autopilot](#autopilot)),
  only while protection is on and only for a service whose app is installed
  (Discord, Roblox), at most every six hours: the system's own DNS is asked for
  `discord.com` or `clientsettingscdn.roblox.com` and a TLS handshake is made
  with it directly, as the app itself does when it starts, and, if that fails,
  once more through the protected connection. No request is sent over it, and
  nothing about you.

Games and apps mode contacts nothing of its own: it only carries what the
programs using it were going to send anyway.

Which technique opened which blocked site is remembered on this computer
only (in Shroudly's settings file, for 30 days at most), so the next start
does not have to search again. Nothing of it is sent anywhere.

**On Android** the app is a local VPN (Android's VpnService): the tunnel ends
in the app's own engine on the phone, and no traffic goes through a server of
ours; apps' connections leave the phone as they would without Shroudly, only
reshaped (their contents are not read or changed), and stay encrypted by the
apps themselves. The Android app downloads no site list. It contacts only:
the live user count above, exactly as the desktop does (only while protection
is on, through the engine, and not at all with *Count me in the live total*
switched off under About); the encrypted DNS resolvers above (or the DNS
server you chose in Settings), while protection is on; GitHub for update checks, only in the APK from GitHub (not when Google
Play installed or updates it); and, to find what opens a blocked site, that
same site (a few TLS handshakes, nothing about you). What worked for which
site is kept in the app's private storage on the phone for 30 days at most,
is never backed up or copied to another device, and is deleted with the app.
There are no accounts, no analytics beyond the anonymous live count, no ads
and no crash reports.

The privacy policies of the services involved:
[GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
(updates, the site list),
[Discord](https://discord.com/privacy) (Discord app mode, the autopilot's check),
[Roblox](https://www.roblox.com/info/privacy) (the autopilot's check),
[Cloudflare](https://www.cloudflare.com/privacypolicy/) (the live count's tunnel),
and the encrypted DNS resolvers:
[Cloudflare 1.1.1.1](https://developers.cloudflare.com/1.1.1.1/privacy/public-dns-resolver/),
[Google Public DNS](https://developers.google.com/speed/public-dns/privacy),
[Quad9](https://quad9.net/privacy/policy/),
[AdGuard DNS](https://adguard-dns.io/en/privacy.html),
[OpenDNS (Cisco)](https://www.cisco.com/c/en/us/about/legal/privacy-full.html),
[DNS.SB](https://dns.sb/privacy/) and
[Mullvad](https://mullvad.net/en/help/privacy-policy).

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
- Censorship fingerprints from [OONI](https://ooni.org/)'s open [blocking-fingerprints](https://github.com/ooni/blocking-fingerprints) data.
- [hev-socks5-tunnel](https://github.com/heiher/hev-socks5-tunnel) (MIT) carries the Android app's VPN traffic to the engine; [WinDivert](https://reqrypt.org/windivert.html) (LGPL) is Advanced mode's packet driver on Windows.

---

<div align="center">

**Shroudly — Unseen. Unstoppable.**

*A Codeshare Technology Ltd product*

</div>
