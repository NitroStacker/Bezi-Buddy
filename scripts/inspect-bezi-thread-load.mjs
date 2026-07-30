import { readFile } from "node:fs/promises";
import { join } from "node:path";

const appData = process.env.APPDATA;
if (!appData) throw new Error("APPDATA is unavailable");

const root = join(appData, "com.bezi.app");
const descriptor = JSON.parse(await readFile(join(root, "acp.json"), "utf8"));
const projectCatalog = JSON.parse(
  await readFile(join(root, "projects.json"), "utf8"),
);
const sessionCatalog = JSON.parse(
  await readFile(join(root, "acp-sessions.json"), "utf8"),
);

const projectById = new Map(
  (projectCatalog.projects ?? []).map((project) => [project.id, project]),
);
const sessions = Object.values(sessionCatalog.sessions ?? {})
  .map((session) => ({
    ...session,
    project: projectById.get(session.projectUUID),
  }))
  .filter((session) => session.sessionId && session.project?.path)
  .sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")),
  );
const requestedProject = process.argv.slice(2).join(" ").trim().toLowerCase();
const persistedSession =
  sessions.find(
    (entry) =>
      requestedProject &&
      String(entry.project?.label ?? "").toLowerCase().includes(requestedProject),
  ) ?? sessions[0];
const requestedCatalogProject = (projectCatalog.projects ?? []).find(
  (project) =>
    requestedProject &&
    String(project?.label ?? "").toLowerCase().includes(requestedProject),
);
const session = requestedCatalogProject
  ? {
      sessionId: null,
      projectUUID: requestedCatalogProject.id,
      workspaceUUID: null,
      updatedAt: null,
      project: requestedCatalogProject,
    }
  : persistedSession;

if (!session) throw new Error("No persisted Bezi ACP session was found");

const socket = new WebSocket(`ws://127.0.0.1:${descriptor.port}`, [
  "bezi-acp.v1",
  "bv.1",
  `token.${descriptor.token}`,
]);
const received = [];
socket.addEventListener("message", (event) => {
  try {
    received.push(JSON.parse(String(event.data)));
  } catch {
    received.push({ invalidJson: true });
  }
});
await eventOnce(socket, "open", 5_000);

socket.send(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: {},
      },
      clientInfo: {
        name: "bezi-remote-history-inspector",
        title: "Bezi Remote History Inspector",
        version: "0.1.0",
      },
    },
  }),
);
await waitFor(() => received.some((message) => message.id === 1), 5_000);

socket.send(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "session/list",
    params: {
      cwd: session.project.path,
    },
  }),
);
await waitFor(() => received.some((message) => message.id === 2), 5_000);
const liveListResponse = received.find((message) => message.id === 2);
const listedSessions = Array.isArray(liveListResponse?.result?.sessions)
  ? liveListResponse.result.sessions
  : [];
const listedSession =
  listedSessions.find(
    (entry) => session.sessionId && entry?.sessionId === session.sessionId,
  ) ??
  [...listedSessions].sort((left, right) =>
    String(right?.updatedAt ?? "").localeCompare(String(left?.updatedAt ?? "")),
  )[0];
const loadSessionId = listedSession?.sessionId ?? session.sessionId;
const catalogSessionIds = new Set(sessions.map((entry) => entry.sessionId));
const listedSessionIds = new Set(
  listedSessions.map((entry) => entry?.sessionId).filter(Boolean),
);

socket.send(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "session/load",
    params: {
      sessionId: loadSessionId,
      cwd: session.project.path,
      mcpServers: [],
    },
  }),
);
await waitFor(() => received.some((message) => message.id === 3), 12_000);
await delay(2_500);
socket.close();

const initializeResponse = received.find((message) => message.id === 1);
const listResponse = received.find((message) => message.id === 2);
const loadResponse = received.find((message) => message.id === 3);
const updates = received.filter((message) => message.method === "session/update");
const updateSummaries = updates.map((message) => {
  const params = record(message.params);
  const update = record(params.update);
  return {
    sessionMatches: params.sessionId === loadSessionId,
    updateKeys: Object.keys(update),
    sessionUpdate: string(update.sessionUpdate),
    type: string(update.type),
    contentShape: shape(update.content),
    messageShape: shape(update.message),
    textLength:
      extractedTextLength(update.content) ||
      extractedTextLength(update.message) ||
      extractedTextLength(update.text),
    tool:
      update.sessionUpdate === "tool_call"
        ? {
            kind: string(update.kind),
            title:
              typeof update.title === "string"
                ? { length: update.title.length, preview: update.title.slice(0, 120) }
                : null,
            status: string(update.status),
            contentItems: Array.isArray(update.content)
              ? update.content.slice(0, 12).map(summarizeToolContent)
              : [],
          }
        : null,
  };
});
const kinds = Object.entries(
  updateSummaries.reduce((counts, update) => {
    const kind = update.sessionUpdate || update.type || "(missing)";
    counts[kind] = (counts[kind] ?? 0) + 1;
    return counts;
  }, {}),
).sort((left, right) => right[1] - left[1]);

