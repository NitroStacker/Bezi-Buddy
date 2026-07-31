export type BeziSession = {
  id: string;
  threadId?: string;
  title: string;
  cwd?: string;
  projectId?: string;
  projectLabel?: string;
  workspaceId?: string;
  updatedAt?: string;
};

export type BeziDiffFile = {
  path: string;
  oldText: string;
  newText: string;
  additions: number;
  deletions: number;
};

export type BeziDiffLine = {
  kind: "context" | "added" | "removed";
  text: string;
  oldNumber?: number;
  newNumber?: number;
};

export type BeziChatEntry = {
  id: string;
  role: "user" | "assistant" | "activity";
  text: string;
  detail?: string;
  streamKey?: string;
  activityKind?: "thought" | "tool" | "code" | "plan" | "command";
  toolKind?: string;
  status?: string;
  files?: BeziDiffFile[];
};

export type BeziAgentStatus = {
  label: string;
  detail?: string;
  active: boolean;
};

export function parseBeziSessions(value: unknown): BeziSession[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asRecord)
    .filter((session): session is Record<string, unknown> => session !== null)
    .flatMap((session): BeziSession[] => {
      const id =
        stringValue(session.sessionId) ??
        stringValue(session.id) ??
        stringValue(session.session_id);
      if (!id) return [];
      return [
        {
          id,
          threadId:
            stringValue(session.threadId) ??
            stringValue(session.threadUUID) ??
            stringValue(session.thread_id) ??
            undefined,
          title:
            stringValue(session.title) ??
            stringValue(session.name) ??
            stringValue(session.summary) ??
            "Untitled thread",
          cwd: stringValue(session.cwd) ?? stringValue(session.path) ?? undefined,
          projectId: stringValue(session.projectId) ?? undefined,
          projectLabel: stringValue(session.projectLabel) ?? undefined,
          workspaceId: stringValue(session.workspaceId) ?? undefined,
          updatedAt:
            stringValue(session.updatedAt) ??
            stringValue(session.updated_at) ??
            undefined,
        },
      ];
    })
    .sort((left, right) =>
      String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")),
    );
}

export function parseLoadedBeziHistory(
  result: Record<string, unknown> | null,
): BeziChatEntry[] {
  const history =
    (Array.isArray(result?.messages) && result.messages) ||
    (Array.isArray(result?.history) && result.history) ||
    [];
  return history
    .map(asRecord)
    .filter((value): value is Record<string, unknown> => value !== null)
    .flatMap((value, index): BeziChatEntry[] => {
      const role = stringValue(value.role);
      const text = extractText(value.content) ?? stringValue(value.text);
      if (!text || (role !== "user" && role !== "assistant" && role !== "agent")) {
        return [];
      }
      return [
        {
          id: stringValue(value.id) ?? `history-${index}`,
          role: role === "user" ? "user" : "assistant",
          text,
        },
      ];
    });
}

