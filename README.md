# Bezi Remote

Bezi Remote is an iOS-first companion for controlling Bezi and the active Unity
Editor on a paired Windows PC. The first milestone runs in Expo Go for a
single-owner proof; the same application architecture then moves to an Expo
development build, TestFlight, and the App Store.

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
- An Apple Developer account only after the Expo Go proof

## Quick start

```powershell
pnpm install
pnpm proof:expo-go
```

The proof launcher prints one `exp://...trycloudflare.com` address and starts
the local relay, Metro, Quick Tunnel, and native companion. It does not require
Wrangler login or remote Cloudflare resources. Press Ctrl+C in that terminal to
stop the complete proof session.

For a one-click Windows launcher, build it once and then double-click the EXE:

```powershell
pnpm build:windows-launcher
```

The self-contained launcher is written to
`dist\bezi-buddy\Bezi Buddy.exe`. It starts the built native
companion and the complete Expo Go relay, prints the temporary `exp://` URL,
copies it to the Windows clipboard, and keeps the session open until Ctrl+C.
Its terminal shows the Bezi mascot, a welcome animation, and the current startup
stage while the local relay, Cloudflare hostname, Expo Go, and companion load.
The companion starts hidden in the Windows notification area when launched by
Bezi Buddy; use its tray menu if you need to open the companion window.

On its first email-enabled launch, Bezi Buddy opens Google's App Password setup
and prompts locally for a dedicated Gmail App Password. After a successful test
message, the credential is encrypted for the current Windows user under Local
AppData. Every future proof session emails its clickable Expo Go URL to the
configured inbox after the public relay becomes ready.

The architecture and current implementation status are documented in
[`docs/architecture.md`](docs/architecture.md) and
[`executions/2026-07-28-bezi-remote.md`](executions/2026-07-28-bezi-remote.md).
Use [`docs/proof-runbook.md`](docs/proof-runbook.md) for the local and cellular
proof procedure.