process.stdout.write(
  `${JSON.stringify(
    {
      project: session.project.label,
      sessionIdSuffix: String(loadSessionId).slice(-8),
      initialize: {
        resultKeys: Object.keys(record(initializeResponse?.result)),
        capabilitiesShape: shape(initializeResponse?.result?.agentCapabilities),
      },
      listResponse: {
        hasResult: Boolean(listResponse?.result),
        hasError: Boolean(listResponse?.error),
        resultKeys: Object.keys(record(listResponse?.result)),
        sessionCount: Array.isArray(listResponse?.result?.sessions)
          ? listResponse.result.sessions.length
          : 0,
        selected: summarizeSessionInfo(
          listResponse?.result?.sessions?.find(
            (entry) => entry?.sessionId === loadSessionId,
          ),
        ),
        samples: Array.isArray(listResponse?.result?.sessions)
          ? listResponse.result.sessions.slice(0, 5).map(summarizeSessionInfo)
          : [],
        catalogCount: sessions.length,
        catalogIntersectionCount: listedSessions.filter((entry) =>
          catalogSessionIds.has(entry?.sessionId),
        ).length,
        newestCatalogPresence: sessions.slice(0, 10).map((entry) => ({
          idSuffix: String(entry.sessionId).slice(-8),
          present: listedSessionIds.has(entry.sessionId),
          updatedAt: entry.updatedAt ?? null,
        })),
      },
      loadResponse: {
        hasResult: Boolean(loadResponse?.result),
        hasError: Boolean(loadResponse?.error),
        resultKeys: Object.keys(record(loadResponse?.result)),
        resultShape: shape(loadResponse?.result),
      },
      messagesBeforeLoadResponse: received.findIndex((message) => message.id === 3),
      updateCount: updates.length,
      kinds,
      sampleUpdates: updateSummaries.slice(0, 50),
    },
    null,
    2,
  )}\n`,
);

function summarizeSessionInfo(value) {
  const info = record(value);
  return {
    idSuffix:
      typeof info.sessionId === "string" ? info.sessionId.slice(-8) : null,
    title:
      typeof info.title === "string"
        ? { length: info.title.length, preview: info.title.slice(0, 80) }
        : null,
    updatedAt: typeof info.updatedAt === "string" ? info.updatedAt : null,
    keys: Object.keys(info),
    metaShape: shape(info._meta),
  };
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function string(value) {
  return typeof value === "string" ? value : null;
}

function shape(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return { type: "string", length: value.length };
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      first: value.length > 0 ? shape(value[0]) : null,
    };
  }
  if (typeof value === "object") {
    return { type: "object", keys: Object.keys(value).slice(0, 30) };
  }
  return { type: typeof value };
}

function extractedTextLength(value) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + extractedTextLength(entry), 0);
  }
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text.length;
    if (Array.isArray(value.content)) return extractedTextLength(value.content);
  }
  return 0;
}

function summarizeToolContent(value) {
  const item = record(value);
  const props = record(item.props);
  return {
    type: string(item.type),
    componentType: string(item.componentType),
    path: string(item.path),
    oldTextLength:
      typeof item.oldText === "string" ? item.oldText.length : null,
    newTextLength:
      typeof item.newText === "string" ? item.newText.length : null,
    contentShape: shape(item.content),
    propsKeys: Object.keys(props).slice(0, 30),
    title:
      typeof props.title === "string"
        ? { length: props.title.length, preview: props.title.slice(0, 120) }
        : null,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function eventOnce(target, eventName, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${eventName} timed out`)),
      timeout,
    );
    target.addEventListener(
      eventName,
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
        reject(new Error(`${eventName} failed`));
      },
      { once: true },
    );
  });
}

function waitFor(predicate, timeout) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for Bezi ACP"));
      }
    }, 20);
  });
}
