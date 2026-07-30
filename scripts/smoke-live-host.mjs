import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  decryptPayload,
  deriveSessionKeys,
  encryptPayload,
} from "../packages/protocol/dist/index.js";

const session = JSON.parse(await readFile(new URL("../.proof/session.json", import.meta.url)));
const mobileEnvironment = Object.fromEntries(
  (await readFile(new URL("../apps/mobile/.env.local", import.meta.url), "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
const relayUrl = "http://127.0.0.1:8787";
const hostId = mobileEnvironment.EXPO_PUBLIC_DEV_HOST_ID;
const mobileDeviceId = mobileEnvironment.EXPO_PUBLIC_DEV_MOBILE_DEVICE_ID;
const pairSecret = decodeBase64Url(mobileEnvironment.EXPO_PUBLIC_DEV_PAIR_SECRET);
const authHeaders = {
  authorization: `Bearer ${session.ownerToken}`,
  "content-type": "application/json",
};

const ticketResponse = await fetch(
  new URL(`/v1/hosts/${encodeURIComponent(hostId)}/session-ticket`, relayUrl),
  {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ deviceId: mobileDeviceId, role: "viewer" }),
  },
);
if (!ticketResponse.ok) {
  throw new Error(`Viewer ticket failed (${ticketResponse.status})`);
}
const { ticket } = await ticketResponse.json();
const socketUrl = new URL(`/v1/hosts/${encodeURIComponent(hostId)}/connect`, relayUrl);
socketUrl.protocol = "ws:";
socketUrl.searchParams.set("ticket", ticket);
const socket = new WebSocket(socketUrl);
const queue = [];
let stage = "opening relay socket";
socket.addEventListener("message", (event) => queue.push(JSON.parse(String(event.data))));
await eventOnce(socket, "open", 5_000);
stage = "joining relay room";
const joined = await nextMessage(queue, (value) => value.type === "relay.joined");
const keys = deriveSessionKeys({
  pairSecret,
  sessionSalt: Uint8Array.from(joined.sessionSalt.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16))),
  hostId,
  mobileDeviceId,
});
const prefix = randomBytes(4);
let sequence = 0;

socket.send(JSON.stringify({ type: "relay.lease.request", durationSeconds: 30 }));
stage = "acquiring controller lease";
await nextMessage(
  queue,
  (value) => value.type === "relay.lease" && value.holderDeviceId === mobileDeviceId,
);

const send = (type, body, kind = "control") => {
  const requestId = randomUUID();
  const frame = encryptPayload({
    key: keys.mobileToHost,
    noncePrefix: prefix,
    sequence: sequence++,
    hostId,
    connectionId: joined.connectionId,
    direction: "mobile-to-host",
    kind,
    payload: { v: 1, requestId, type, body },
  });
  socket.send(JSON.stringify({ type: "relay.frame", frame }));
  return requestId;
};
const nextPayload = async (predicate, timeout = 8_000) => {
  const routed = await nextMessage(
    queue,
    (value) => {
      if (value.type !== "relay.frame") return false;
      try {
        value.decrypted = decryptPayload(keys.hostToMobile, value.frame);
        return predicate(value.decrypted);
      } catch {
        return false;
      }
    },
    timeout,
  );
  return routed.decrypted;
};

const helloRequest = send(
  "system.hello",
  { deviceId: mobileDeviceId, renderer: "smoke", client: "proof-smoke" },
  "signaling",
);
stage = "loading host capabilities";
const capabilities = await nextPayload(
  (payload) =>
    payload.requestId === helloRequest && payload.type === "system.capabilities",
);
const instances = capabilities.body.unity?.instances ?? [];

const catalogRequest = send("bezi.catalog.get", {}, "signaling");
stage = "loading live Bezi catalog";
const catalog = await nextPayload(
  (payload) =>
    payload.requestId === catalogRequest && payload.type === "bezi.catalog",
  25_000,
);
const beziWorkspace = catalog.body.workspace ?? {};
if (!Array.isArray(beziWorkspace.sessions) || beziWorkspace.sessions.length === 0) {
  throw new Error("The persisted Bezi thread catalog was empty");
}
const workspaces = Array.isArray(beziWorkspace.workspaces)
  ? beziWorkspace.workspaces
  : [];
const activeWorkspace =
  workspaces.find(
    (workspace) => workspace.id === beziWorkspace.activeWorkspaceId,
  ) ??
  workspaces.find((workspace) => workspace.isActive === true) ??
  workspaces[0];
if (!activeWorkspace) {
  throw new Error("The grouped Bezi workspace catalog was empty");
}
const activeProject =
  activeWorkspace.projects?.find(
    (project) => project.id === beziWorkspace.activeProjectId,
  ) ?? activeWorkspace.projects?.[0];
