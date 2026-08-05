export type ContextPinSource = "bezi" | "unity";

export type ContextPin = {
  id: string;
  source: ContextPinSource;
  kind: string;
  name: string;
  detail: string;
  uri: string;
  mimeType?: string;
  pageId?: string;
  content?: string;
};

export type ContextPinMention = {
  start: number;
  end: number;
  query: string;
};

export type UnityContextInstance = {
  instanceId: string;
  projectName: string;
  projectPath: string;
};

type PageLike = { id: string; title: string; kind: string };

export function findContextPinMention(
  text: string,
  caret: number,
  selectedPins: readonly ContextPin[],
): ContextPinMention | null {
  const end = Math.max(0, Math.min(text.length, caret));
  const start = text.slice(0, end).lastIndexOf("@");
  if (start < 0) return null;
  const previous = start > 0 ? text[start - 1] : "";
  if (previous && !/[\s([{]/.test(previous)) return null;
  const query = text.slice(start + 1, end);
  if (/[\r\n\[\]{}()]/.test(query) || query.length > 80) return null;
  if (
    selectedPins.some(
      (pin) => query.startsWith(`${pin.name} `),
    )
  ) {
    return null;
  }
  return { start, end, query };
}

export function applyContextPinMention(
  text: string,
  mention: ContextPinMention,
  pin: ContextPin,
) {
  const insertion = `@${pin.name} `;
  const suffixStart = text[mention.end] === " " ? mention.end + 1 : mention.end;
  return {
    text: `${text.slice(0, mention.start)}${insertion}${text.slice(suffixStart)}`,
    caret: mention.start + insertion.length,
  };
}

export function removeContextPinMention(text: string, pin: ContextPin) {
  const token = `@${pin.name}`;
  const start = text.indexOf(token);
  if (start < 0) return { text, caret: text.length };
  const end = text[start + token.length] === " "
    ? start + token.length + 1
    : start + token.length;
  return {
    text: `${text.slice(0, start)}${text.slice(end)}`,
    caret: start,
  };
}

export function buildContextPinOptions({
  workspaceId,
  pages,
  hierarchy,
  assets,
}: {
  workspaceId: string | null;
  pages: readonly PageLike[];
  hierarchy: readonly ContextPin[];
  assets: readonly ContextPin[];
}) {
  const pagePins: ContextPin[] = pages
    .filter((page) => page.kind === "page")
    .map((page) => ({
      id: `bezi:page:${page.id}`,
      source: "bezi",
      kind: "Page",
      name: page.title,
      detail: "Bezi Page",
      uri: `bezi://workspace/${encodeURIComponent(workspaceId ?? "active")}/page/${encodeURIComponent(page.id)}`,
      pageId: page.id,
    }));
  return uniquePins([...pagePins, ...hierarchy, ...assets]);
}

export function filterContextPinOptions(
  options: readonly ContextPin[],
  query: string,
  limit = 12,
) {
  const needle = query.trim().toLowerCase();
  return options
    .map((pin, index) => ({ pin, index, score: pinScore(pin, needle) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.pin);
}

export function parseUnityHierarchyContext(
  value: unknown,
  projectPath: string,
): ContextPin[] {
  const record = asRecord(value);
  if (!Array.isArray(record?.nodes)) return [];
  return record.nodes.flatMap((entry): ContextPin[] => {
    const node = asRecord(entry);
    const id = stringValue(node?.id);
    const name = stringValue(node?.name);
    const scene = stringValue(node?.scene);
    if (!id || !name || !scene) return [];
    const sceneUri = projectFileUri(projectPath, scene);
    return [{
      id: `unity:object:${id}`,
      source: "unity",
      kind: "GameObject",
      name,
      detail: scene,
      uri: `${sceneUri}#${encodeURIComponent(id)}`,
      mimeType: "application/x-yaml",
    }];
  });
}

export function parseUnityContextInstances(value: unknown): UnityContextInstance[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): UnityContextInstance[] => {
    const instance = asRecord(entry);
    const instanceId = stringValue(instance?.instanceId);
    const projectName = stringValue(instance?.projectName);
    const projectPath = stringValue(instance?.projectPath);
    if (!instanceId || !projectName || !projectPath) return [];
    return [{ instanceId, projectName, projectPath }];
  });
}

export function selectUnityContextInstance(
  instances: readonly UnityContextInstance[],
  selectedProjectPath: string | null | undefined,
) {
  const selected = normalizePath(selectedProjectPath ?? "");
  return instances.find((instance) => normalizePath(instance.projectPath) === selected)
    ?? instances[0]
    ?? null;
}

export function parseUnityAssetContext(
  value: unknown,
  projectPath: string,
): ContextPin[] {
  const record = asRecord(value);
  if (!Array.isArray(record?.assets)) return [];
  return record.assets.flatMap((entry): ContextPin[] => {
    const asset = asRecord(entry);
    const id = stringValue(asset?.id);
    const name = stringValue(asset?.name);
    const path = stringValue(asset?.path);
    if (!id || !name || !path) return [];
    const typeName = stringValue(asset?.typeName) ?? "Asset";
    return [{
      id: `unity:asset:${id}`,
      source: "unity",
      kind: unityAssetKind(path, typeName),
      name,
      detail: path,
      uri: projectFileUri(projectPath, path),
      mimeType: unityAssetMimeType(path),
    }];
  });
}

export function buildContextPinAttachments(pins: readonly ContextPin[]) {
  return pins.map((pin) => pin.content !== undefined
    ? {
        type: "resource" as const,
        resource: {
          uri: pin.uri,
          mimeType: pin.mimeType ?? "text/markdown",
          text: pin.content,
        },
      }
    : {
        type: "resource_link" as const,
        uri: pin.uri,
        name: pin.name,
        title: pin.name,
        description: contextPinDescription(pin),
        ...(pin.mimeType ? { mimeType: pin.mimeType } : {}),
      });
}

function contextPinDescription(pin: ContextPin) {
  const label = `${pin.source === "bezi" ? "Bezi" : "Unity"} ${pin.kind}`;
  return pin.detail && pin.detail !== label ? `${label} - ${pin.detail}` : label;
}

export function contextPinToken(pin: ContextPin) {
  return `@${pin.name}`;
}

export function hasContextPinToken(text: string, pin: ContextPin) {
  const token = contextPinToken(pin);
  let start = text.indexOf(token);
  while (start >= 0) {
    const previous = start > 0 ? text[start - 1] : "";
    const next = text[start + token.length] ?? "";
    if ((!previous || /[\s([{]/.test(previous)) && (!next || /[\s.,!?;:)\]}]/.test(next))) {
      return true;
    }
    start = text.indexOf(token, start + token.length);
  }
  return false;
}

function uniquePins(pins: ContextPin[]) {
  const seen = new Set<string>();
  return pins.filter((pin) => {
    if (!pin.name || seen.has(pin.id)) return false;
    seen.add(pin.id);
    return true;
  });
}

function pinScore(pin: ContextPin, query: string) {
  if (!query) return pin.source === "unity" ? 1 : 2;
  const name = pin.name.toLowerCase();
  const detail = pin.detail.toLowerCase();
  const kind = pin.kind.toLowerCase();
  const compactName = name.replace(/[^a-z0-9]+/g, "");
  const compactQuery = query.replace(/[^a-z0-9]+/g, "");
  if (name === query) return 0;
  if (name.startsWith(`${query} `)) return 1;
  if (name.startsWith(query) || compactName.startsWith(compactQuery)) return 2;
  if (name.includes(query)) return 3;
  if (kind.includes(query)) return 4;
  if (detail.includes(query)) return 5;
  const terms = query.split(/\s+/).filter(Boolean);
  return terms.length > 1 && terms.every((term) => `${name} ${kind} ${detail}`.includes(term))
    ? 6
    : Number.POSITIVE_INFINITY;
}

function projectFileUri(projectPath: string, assetPath: string) {
  const normalizedAsset = assetPath.replaceAll("\\", "/");
  const absolute = /^[a-zA-Z]:\//.test(normalizedAsset) || normalizedAsset.startsWith("/")
    ? normalizedAsset
    : `${projectPath.replaceAll("\\", "/").replace(/\/$/, "")}/${normalizedAsset.replace(/^\//, "")}`;
  const prefix = /^[a-zA-Z]:\//.test(absolute) ? "file:///" : "file://";
  return encodeURI(`${prefix}${absolute}`).replaceAll("#", "%23");
}

function normalizePath(value: string) {
  return value.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
}

function unityAssetKind(path: string, typeName: string) {
  const extension = path.split(".").at(-1)?.toLowerCase();
  const byExtension: Record<string, string> = {
    cs: "Script",
    prefab: "Prefab",
    unity: "Scene",
    mat: "Material",
    shader: "Shader",
    controller: "Animator",
    anim: "Animation",
    asset: "ScriptableObject",
    fbx: "Model",
    obj: "Model",
    png: "Texture",
    jpg: "Texture",
    jpeg: "Texture",
    wav: "Audio",
    mp3: "Audio",
  };
  return (extension && byExtension[extension]) || typeName.split(".").at(-1) || "Asset";
}

function unityAssetMimeType(path: string) {
  const extension = path.split(".").at(-1)?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    cs: "text/x-csharp",
    shader: "text/plain",
    unity: "application/x-yaml",
    prefab: "application/x-yaml",
    mat: "application/x-yaml",
    asset: "application/x-yaml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
  };
  return extension ? mimeTypes[extension] : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
