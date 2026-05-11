<div align="center">
  <img src="public/logo.png" alt="Shroudly Logo" width="160"/>

  # Shroudly

  **Unseen. Unstoppable.**

  [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
  [![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron)](https://www.electronjs.org/)
  [![Next.js](https://img.shields.io/badge/Next.js-14-000000?logo=next.js)](https://nextjs.org/)
  [![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6?logo=windows)](https://www.microsoft.com/windows)

  > Advanced DPI bypass for Windows. Break through internet censorship with precision packet-level techniques — no VPN, no proxies, no DNS tricks that break your connection.

  **A [Codeshare Technology Ltd](https://codeshare.me) product**
</div>

---

## What is Shroudly?

Shroudly intercepts outbound TCP packets and manipulates them at the kernel level using **WinDivert**, making it impossible for Deep Packet Inspection (DPI) systems to identify and block your connections. Unlike DNS changers or VPNs, Shroudly never changes your network adapter settings — everything happens in-memory at the packet level, so your internet is never left broken.

---

## Features

### DPI Bypass Engine

| Technique | Description |
|-----------|-------------|
| **TCP Fragmentation** | Splits the first TCP packet of each connection into 2–3 tiny segments so DPI cannot read the full SNI/Host field |
| **Triple Split** | Three-way split with 1-byte prefix, pre-SNI chunk, and SNI+rest — SNI is never in a single fragment |
| **Fake Packet** | Sends a clone with scrambled SNI bytes and a deliberately corrupt TCP checksum before the real packet; DPI reads garbage, server discards it |
| **Disorder Mode** | Sends fragments out of order (last first); destination TCP stack reassembles correctly, sequential DPI cannot |
| **HTTP Host Scramble** | Rewrites `Host:` as `hoSt:` for plain HTTP connections to defeat exact-string DPI matchers |
| **SNI-Aware Splitting** | Parses TLS ClientHello byte-by-byte to find the exact SNI offset and split precisely at that boundary |
| **Aggressive Mode** | Combines all techniques with smaller fragment sizes for maximum bypass power |

### Application

- **Real-time Network Stats** — Live ping, download speed, and upload speed with 30-point sparkline charts
- **Control Panel** — One-click START/STOP with active technique indicators and session statistics
- **Settings Panel** — Full control over every bypass parameter (fragment size, TTL value, max payload, DNS servers)
- **Logs Panel** — Color-coded system logs with Info / Success / Warning / Error filtering
- **Info Tab** — Explains each technique, shows system status (admin check, DPI state), and answers why DNS/TTL options are disabled
- **Status Indicators** — Green/red dot on the app logo and header badge; updates every second
- **System Tray** — Minimizes to tray, right-click menu, click to restore
- **Auto Mode** — Starts DPI bypass automatically on launch
- **Start on Boot** — Optional Windows startup entry
- **Safe Shutdown** — Closing the app or force-quitting restores all network state automatically (no stuck settings)
- **15 Languages** — Full translations including all UI strings, settings labels, and Info tab content

### Languages

English · 中文 · हिन्दी · Español · العربية · Русский · Português · Français · فارسی · Türkçe · বাংলা · اردو · Bahasa Indonesia · 日本語 · Deutsch

Auto-detects system language on first launch. Persists selection across restarts.

---

## Installation

### Pre-built Installer (Recommended)

Download the latest `Shroudly-X.X.X-x64.exe` from [Releases](https://github.com/umutxyp/Shroudly/releases), run it, and launch Shroudly. Administrator rights are requested automatically.

### Build from Source

**Requirements:** Windows 10/11 64-bit · Node.js 20+ · Git · .NET Framework 4.x (for C# engine compilation)

```bash
git clone https://github.com/umutxyp/Shroudly.git
cd Shroudly
npm install

# Development
npm run electron:dev

# Production build + installer
npm run build
npx electron-builder
```

The installer outputs to `dist/`.

---

## How It Works

```
Normal (Blocked):
  [Your PC] ──► [DPI: reads SNI → BLOCKED] ──► ✗

With Shroudly:
  [Your PC] ──► [ShroudlyEngine]
                    ├─ Fake packet (corrupt checksum) ──► [DPI: garbage → confused]
                    ├─ Fragment 1 (1 byte)            ──► [DPI: incomplete → passes]
                    ├─ Fragment 3 (SNI+rest, OOO)     ──► [DPI: out of order → passes]
                    └─ Fragment 2 (pre-SNI)           ──► [Destination: reassembles ✓]
```

`ShroudlyEngine.exe` is a first-party C# helper that uses WinDivert v1.4 directly. It runs as a single instance, captures outbound HTTP/HTTPS packets, applies the configured bypass techniques, and exits cleanly when stopped — leaving no trace in your network settings.

---

## Why Not DNS / TTL?

Changing Windows DNS adapter settings or modifying system TTL registry values can leave your internet broken if the process is killed before restoring them. Shroudly's TCP fragmentation approach operates entirely in-memory — it never writes to your network adapter config or registry, so force-quitting the app is always safe.

---

## Architecture

```
Shroudly/
├── app/                  # Next.js pages (page.js — main shell + 5-tab nav)
├── components/           # React UI components
│   ├── ControlPanel.js   # START/STOP, stats, technique toggles
│   ├── SettingsPanel.js  # All settings with i18n labels
│   ├── StatsPanel.js     # Ping + speed sparkline charts
│   ├── LogsPanel.js      # Filterable log viewer
│   ├── InfoPanel.js      # About, techniques, system status
│   └── TitleBar.js       # Custom window chrome
├── contexts/
│   └── LanguageContext.js  # i18n provider (15 languages, auto-detect)
├── electron/
│   ├── main.js           # Electron main process + IPC handlers
│   ├── preload.js        # Secure context bridge
│   └── dpi-bypass.js     # Engine spawn logic + settings → args mapping
├── native/
│   └── ShroudlyEngine.cs # C# packet engine (WinDivert, TLS SNI parsing)
├── public/               # Static assets (logo, WinDivert binaries)
├── translations.js       # 15-language translation map (105 keys each)
└── scripts/
    └── build-engine.js   # Compiles ShroudlyEngine.cs with csc.exe
```

---

## Tech Stack

- **Frontend:** Next.js 14 · React 18 · Tailwind CSS
- **Desktop:** Electron 33
- **Packet Engine:** C# / WinDivert v1.4 (kernel-level packet capture)
- **Build:** electron-builder (NSIS installer)
- **Storage:** electron-store
- **Network Stats:** `netstat -e` parsing (zero-dependency, fast)
- **Charts:** Inline SVG sparklines (no external library)

---

## Comparison

| Feature | Shroudly | goodbyeDPI / zapret |
|---------|----------|--------------------|
| GUI | Modern dark UI | CLI only |
| Real-time stats | Ping + speed charts | None |
| 15 languages | Full i18n | English only |
| Auto language detect | Yes | No |
| Technique info | Built-in Info tab | Readme |
| Safe force-quit | Yes (in-memory only) | Depends |
| Fake packet + disorder | Yes | Partial |
| Installer | One-click NSIS | Manual |

---

## Legal & Responsible Use

Shroudly is built to help users access the free and open internet in regions with unjust censorship.

✅ Accessing legitimately blocked services (Discord, YouTube, social media)  
✅ Bypassing restrictive institutional network policies  
✅ Educational and security research purposes  
❌ Do not use for illegal activities or to bypass legitimate security controls

**Users are solely responsible for complying with local laws.**

---

## Troubleshooting

**"Administrator privileges required"** — Right-click the app → Run as Administrator, or approve the elevation prompt.

**Engine not found** — Run `npm run setup` to recompile `ShroudlyEngine.exe`.

**Build fails** — Delete `node_modules`, `.next`, `out`, `dist` and run `npm install && npm run build`.

---

## License

MIT — see [LICENSE](LICENSE)

---

## Credits

- [WinDivert](https://github.com/basil00/Divert) — kernel-level packet interception
- [Electron](https://www.electronjs.org/) — desktop framework
- [Next.js](https://nextjs.org/) — React framework
- [Tailwind CSS](https://tailwindcss.com/) — styling

---

## Support

- **Issues:** [github.com/umutxyp/Shroudly/issues](https://github.com/umutxyp/Shroudly/issues)
- **Website:** [codeshare.me](https://codeshare.me)
- **Email:** support@codeshare.me

---

<div align="center">

**Shroudly — Unseen. Unstoppable.**

*A Codeshare Technology Ltd product*

[![Star History Chart](https://api.star-history.com/svg?repos=umutxyp/Shroudly&type=Date)](https://star-history.com/#umutxyp/Shroudly&Date)

</div>
