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
- [x] Installed-APK Android emulator pairing, Bezi, Unity, and reconnect validation.
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
- Mobile: TypeScript, Expo lint, and 61 Vitest checks pass. The phone UI exposes
  Bezi and Unity as the only primary tabs. Installed release clients ignore
  Expo proof credential overrides and rely on Android SecureStore pairing.
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
  `native-streaming` enabled. Expo typecheck/lint and all 14 mobile test files
  (61 tests) pass; the native companion suite passes 33 tests with two
  interactive hardware tests intentionally ignored in the default run. The
  interactive Bezi-window media test also passes separately with real H.264
  video and Opus audio RTP.
- Android pre-handoff: an Android 15 x86_64 emulator installed the preview APK,
  accepted the expiring secure bootstrap, discovered the running Windows host,
  obtained a session ticket, and opened the encrypted WebSocket. Bezi loaded
  real workspaces, projects, and an existing live thread; Unity reported the
  connected 6000.3.16f1 Editor and open project. A forced cold restart repeated
  host discovery and reconnection with no app TLS error or crash.
- Android regressions found and fixed: initial workspace loading now uses the
  fast catalog instead of failing on an incomplete desktop Pages scan, and
  installed clients no longer let stale Expo proof variables override the
  credentials saved from a new Android setup link. The WebRTC viewer now
  preserves every config/offer/ICE event, serializes their delivery inside the
  Android WebView, accepts streamless audio/video tracks, and correlates native
  trickle ICE with the active stream request. The Windows setups were rebuilt
  with the `native-streaming` companion payload and both embedded-payload checks
  pass.
- Android live-media proof: Android 15 applied preview update
  `019fdd4c-03f7-7e3a-896e-4f4664799c5d`, paired to the real Windows companion,
  selected Demo / Krazy Kicks, and decoded the Unity Editor Game view over
  WebRTC. The app simultaneously reported Unity `Live`, Editor `6000.3.16f1`,
  scene `untitled 2`, and the live Main Camera / Directional Light / Cube
  hierarchy. Emulator-only address translation showed bidirectional ICE traffic;
  logcat showed continuing H.264 depacketization/decoding with no candidate-order
  error, TLS failure, fatal exception, or app crash. A forced cold restart then
  reconnected from Android SecureStore without pairing again.
- Thread live-follow: streamed Bezi responses now keep the newest text in view
  through a frame-coalesced `FlatList.scrollToEnd`. Only a deliberate user drag
  now suspends following immediately, keeps it suspended through momentum, and
  resets a 15-second idle timer for every subsequent scroll event. Keyboard
  focus and reaching the bottom cannot bypass that cooldown; programmatic
  scroll/layout events do not start one. Three focused timer tests pass alongside
  the complete 64-test mobile suite. Android preview update
  `019fdde1-035d-77a3-980d-ac620f4492f7` was applied and confirmed in the
  emulator update database with one successful launch and no failed launches.
  During a real 200-line streamed Bezi response, the timeline crop at 13 seconds
  after the final manual swipe was pixel-identical to the 1-second capture (SSIM
  `1.000000`); at 17 seconds it resumed at the newest lines (SSIM `0.366055`
  against the paused view).
- Android signed handoff: EAS preview build
  `9d3a7224-6557-4c13-8788-7a3c10dde675` (embedded commit `853869a`) finished
  successfully and was downloaded from its exact artifact URL as
  `dist/bezi-buddy-android/Bezi Buddy Android.apk` (106,188,994 bytes; SHA-256
  `55D597606F3FD4C296A169D303F48507D96EFD1ADCE27B84E8D9D41E424DAF49`).
  Android Build Tools 36 verified its v2 APK signature, single RSA-2048 signer,
  package `app.beziremote.mobile`, and version `0.1.0 (1)`. After a clean
  uninstall, that exact APK paired through the running Windows companion,
  loaded the real Demo workspace, Krazy Kicks project, and existing Bezi
  thread, then applied preview update
  `019fdde1-035d-77a3-980d-ac620f4492f7` with one successful launch and no
  failed launches. Unity reconnected as `Live` on Editor `6000.3.16f1`, scene
  `untitled 2`; Android rendered the real Game view through WebRTC H.264/AVC
  using `c2.goldfish.h264.decoder` while the hierarchy simultaneously listed
  Main Camera, Directional Light, Cube, and Plane. A force-stop/cold relaunch
  returned directly to workspace selection from Android SecureStore, required
  no second pairing, and restored both live Unity video and hierarchy. Evidence
  screenshots are `exact-apk-workspaces.png`, `exact-apk-bezi.png`,
  `exact-apk-unity-live.png`, `exact-apk-cold-restart.png`, and
  `exact-apk-cold-unity.png` in the Android lab evidence directory.
- Windows handoff packages: both setup payload checks and the Unity bridge
  install/update test pass without a rebuild. `Bezi Buddy Android Setup.exe`
  hashes to `97FBC1B575BCD01630BB81A15248940D1ED98D4AB3AF5A6921A644D4CB838F64`;
  `Bezi Buddy iOS Expo Go Setup.exe` hashes to
  `CEE9F126194842EAE42CFE8D095B9674988D7039D523D1A75F653506746777CD`.

## Resume point

Distribute the validated Android APK and Android CLI-style Windows setup bundle
for physical Android testing. The remaining external gate is physical-iPhone
cellular playback/input testing.
