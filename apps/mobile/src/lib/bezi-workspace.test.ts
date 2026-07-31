import { describe, expect, it } from "vitest";
import {
  applyWorkspaceFolderState,
  parseWorkspaceItems,
  toggleWorkspaceFolderOverride,
  workspaceAncestorIds,
} from "./bezi-workspace";

describe("Bezi workspace items", () => {
  it("preserves folder hierarchy and expansion state", () => {
    expect(
      parseWorkspaceItems([
        {
          id: "folder-1",
          title: "Design docs",
          kind: "folder",
          depth: 0,
          expanded: true,
        },
        {
          id: "page-1",
          title: "Movement",
          kind: "page",
          depth: 1,
        },
      ]),
    ).toEqual([
      {
        id: "folder-1",
        title: "Design docs",
        kind: "folder",
        depth: 0,
        expanded: true,
        remote: true,
      },
      {
        id: "page-1",
        title: "Movement",
        kind: "page",
        depth: 1,
        expanded: false,
        remote: true,
      },
    ]);
  });

  it("keeps legacy flat catalog items as pages", () => {
    expect(parseWorkspaceItems([{ id: "page-1", title: "Overview" }])).toEqual([
      {
        id: "page-1",
        title: "Overview",
        kind: "page",
        depth: 0,
        expanded: false,
        remote: true,
      },
    ]);
  });

  it("rejects malformed entries and unsafe nesting depths", () => {
    expect(
      parseWorkspaceItems([
        { id: "missing-title" },
        { id: "page-1", title: "Overview", depth: -2 },
      ]),
    ).toEqual([
      {
        id: "page-1",
        title: "Overview",
        kind: "page",
        depth: 0,
        expanded: false,
        remote: true,
      },
    ]);
  });

  it("opens cached folders locally and hides their descendants when collapsed", () => {
    const items = parseWorkspaceItems([
      {
        id: "folder-1",
        title: "Design docs",
        kind: "folder",
        depth: 0,
        expanded: false,
        remote: false,
      },
      {
        id: "page-1",
        title: "Movement",
        kind: "page",
        depth: 1,
        remote: false,
      },
      {
        id: "page-2",
        title: "Overview",
        kind: "page",
        depth: 0,
        remote: false,
      },
    ]);

    expect(applyWorkspaceFolderState(items, {}).map((item) => item.id)).toEqual([
      "folder-1",
      "page-2",
    ]);
    expect(
      applyWorkspaceFolderState(items, { "folder-1": true }).map((item) => [
        item.id,
        item.expanded,
      ]),
    ).toEqual([
      ["folder-1", true],
      ["page-1", false],
      ["page-2", false],
    ]);
  });

  it("expands and collapses remote folders locally without waiting for desktop", () => {
    const items = parseWorkspaceItems([
      {
        id: "folder-1",
        title: "Design docs",
        kind: "folder",
        depth: 0,
        expanded: false,
        remote: true,
      },
      {
        id: "page-1",
        title: "Movement",
        kind: "page",
        depth: 1,
        remote: true,
      },
    ]);
    const expandedOverrides = toggleWorkspaceFolderOverride(items[0], {});
    const expandedItems = applyWorkspaceFolderState(items, expandedOverrides);

    expect(expandedItems.map((item) => item.id)).toEqual([
      "folder-1",
      "page-1",
    ]);
    expect(expandedItems[0].expanded).toBe(true);

    const collapsedOverrides = toggleWorkspaceFolderOverride(
      expandedItems[0],
      expandedOverrides,
    );
    expect(
      applyWorkspaceFolderState(items, collapsedOverrides).map(
        (item) => item.id,
      ),
    ).toEqual(["folder-1"]);
  });

  it("finds the containing folders for a cached page", () => {
    const items = parseWorkspaceItems([
      { id: "root", title: "Root", kind: "folder", depth: 0 },
      { id: "child", title: "Child", kind: "folder", depth: 1 },
      { id: "page", title: "Page", kind: "page", depth: 2 },
      { id: "other", title: "Other", kind: "page", depth: 0 },
    ]);

    expect(workspaceAncestorIds(items, "page")).toEqual(["root", "child"]);
    expect(workspaceAncestorIds(items, "other")).toEqual([]);
  });
});