export function reduceBeziSessionUpdate(
  current: BeziChatEntry[],
  update: Record<string, unknown>,
): BeziChatEntry[] {
  const kind =
    stringValue(update.sessionUpdate) ?? stringValue(update.type) ?? "activity";
  const text =
    extractText(update.content) ??
    extractText(update.message) ??
    stringValue(update.text);

  if (kind.includes("message_chunk") && text) {
    const role = kind.startsWith("user") ? "user" : "assistant";
    const messageId = stringValue(update.messageId);
    const streamKey = messageId ? `message:${messageId}` : `stream:${kind}`;
    const last = current.at(-1);
    if (role === "user" && last?.role === "user" && last.text === text) {
      return current.map((entry, index) =>
        index === current.length - 1 ? { ...entry, streamKey } : entry,
      );
    }
    if (last?.role === role && last.streamKey === streamKey) {
      return current.map((entry, index) =>
        index === current.length - 1
          ? { ...entry, text: `${entry.text}${text}` }
          : entry,
      );
    }
    return [
      ...current,
      {
        id: messageId ?? `${kind}-${current.length}`,
        role,
        text,
        streamKey,
      },
    ];
  }

  const normalizedKind = kind.toLowerCase();
  const activityKinds = ["tool", "plan", "thought", "diff", "command"];
  if (!activityKinds.some((value) => normalizedKind.includes(value))) {
    return current;
  }

  if (normalizedKind.includes("thought")) {
    if (!text) return current;
    const thoughtId =
      stringValue(update.thoughtId) ??
      stringValue(update.messageId) ??
      stringValue(update.id);
    const streamKey = thoughtId
      ? `thought:${thoughtId}`
      : `stream:${normalizedKind}`;
    const last = current.at(-1);
    if (
      last?.role === "activity" &&
      last.activityKind === "thought" &&
      last.streamKey === streamKey
    ) {
      return current.map((entry, index) =>
        index === current.length - 1
          ? { ...entry, detail: `${entry.detail ?? ""}${text}` }
          : entry,
      );
    }
    return [
      ...current,
      {
        id: thoughtId ?? `thought-${current.length}`,
        role: "activity",
        text: stringValue(update.title) ?? "Thoughts",
        detail: text,
        streamKey,
        activityKind: "thought",
        status: stringValue(update.status) ?? undefined,
      },
    ];
  }

  const content = asRecord(update.content);
  const toolKind = stringValue(update.kind)?.toLowerCase();
  const files = parseDiffFiles(update.content);
  const title =
    stringValue(update.title) ??
    stringValue(content?.title) ??
    readableKind(kind);
  const status = stringValue(update.status);
  const contentDetail = extractNonDiffText(update.content);
  const detail = contentDetail ?? (files.length === 0 ? text ?? undefined : undefined);
  const activityId =
    stringValue(update.toolCallId) ??
    stringValue(update.id) ??
    `${kind}-${current.length}`;
  const existing = current.findIndex((entry) => entry.id === activityId);
  const activityKind =
    toolKind === "think"
      ? "thought"
      : files.length > 0 || toolKind === "edit"
        ? "code"
        : normalizedKind.includes("plan")
          ? "plan"
          : normalizedKind.includes("command")
            ? "command"
            : "tool";
  const entry: BeziChatEntry = {
    id: activityId,
    role: "activity",
    text: title,
    detail,
    activityKind,
    toolKind,
    status: status ?? undefined,
    files: files.length > 0 ? files : undefined,
  };
  if (existing < 0) return [...current, entry];
  return current.map((value, index) =>
    index === existing
      ? {
          ...value,
          ...entry,
          detail: entry.detail ?? value.detail,
          files: entry.files ?? value.files,
          activityKind: entry.activityKind ?? value.activityKind,
          toolKind: entry.toolKind ?? value.toolKind,
          status: entry.status ?? value.status,
        }
      : value,
  );
}

export function resolveBeziHistoryReconciliation(
  embedded: BeziChatEntry[],
  replayed: BeziChatEntry[],
  clearOnEmpty: boolean,
): BeziChatEntry[] | null {
  if (embedded.length > 0) return embedded;
  if (replayed.length > 0) return replayed;
  return clearOnEmpty ? [] : null;
}

export function decideBeziHistorySync(input: {
  previousRevision: string | null;
  nextRevision: string | null;
  pendingRevision: string | null;
  lastLiveEventAt: number;
  now: number;
  quietWindowMs?: number;
}): { action: "none" | "wait" | "reconcile"; pendingRevision: string | null } {
  const quietWindowMs = input.quietWindowMs ?? 2_500;
  const revisionChanged =
    input.previousRevision !== null &&
    input.nextRevision !== null &&
    input.previousRevision !== input.nextRevision;
  const receivedLiveUpdate =
    input.lastLiveEventAt > 0 &&
    input.now - input.lastLiveEventAt < quietWindowMs;
  if (revisionChanged && receivedLiveUpdate) {
    return { action: "wait", pendingRevision: input.nextRevision };
  }
  const verificationReady =
    input.pendingRevision !== null &&
    input.pendingRevision === input.nextRevision &&
    !receivedLiveUpdate;
  if ((revisionChanged || verificationReady) && !receivedLiveUpdate) {
    return { action: "reconcile", pendingRevision: null };
  }
  return { action: "none", pendingRevision: input.pendingRevision };
}

