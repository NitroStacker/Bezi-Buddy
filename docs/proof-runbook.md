# Expo Go proof runbook

## 1. Local validation

```powershell
pnpm install
pnpm typecheck
pnpm lint
pnpm test
.\scripts\Companion-Native.ps1 test
pnpm build:companion:native
```

The native build requires the GStreamer 1.x MSVC x64 runtime and development
packages. The wrapper locates the per-user installation, supplies the linker
environment, and enables the `native-streaming` Cargo feature.

Install the Unity package only after reviewing the target and backup path:

```powershell
.\scripts\Install-UnityPackage.ps1 -UnityProject "C:\Path\To\Project" -Confirm
```

The installer copies the package into `Packages\app.beziremote.unity`, backs up
`Packages\manifest.json`, and adds a local file dependency.

## 2. Start the proof

```powershell
pnpm proof:expo-go
```

The launcher:

- initializes local Wrangler, D1, and Durable Object state;
- generates a temporary one-owner proof token;
- starts Metro and the local signaling service;
- places both behind one local path mux;
- opens one unauthenticated Cloudflare Quick Tunnel;
- prints one `exp://...trycloudflare.com` URL for Expo Go;
- injects the temporary public URL into the development bundle; and
- starts the companion with native GStreamer streaming enabled.

No Wrangler login, Cloudflare account, deployed Worker, remote D1 database,
TURN key, or Cloudflare secret is required for Stage A. Quick Tunnel hostnames
change every time the launcher starts and are development-only.

The public hostname routes `/v1/*` and `/health` to the local signaling service
and all other paths to Expo Metro, including WebSocket upgrades.

## 3. Pairing

1. Open the printed `exp://...trycloudflare.com` URL in Expo Go.
2. In the companion, click **Create private pairing code**. The proof URL and
   development token are prefilled by the launcher.
3. In Expo Go, open Settings from Bezi or Unity mode and scan the QR.
4. Confirm the paired host appears and connect.

The E2EE pairing secret is held in Windows Credential Manager and iOS
SecureStore, not in the local relay database.

## 4. Required physical proof

Put the iPhone on cellular and the PC on a different network. Pass all of these
before declaring Stage A complete:

- Bezi mode lists/resumes a session, sends a prompt, streams the response, and
  resolves an advertised permission option.
- Unity mode receives the real hierarchy, selects an object, reads its typed
  inspector, applies one revision-checked value, and can Undo it in Unity.
- Play, pause, step, stop, and gameplay input release immediately on lease loss.
- H.264/Opus video and audio connect through direct WebRTC using Cloudflare's
  public STUN endpoint and reconnect within the defined budgets.
- Backgrounding the phone disarms control and releases every held input.

Stage A intentionally does not claim TURN-only reliability. Add production
short-lived TURN credentials in the development-build/TestFlight phase if the
target cellular/NAT combinations require a media relay.

If WebView WebRTC cannot meet the media gates in Expo Go, move to the existing
EAS development-build profile without changing product screens or protocol
logic.