if (!activeProject?.path) throw new Error("The active Bezi project path was unavailable");
const sessionListRequest = send(
  "bezi.session.list",
  { cwd: activeProject.path },
  "signaling",
);
stage = "loading live Bezi threads";
const sessionList = await nextPayload(
  (payload) =>
    payload.requestId === sessionListRequest &&
    payload.type === "bezi.acp.response",
  15_000,
);
const liveSessions = sessionList.body.message?.result?.sessions ?? [];
if (liveSessions.length === 0) throw new Error("Bezi ACP returned no live threads");
const replaySession = [...liveSessions].sort((left, right) =>
  String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")),
)[0];
const loadRequest = send(
  "bezi.session.load",
  {
    sessionId: replaySession.sessionId,
    cwd: replaySession.cwd,
    mcpServers: [],
  },
  "signaling",
);
stage = "replaying a populated Bezi thread";
await nextPayload(
  (payload) =>
    payload.requestId === loadRequest && payload.type === "bezi.acp.response",
  25_000,
);
const replayUpdates = [];
for (let index = queue.length - 1; index >= 0; index -= 1) {
  const message = queue[index];
  if (message.type !== "relay.frame") continue;
  let payload;
  try {
    payload = message.decrypted ?? decryptPayload(keys.hostToMobile, message.frame);
  } catch {
    continue;
  }
  if (
    payload.type === "bezi.acp.event" &&
    payload.body.message?.method === "session/update" &&
    payload.body.message?.params?.sessionId === replaySession.sessionId
  ) {
    replayUpdates.push(payload.body.message.params.update);
    queue.splice(index, 1);
  }
}
const replayKinds = Object.fromEntries(
  Object.entries(
    replayUpdates.reduce((counts, update) => {
      const kind = update.sessionUpdate ?? update.type ?? "unknown";
      counts[kind] = (counts[kind] ?? 0) + 1;
      return counts;
    }, {}),
  ).sort((left, right) => right[1] - left[1]),
);
const replayHasMessageContent = replayUpdates.some(
  (update) =>
    update.sessionUpdate === "user_message_chunk" ||
    update.sessionUpdate === "agent_message_chunk",
);
if (!replayHasMessageContent && !process.argv.includes("--bezi-only")) {
  throw new Error("The selected Bezi thread replayed no message content");
}

if (process.argv.includes("--bezi-only")) {
  socket.send(JSON.stringify({ type: "relay.lease.release" }));
  socket.close();
  process.stdout.write(
    `${JSON.stringify(
      {
        beziConnected: capabilities.body.bezi?.connected === true,
        beziActiveWorkspace: activeWorkspace.label,
        beziActiveProject: activeProject.label,
        beziWorkspaceCount: workspaces.length,
        beziWorkspaceProjectCount: activeWorkspace.projects?.length ?? 0,
        beziWorkspaces: workspaces.map((workspace) => ({
          label: workspace.label,
          projectCount: workspace.projects?.length ?? 0,
          activeProject:
            workspace.projects?.find(
              (project) => project.id === workspace.activeProjectId,
            )?.label ?? null,
        })),
        beziLiveThreads: liveSessions.length,
        beziReplayedThread: replaySession.title,
        beziReplayUpdates: replayUpdates.length,
        beziReplayHasMessageContent: replayHasMessageContent,
        beziReplayKinds: replayKinds,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(0);
}

if (!instances.some((instance) => instance.projectName === "Battle Soccer")) {
  throw new Error("The running Battle Soccer Unity Editor was not advertised");
}
const instanceId = instances.find((instance) => instance.projectName === "Battle Soccer").instanceId;
const hierarchyRequest = send("unity.hierarchy.snapshot", { instanceId }, "signaling");
stage = "loading Unity hierarchy";
const hierarchy = await nextPayload(
  (payload) => payload.requestId === hierarchyRequest && payload.type === "unity.result",
);
const nodes = hierarchy.body.result?.nodes ?? [];
if (nodes.length === 0) throw new Error("The live Unity hierarchy was empty");

const assetsRequest = send("unity.assets.snapshot", { instanceId }, "signaling");
stage = "loading ScriptableObjects";
const assets = await nextPayload(
  (payload) => payload.requestId === assetsRequest && payload.type === "unity.result",
);

const inspectorRequest = send(
  "unity.inspector.snapshot",
  { instanceId, targetId: nodes[0].id },
  "signaling",
);
stage = "loading Unity inspector";
const inspector = await nextPayload(
  (payload) => payload.requestId === inspectorRequest && payload.type === "unity.result",
);
if (!Array.isArray(inspector.body.result?.components)) {
  throw new Error("The live component inspector schema was not returned");
}

socket.send(JSON.stringify({ type: "relay.lease.release" }));
socket.close();
process.stdout.write(
  JSON.stringify(
    {
      beziConnected: capabilities.body.bezi?.connected === true,
      beziProjects: capabilities.body.beziWorkspace?.projects?.map((project) => project.label) ?? [],
      beziThreads: beziWorkspace.sessions.length,
      beziLiveThreads: liveSessions.length,
      beziReplayedThread: replaySession.title,
      beziReplayUpdates: replayUpdates.length,
      beziReplayKinds: replayKinds,
      beziPages: beziWorkspace.ui.pages.map((page) => page.title),
      beziCanvases: beziWorkspace.ui.canvases?.map((canvas) => canvas.title) ?? [],
      beziNavigation: beziWorkspace.ui.navigation?.map((item) => item.title) ?? [],
      unityProject: instances[0].projectName,
      openScenes: instances[0].openScenes,
      hierarchySample: nodes.slice(0, 10).map((node) => node.name),
      scriptableObjects: assets.body.result?.assets?.length ?? 0,
      firstInspectorComponents: inspector.body.result.components.map((component) => component.typeName),
    },
    null,
    2,
  ),
);
process.stdout.write("\n");

function decodeBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

function eventOnce(target, name, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} timed out`)), timeout);
    target.addEventListener(
      name,
      (event) => {
        clearTimeout(timer);
        resolve(event);
      },
      { once: true },
    );
    target.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error(`${name} failed`));
      },
      { once: true },
    );
  });
}

function nextMessage(queue, predicate, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const timer = setInterval(() => {
      const index = queue.findIndex(predicate);
      if (index >= 0) {
        const [message] = queue.splice(index, 1);
        clearInterval(timer);
        resolve(message);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out while ${stage}`));
      }
    }, 10);
  });
}
