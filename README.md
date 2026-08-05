# Bezi Remote

Bezi Remote is an Android and iOS companion for controlling Bezi and the active
Unity Editor on a paired Windows PC. The current tester build runs in Expo Go;
the same architecture also supports internal Android APK builds, Expo
development builds, TestFlight, and the app stores.

## Product shape

The phone has two primary modes:

- **Bezi** — direct, mobile-native control of Bezi sessions, messages, approvals,
  plans, tools, diffs, rules, and a selected-window Full Remote fallback.
- **Unity** — direct, mobile-native control of open Unity Editors, hierarchy,
  typed inspector values, ScriptableObjects, play state, and gameplay input.

Pairing, host selection, diagnostics, and quality controls are secondary
navigation, not additional product modes. The local Bezi protocol adapter is an
implementation detail of Bezi mode and is never presented as a user feature.

## Workspace

- `apps/mobile` — Expo Router application.
- `apps/relay` — signaling/ownership service; local during the proof, with a
  Cloudflare deployment path retained for production.
- `apps/companion` — Windows Tauri/Rust companion.
- `packages/protocol` — shared validated wire contracts and E2EE primitives.
- `packages/unity` — Editor-only Unity package.
- `docs` — architecture, security, and setup notes.
- `executions` — resumable implementation records.

## Requirements

- Node.js 22+
- pnpm 10+
- Rust stable and the Windows WebView2 toolchain for the companion
- GStreamer 1.x MSVC x64 runtime and development packages
- Unity 6 for the Editor package
- `cloudflared` for the zero-login Expo Go Quick Tunnel
- Expo Go on a recent Android phone or iPhone

## Quick start

```powershell
pnpm install
pnpm proof:expo-go
```

## One-file Windows setup

Build the self-contained setup wizard and give the resulting EXE to the tester:

```powershell
pnpm build:windows-setup
```

The distributable is written to `dist\bezi-buddy-setup\Bezi Buddy Setup.exe`.
It installs missing Windows prerequisites, embeds and installs the Bezi Buddy
runtime without Git or Rust on the tester's PC, lets them choose a Unity project,
installs or updates the Editor-only bridge, and creates a one-click launcher for
the companion, relay, mobile bundle, Bezi, and Unity connection.

On Android, install Expo Go from Google Play and open the `exp://` launch link
shown by Bezi Buddy. An explicitly installable Android APK can also be requested
through the checked-in EAS preview profile with `pnpm build:android:apk`.

To enable hierarchy, asset, inspector, and `@`-mention context for a Unity
project, install the Editor-only bridge once for that project:

```powershell
.\scripts\Install-UnityPackage.ps1 -UnityProject 'R:\My Unity Project'
```

The installer previews the target, creates a manifest backup, and adds the
embedded `app.beziremote.unity` package. It does not edit scenes or gameplay
assets.

The proof launcher prints one `exp://...trycloudflare.com` address and starts
the local relay, Metro, Quick Tunnel, and native companion. It does not require
Wrangler login or remote Cloudflare resources. Press Ctrl+C in that terminal to
stop the complete proof session.

For a one-click Windows launcher, build it once and then double-click the EXE:

```powershell
pnpm build:windows-launcher
```

The self-contained developer launcher is written to
`dist\bezi-buddy\Bezi Buddy.exe`. It starts the built native
companion and the complete Expo Go relay, prints the temporary `exp://` URL,
copies it to the Windows clipboard, and keeps the session open until Ctrl+C.
Its terminal shows the Bezi mascot, a welcome animation, and the current startup
stage while the local relay, Cloudflare hostname, Expo Go, and companion load.
The companion starts hidden in the Windows notification area when launched by
Bezi Buddy; use its tray menu if you need to open the companion window.

Email delivery is optional. Run `Bezi Buddy.exe --configure-email` to configure
a dedicated Gmail App Password. The credential is encrypted for the current
Windows user under Local AppData, and future sessions email the Expo Go URL to
the configured inbox.

The architecture and current implementation status are documented in
[`docs/architecture.md`](docs/architecture.md) and
[`executions/2026-07-28-bezi-remote.md`](executions/2026-07-28-bezi-remote.md).
Use [`docs/proof-runbook.md`](docs/proof-runbook.md) for the local and cellular
proof procedure.
