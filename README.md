# Bezi Remote

Bezi Remote is an Android and iOS companion for controlling Bezi and the active
Unity Editor on a paired Windows PC. iOS testers use Expo Go; Android testers
install a standalone APK and do not need Expo Go.

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
- `cloudflared` for the zero-login secure Quick Tunnel
- Expo Go on a recent iPhone or iPad for the iOS distribution

## Quick start

```powershell
pnpm install
pnpm proof:expo-go
```

## Two tester distributions

Build the self-contained setup wizard and give the resulting EXE to the tester:

```powershell
pnpm build:windows-setup
```

The build produces two CLI-styled, single-file Windows setup wizards:

- `dist\bezi-buddy-ios-setup\Bezi Buddy iOS Expo Go Setup.exe`
- `dist\bezi-buddy-android-setup\Bezi Buddy Android Setup.exe`

Both install missing Windows prerequisites, embed and install the Bezi Buddy
runtime without Git or Rust on the tester's PC, let them choose a Unity project,
install or update the Editor-only bridge, and create a mode-specific one-click
launcher for the companion, relay, Bezi, and Unity connection.

Build the standalone Android tester APK with:

```powershell
pnpm build:android:apk
```

It is downloaded to `dist\bezi-buddy-android\Bezi Buddy Android.apk`. The
tester can install that file directly after allowing installs from their file
provider. Launching the Android PC shortcut creates an expiring secure link;
opening it on the phone hands the private session into the installed app.

To enable hierarchy, asset, inspector, and `@`-mention context for a Unity
project, install the Editor-only bridge once for that project:

```powershell
.\scripts\Install-UnityPackage.ps1 -UnityProject 'R:\My Unity Project'
```

The installer previews the target, creates a manifest backup, and adds the
embedded `app.beziremote.unity` package. It does not edit scenes or gameplay
assets.

The iOS proof launcher prints one `exp://...trycloudflare.com` address and starts
the local relay, Metro, Quick Tunnel, and native companion. `pnpm proof:android`
starts the standalone Android path without Metro or Expo Go. Neither path
requires Wrangler login or remote Cloudflare resources. Press Ctrl+C in that
terminal to stop the complete proof session.

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

Email delivery is optional. Run `Bezi Buddy.exe --configure-email` to choose a
sender Gmail account and any default recipient, then configure a dedicated Gmail
App Password. The credential is encrypted for the current Windows user under
Local AppData. Use `--send-to tester@example.com` on any launch to override the
recipient for just that session.

The architecture and current implementation status are documented in
[`docs/architecture.md`](docs/architecture.md) and
[`executions/2026-07-28-bezi-remote.md`](executions/2026-07-28-bezi-remote.md).
Use [`docs/proof-runbook.md`](docs/proof-runbook.md) for the local and cellular
proof procedure.
