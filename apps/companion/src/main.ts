import { invoke } from "@tauri-apps/api/core";
import QRCode from "qrcode";
import { normalizeRelayUrl } from "./validation";
import "./styles.css";

type CompanionStatus = {
  hostId: string;
  beziInstalled: boolean;
  beziConnected: boolean;
  beziVersion?: string;
  unityInstances: number;
  relayConfigured: boolean;
  controlArmed: boolean;
  stream: {
    available: boolean;
    dependenciesReady: boolean;
    captureBackend?: string;
    encoder?: string;
    audioBackend?: string;
    reason: string;
  };
};

type PairingResult = {
  qrPayload: string;
  pairingId: string;
  expiresAt: string;
};

type PairingStatus = {
  state: "pending" | "claimed" | "expired";
  mobileDeviceId?: string;
};

type ProofDefaults = {
  relayUrl: string;
  ownerToken: string;
};

let activePairingId: string | null = null;
let pairingPoll: number | null = null;

const form = document.querySelector<HTMLFormElement>("#pair-form")!;
const relayUrl = document.querySelector<HTMLInputElement>("#relay-url")!;
const ownerToken = document.querySelector<HTMLInputElement>("#owner-token")!;
const pairButton = document.querySelector<HTMLButtonElement>("#pair-button")!;
const formError = document.querySelector<HTMLParagraphElement>("#form-error")!;
const qr = document.querySelector<HTMLCanvasElement>("#qr")!;
const qrEmpty = document.querySelector<HTMLDivElement>("#qr-empty")!;
const qrCaption = document.querySelector<HTMLParagraphElement>("#qr-caption")!;

async function refreshStatus(): Promise<void> {
  try {
    const status = await invoke<CompanionStatus>("get_status");
    document.querySelector("#host-id")!.textContent = `Host ${status.hostId.slice(-12)}`;
    document.querySelector("#bezi-status")!.textContent = status.beziInstalled
      ? status.beziConnected
        ? `Connected · ${status.beziVersion ?? "version detected"}`
        : `Detected · ${status.beziVersion ?? "not connected"}`
      : "Not running";
    document.querySelector("#unity-status")!.textContent =
      status.unityInstances > 0
        ? `${status.unityInstances} Editor ${status.unityInstances === 1 ? "instance" : "instances"}`
        : "Waiting for package";
    document.querySelector("#control-status")!.textContent = status.controlArmed
      ? "Remote control active"
      : "Disarmed";

    const streamStatus = document.querySelector("#stream-status")!;
    streamStatus.textContent = status.stream.available
      ? `${status.stream.encoder ?? "H.264"} · WebRTC ready`
      : status.stream.dependenciesReady
        ? "Media stack installed · native build required"
        : "Media dependency required";
    streamStatus.setAttribute("title", status.stream.reason);

    const pill = document.querySelector("#relay-pill")!;
    pill.classList.toggle("online", status.relayConfigured);
    pill.querySelector("span")!.textContent = status.relayConfigured
      ? "Relay configured"
      : "Not configured";
  } catch (error) {
    formError.textContent = String(error);
  }
}

async function loadProofDefaults(): Promise<void> {
  try {
    const defaults = await invoke<ProofDefaults>("get_proof_defaults");
    if (defaults.relayUrl) relayUrl.value = defaults.relayUrl;
    if (defaults.ownerToken) ownerToken.value = defaults.ownerToken;
  } catch {
    // Packaged production builds deliberately start without proof credentials.
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.textContent = "";
  pairButton.disabled = true;
  pairButton.textContent = "Creating encrypted code…";
  try {
    const result = await invoke<PairingResult>("create_pairing", {
      relayUrl: normalizeRelayUrl(relayUrl.value),
      ownerToken: ownerToken.value,
    });
    await QRCode.toCanvas(qr, result.qrPayload, {
      width: 256,
      margin: 2,
      color: { dark: "#1b1a1a", light: "#f4f2ee" },
      errorCorrectionLevel: "M",
    });
    qr.style.display = "block";
    qrEmpty.style.display = "none";
    const expiry = new Date(result.expiresAt);
    qrCaption.textContent = `Private code ${result.pairingId.slice(0, 8)} expires at ${expiry.toLocaleTimeString()}.`;
    activePairingId = result.pairingId;
    if (pairingPoll !== null) window.clearInterval(pairingPoll);
    pairingPoll = window.setInterval(() => void refreshPairing(), 1_500);
    ownerToken.value = "";
    await refreshStatus();
  } catch (error) {
    formError.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    pairButton.disabled = false;
    pairButton.textContent = "Create private pairing code";
  }
});

async function refreshPairing(): Promise<void> {
  if (!activePairingId) return;
  try {
    const status = await invoke<PairingStatus>("get_pairing_status", {
      pairingId: activePairingId,
    });
    if (status.state === "claimed") {
      if (pairingPoll !== null) window.clearInterval(pairingPoll);
      pairingPoll = null;
      activePairingId = null;
      qr.style.display = "none";
      qrEmpty.style.display = "grid";
      qrEmpty.innerHTML =
        "<strong>Paired securely</strong><span>The phone can now open an encrypted session.</span>";
      qrCaption.textContent = `Device ${status.mobileDeviceId?.slice(-12) ?? "confirmed"} is ready.`;
      await refreshStatus();
    } else if (status.state === "expired") {
      if (pairingPoll !== null) window.clearInterval(pairingPoll);
      pairingPoll = null;
      activePairingId = null;
      qrCaption.textContent = "This private code expired. Create a new one to pair.";
    }
  } catch {
    // A transient relay interruption is retried by the next bounded poll.
  }
}

void loadProofDefaults();
void refreshStatus();
window.setInterval(() => void refreshStatus(), 2_000);
