export type WorkspaceItemKind = "page" | "folder" | "canvas";

export type WorkspaceItem = {
  id: string;
  title: string;
  kind: WorkspaceItemKind;
  depth: number;
  expanded: boolean;
  remote: boolean;
};

export function parseWorkspaceItems(value: unknown): WorkspaceItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null)
    .flatMap((item): WorkspaceItem[] => {
      const id = stringValue(item.id);
      const title = stringValue(item.title);
      if (!id || !title) return [];
      const kind = workspaceItemKind(item.kind);
      const depth =
        typeof item.depth === "number" &&
        Number.isInteger(item.depth) &&
        item.depth >= 0
          ? item.depth
          : 0;
      return [
        {
          id,
          title,
          kind,
          depth,
          expanded: kind === "folder" && item.expanded === true,
          remote: item.remote !== false,
        },
      ];
    });
}

export function applyWorkspaceFolderState(
  items: WorkspaceItem[],
  overrides: Readonly<Record<string, boolean>>,
): WorkspaceItem[] {
  const collapsedDepths: number[] = [];
  const visible: WorkspaceItem[] = [];

  for (const item of items) {
    while (
      collapsedDepths.length > 0 &&
      collapsedDepths[collapsedDepths.length - 1] >= item.depth
    ) {
      collapsedDepths.pop();
    }
    if (collapsedDepths.length > 0) continue;

    const expanded =
      item.kind === "folder"
        ? overrides[item.id] ?? item.expanded
        : item.expanded;
    visible.push(expanded === item.expanded ? item : { ...item, expanded });
    if (item.kind === "folder" && !expanded) {
      collapsedDepths.push(item.depth);
    }
  }

  return visible;
}

export function toggleWorkspaceFolderOverride(
  item: WorkspaceItem,
  overrides: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  if (item.kind !== "folder") return { ...overrides };
  return {
    ...overrides,
    [item.id]: !item.expanded,
  };
}

export function workspaceAncestorIds(
  items: WorkspaceItem[],
  itemId: string,
): string[] {
  const ancestors: WorkspaceItem[] = [];
  for (const item of items) {
    while (
      ancestors.length > 0 &&
      ancestors[ancestors.length - 1].depth >= item.depth
    ) {
      ancestors.pop();
    }
    if (item.id === itemId) {
      return ancestors
        .filter((ancestor) => ancestor.kind === "folder")
        .map((ancestor) => ancestor.id);
    }
    if (item.kind === "folder") {
      ancestors.push(item);
    }
  }
  return [];
}

function workspaceItemKind(value: unknown): WorkspaceItemKind {
  return value === "folder" || value === "canvas" ? value : "page";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