export function areBeziHistoriesEqual(
  left: BeziChatEntry[],
  right: BeziChatEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        entry.id === candidate.id &&
        entry.role === candidate.role &&
        entry.text === candidate.text &&
        entry.detail === candidate.detail &&
        entry.activityKind === candidate.activityKind &&
        entry.toolKind === candidate.toolKind &&
        entry.status === candidate.status &&
        JSON.stringify(entry.files ?? []) === JSON.stringify(candidate.files ?? [])
      );
    })
  );
}

export function statusFromBeziUpdate(
  update: Record<string, unknown>,
): BeziAgentStatus | null {
  const kind =
    stringValue(update.sessionUpdate) ?? stringValue(update.type) ?? "";
  const terminalState = [
    kind,
    stringValue(update.status),
    stringValue(update.stopReason),
    stringValue(update.stop_reason),
    stringValue(update.reason),
  ]
    .filter((value): value is string => value !== null)
    .join(" ")
    .toLowerCase();
  if (
    terminalState.includes("cancelled") ||
    terminalState.includes("canceled") ||
    terminalState.includes("cancel")
  ) {
    return {
      label: "Cancelled",
      detail: "Stopped in Bezi",
      active: false,
    };
  }
  if (
    terminalState.includes("interrupted") ||
    terminalState.includes("aborted")
  ) {
    return {
      label: "Stopped",
      detail: "The Bezi turn ended early",
      active: false,
    };
  }
  if (kind === "user_message_chunk") {
    return { label: "Thinking", detail: "New prompt received", active: true };
  }
  if (kind.includes("thought")) {
    return { label: "Thinking", active: true };
  }
  if (kind === "agent_message_chunk") {
    return { label: "Responding", active: true };
  }
  if (kind.includes("plan")) {
    return { label: "Planning", active: true };
  }
  if (kind.includes("tool") || kind.includes("command") || kind.includes("diff")) {
    const title = stringValue(update.title);
    const status = stringValue(update.status)?.toLowerCase();
    if (status?.includes("fail") || status?.includes("error")) {
      return { label: "Tool failed", detail: title ?? undefined, active: false };
    }
    if (
      status?.includes("complete") ||
      status?.includes("success") ||
      status === "done"
    ) {
      return { label: "Finishing work", detail: title ?? undefined, active: false };
    }
    return {
      label: "Working",
      detail: title ?? readableKind(kind),
      active: true,
    };
  }
  return null;
}

export function buildBeziLineDiff(file: BeziDiffFile): BeziDiffLine[] {
  const oldLines = splitLines(file.oldText);
  const newLines = splitLines(file.newText);
  if (oldLines.length === 0) {
    return newLines.map((text, index) => ({
      kind: "added",
      text,
      newNumber: index + 1,
    }));
  }
  if (newLines.length === 0) {
    return oldLines.map((text, index) => ({
      kind: "removed",
      text,
      oldNumber: index + 1,
    }));
  }
  if (oldLines.length * newLines.length > 1_200_000) {
    return buildLargeDiff(oldLines, newLines);
  }

  const width = newLines.length + 1;
  const table = new Uint16Array((oldLines.length + 1) * width);
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const offset = oldIndex * width + newIndex;
      table[offset] =
        oldLines[oldIndex] === newLines[newIndex]
          ? table[(oldIndex + 1) * width + newIndex + 1] + 1
          : Math.max(
              table[(oldIndex + 1) * width + newIndex],
              table[oldIndex * width + newIndex + 1],
            );
    }
  }

  const rows: BeziDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      rows.push({
        kind: "context",
        text: oldLines[oldIndex],
        oldNumber: oldIndex + 1,
        newNumber: newIndex + 1,
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      table[(oldIndex + 1) * width + newIndex] >=
      table[oldIndex * width + newIndex + 1]
    ) {
      rows.push({
        kind: "removed",
        text: oldLines[oldIndex],
        oldNumber: oldIndex + 1,
      });
      oldIndex += 1;
    } else {
      rows.push({
        kind: "added",
        text: newLines[newIndex],
        newNumber: newIndex + 1,
      });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    rows.push({
      kind: "removed",
      text: oldLines[oldIndex],
      oldNumber: oldIndex + 1,
    });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    rows.push({
      kind: "added",
      text: newLines[newIndex],
      newNumber: newIndex + 1,
    });
    newIndex += 1;
  }
  return rows;
}

