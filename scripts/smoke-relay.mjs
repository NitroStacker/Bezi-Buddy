import { createHash, randomUUID } from "node:crypto";

const relayUrl = process.env.BEZI_REMOTE_RELAY_URL ?? "http://127.0.0.1:8787";
const ownerToken = process.env.BEZI_REMOTE_OWNER_TOKEN;
if (!ownerToken) throw new Error("BEZI_REMOTE_OWNER_TOKEN is required");

const authHeaders = {
  authorization: `Bearer ${ownerToken}`,
  "content-type": "application/json",
};
const pairingId = randomUUID();
const hostId = `host-${randomUUID()}`;
const mobileDeviceId = `mobile-${randomUUID()}`;
const claimCode = randomUUID().replaceAll("-", "");
const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
const codeHash = createHash("sha256").update(claimCode).digest("base64url");

await request("/v1/pairings", {
  method: "POST",
  body: {
    pairingId,
    hostId,
    hostName: "Relay smoke host",
    codeHash,
    expiresAt,
    companionVersion: "smoke",
  },
});
await request(`/v1/pairings/${pairingId}/claim`, {
  method: "POST",
  body: {
    claimCode,
    mobileDeviceId,
    deviceName: "Relay smoke phone",
    keyFingerprint: "smoke-fingerprint",
  },
});

const hostTicket = await ticket(hostId, hostId, "host");
const mobileTicket = await ticket(hostId, mobileDeviceId, "viewer");
const host = await connect(hostId, hostTicket.ticket);
const mobile = await connect(hostId, mobileTicket.ticket);
const hostJoined = await nextType(host, "relay.joined");
const mobileJoined = await nextType(mobile, "relay.joined");
assert(
  hostJoined.connectionId === mobileJoined.connectionId,
  "host and mobile must share one encrypted connection ID",
);
assert(
  hostJoined.sessionSalt === mobileJoined.sessionSalt,
  "host and mobile must share one session salt",
);

const signalingFrame = frame(hostId, hostJoined.connectionId, "mobile-to-host", "signaling", 0);
mobile.send(JSON.stringify({ type: "relay.frame", frame: signalingFrame }));
const routedSignal = await nextType(host, "relay.frame");
assert(
  routedSignal.senderDeviceId === mobileDeviceId,
  "relay must attach the authenticated sender identity",
);

mobile.send(
  JSON.stringify({
    type: "relay.frame",
    frame: frame(hostId, hostJoined.connectionId, "mobile-to-host", "control", 1),
  }),
);
const denied = await nextType(mobile, "relay.error");
assert(denied.code === "lease_required", "control must require a controller lease");

mobile.send(JSON.stringify({ type: "relay.lease.request", durationSeconds: 30 }));
const lease = await nextType(
  mobile,
  "relay.lease",
  (value) => value.holderDeviceId === mobileDeviceId,
);
assert(lease.holderDeviceId === mobileDeviceId, "lease must bind to the mobile identity");
await nextType(host, "relay.lease", (value) => value.holderDeviceId === mobileDeviceId);

mobile.send(
  JSON.stringify({
    type: "relay.frame",
    frame: frame(hostId, hostJoined.connectionId, "mobile-to-host", "control", 2),
  }),
);
await nextType(host, "relay.frame");

host.send(
  JSON.stringify({
    type: "relay.frame",
    recipientDeviceId: mobileDeviceId,
    frame: frame(hostId, hostJoined.connectionId, "host-to-mobile", "control", 0),
  }),
);
const routedHostFrame = await nextType(mobile, "relay.frame");
assert(routedHostFrame.senderDeviceId === hostId, "host frame identity must be authenticated");

mobile.close();
host.close();
process.stdout.write("relay smoke passed\n");

async function ticket(targetHostId, deviceId, role) {
  return request(`/v1/hosts/${targetHostId}/session-ticket`, {
    method: "POST",
    body: { deviceId, role },
  });
}

async function request(path, { method, body }) {
  const response = await fetch(new URL(path, relayUrl), {
    method,
    headers: authHeaders,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${await response.text()}`);
  }
  return response.status === 204 ? undefined : response.json();
}

async function connect(targetHostId, ticketValue) {
  const url = new URL(`/v1/hosts/${targetHostId}/connect`, relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticketValue);
  const socket = new WebSocket(url);
  socket.messageQueue = [];
  socket.addEventListener("message", (event) => {
    socket.messageQueue.push(JSON.parse(String(event.data)));
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket open timed out")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket open failed"));
    });
  });
  return socket;
}

function nextType(socket, type, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`Timed out waiting for ${type}`));
    }, 5_000);
    const poll = setInterval(() => {
      const index = socket.messageQueue.findIndex(
        (value) => value.type === type && predicate(value),
      );
      if (index < 0) return;
      const [value] = socket.messageQueue.splice(index, 1);
      clearTimeout(timeout);
      clearInterval(poll);
      resolve(value);
    }, 10);
  });
}

function frame(targetHostId, connectionId, direction, kind, seq) {
  return {
    v: 1,
    hostId: targetHostId,
    connectionId,
    direction,
    kind,
    seq,
    nonce: "AQIDBAUGBwgJCgsM",
    ciphertext: "AQIDBAUGBwgJCgsMDQ4PEA==",
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
