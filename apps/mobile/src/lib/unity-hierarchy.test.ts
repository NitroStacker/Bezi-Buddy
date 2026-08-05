import { describe, expect, it } from "vitest";
import { visibleUnityHierarchy } from "./unity-hierarchy";

const nodes = [
  { id: "root", name: "Arena", scene: "TestArena" },
  { id: "child", parentId: "root", name: "Canvas", scene: "TestArena" },
  { id: "grandchild", parentId: "child", name: "Score Text", scene: "TestArena" },
  { id: "second", name: "Lighting", scene: "TestArena" },
];

describe("visibleUnityHierarchy", () => {
  it("starts fully collapsed with only scene roots visible", () => {
    expect(visibleUnityHierarchy(nodes, new Set(), "").map((node) => node.id)).toEqual([
      "root",
      "second",
    ]);
  });

  it("preserves exactly the branches the user expanded", () => {
    expect(
      visibleUnityHierarchy(nodes, new Set(["root", "child"]), "").map((node) => node.id),
    ).toEqual(["root", "child", "grandchild", "second"]);
    expect(visibleUnityHierarchy(nodes, new Set(["root"]), "").map((node) => node.id)).toEqual([
      "root",
      "child",
      "second",
    ]);
  });

  it("shows search matches with their ancestors without changing expansion state", () => {
    const expanded = new Set<string>();
    expect(visibleUnityHierarchy(nodes, expanded, "score").map((node) => node.id)).toEqual([
      "root",
      "child",
      "grandchild",
    ]);
    expect(expanded.size).toBe(0);
  });
});