function parseDiffFiles(value: unknown): BeziDiffFile[] {
  const files: BeziDiffFile[] = [];
  collectDiffFiles(value, files);
  return files;
}

function collectDiffFiles(value: unknown, files: BeziDiffFile[]) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectDiffFiles(entry, files));
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  const path = stringValue(record.path);
  if (path && (typeof record.oldText === "string" || typeof record.newText === "string")) {
    const oldText = typeof record.oldText === "string" ? record.oldText : "";
    const newText = typeof record.newText === "string" ? record.newText : "";
    const counts = countChangedLines(oldText, newText);
    files.push({
      path,
      oldText,
      newText,
      additions: counts.additions,
      deletions: counts.deletions,
    });
    return;
  }
  if (record.content !== undefined) collectDiffFiles(record.content, files);
}

function countChangedLines(oldText: string, newText: string) {
  const oldCounts = new Map<string, number>();
  splitLines(oldText).forEach((line) =>
    oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1),
  );
  let additions = 0;
  splitLines(newText).forEach((line) => {
    const count = oldCounts.get(line) ?? 0;
    if (count > 0) oldCounts.set(line, count - 1);
    else additions += 1;
  });
  const deletions = [...oldCounts.values()].reduce((sum, count) => sum + count, 0);
  return { additions, deletions };
}

function extractNonDiffText(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (Array.isArray(value)) {
    return value.map(extractNonDiffText).filter(Boolean).join("\n") || null;
  }
  const record = asRecord(value);
  if (!record) return null;
  if (
    stringValue(record.path) &&
    (record.newText !== undefined || record.oldText !== undefined)
  ) {
    return null;
  }
  if (typeof record.text === "string" && record.text) return record.text;
  if (record.content !== undefined) return extractNonDiffText(record.content);
  return null;
}

function buildLargeDiff(oldLines: string[], newLines: string[]): BeziDiffLine[] {
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] ===
      newLines[newLines.length - suffix - 1]
  ) {
    suffix += 1;
  }
  const rows: BeziDiffLine[] = [];
  for (let index = 0; index < prefix; index += 1) {
    rows.push({
      kind: "context",
      text: oldLines[index],
      oldNumber: index + 1,
      newNumber: index + 1,
    });
  }
  for (let index = prefix; index < oldLines.length - suffix; index += 1) {
    rows.push({ kind: "removed", text: oldLines[index], oldNumber: index + 1 });
  }
  for (let index = prefix; index < newLines.length - suffix; index += 1) {
    rows.push({ kind: "added", text: newLines[index], newNumber: index + 1 });
  }
  for (let offset = suffix; offset > 0; offset -= 1) {
    const oldIndex = oldLines.length - offset;
    const newIndex = newLines.length - offset;
    rows.push({
      kind: "context",
      text: oldLines[oldIndex],
      oldNumber: oldIndex + 1,
      newNumber: newIndex + 1,
    });
  }
  return rows;
}

function splitLines(value: string) {
  if (!value) return [];
  return value.replace(/\r\n/g, "\n").split("\n");
}

function readableKind(value: string) {
  const words = value.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function extractText(value: unknown): string | null {
  if (typeof value === "string" && value) return value;
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join("\n") || null;
  }
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.text === "string" && record.text) return record.text;
  if (record.type === "content" && record.content !== undefined) {
    return extractText(record.content);
  }
  if (Array.isArray(record.content)) return extractText(record.content);
  const path = stringValue(record.path);
  if (path && (record.newText !== undefined || record.oldText !== undefined)) {
    return `Changed ${path}`;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
