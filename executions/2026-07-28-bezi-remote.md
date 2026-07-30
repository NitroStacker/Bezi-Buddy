# Bezi Remote execution — 2026-07-28

## Objective

Implement the accepted Bezi Remote plan as a production-oriented greenfield
workspace, beginning with an Expo Go single-owner proof and retaining a direct
path to an Expo development build and App Store distribution.

## Readiness

- Status: Ready with assumptions.
- Workspace was empty and was not a Git repository.
- Node.js, npm, pnpm, and .NET are available.
- Rust stable and GStreamer 1.28.5 are now installed for local companion
  validation.
- No Cloudflare account is required for the Expo Go proof. Apple account access
  is deferred until the development-build/TestFlight phase.
- Physical iPhone/cellular and live Unity/Bezi integration are external phase
  gates; local contracts and simulators are implemented first.

## Work queue

- [x] Monorepo, protocol, documentation, and CI baseline.
- [x] Cloudflare relay, D1 schema, pairing, tickets, and controller lease.
- [x] Expo Go mobile shell, secure setup, relay client, and swappable WebRTC boundary.
- [x] Windows companion local adapter, Unity bridge, and safety controls.
- [x] Unity Editor package and typed command handling.
- [x] Negotiated companion WebRTC H.264/Opus pipeline and input DataChannel.
- [x] One-hostname, zero-login Cloudflare Quick Tunnel proof launcher.
- [ ] Physical-iPhone cellular playback/input validation and handoff.

## Assumptions

- `app.beziremote.mobile` is the placeholder iOS bundle identifier until the
  final reverse-DNS domain is owned.
- The launcher creates an ephemeral development owner token and injects it only
  into the ignored Expo proof environment. This is intentionally limited to
  Stage A and is not a production authentication design.
- Relay content is application-encrypted; D1 contains ownership and redacted
  metadata only.
- Bezi mode has a native mobile UI. Its loopback adapter is an internal transport
  and never appears as a separate product feature or modifies the Bezi install.

## Validation evidence

- Protocol: TypeScript crypto round-trip, replay rejection, tamper rejection,
  and Rust/TypeScript cross-language fixture pass.
- Relay: local D1 migration and live Worker/Durable Object smoke pass for
  pairing, shared session salt, opaque routing, lease denial, lease acquisition,
  and targeted host response.
- Mobile: TypeScript, Expo lint, and four Vitest checks pass. The phone UI now
  exposes Bezi and Unity as the only primary tabs.
- Companion: Rust format/check plus seven tests pass, including input disarm,
  method allowlist, crypto interoperability, and capability gating.
- Unity: `app.beziremote.unity` is installed in the open Battle Soccer project;
  Unity resolved the package and compiled `Bezi.Remote.Editor.dll` and its test
  assembly without C# errors. A clean Unity 6000.3.16f1 batch project executed
  all three package EditMode tests: 3 passed, 0 failed.
- Local media: the native companion uses zero-copy D3D12 window capture into
  NVIDIA H.264, WASAPI loopback into Opus, `webrtcbin` offer/answer and trickle
  ICE, and a host-created input DataChannel. Live Bezi-window tests negotiated
  an H.264/Opus answer, received both audio and video RTP buffers, and verified
  safe cleanup both before and after the phone answer.
- Proof connectivity: one public `trycloudflare.com` hostname served Metro and
  relay health through the path mux and passed pairing, tickets, WebSocket frame
  routing, and controller-lease enforcement without Cloudflare authentication.
- Packaging: Tauri produced MSI and NSIS x64 installers with
  `native-streaming` enabled. Expo typecheck/lint and all 14 TypeScript tests
  pass; all eight non-hardware and both interactive media Rust tests pass.

## Resume point

Run `pnpm proof:expo-go`, scan the companion QR from a physical iPhone on
cellular, and validate decoded audio/video, touch input, reconnect, and latency.
