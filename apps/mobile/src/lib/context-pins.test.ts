import { describe, expect, it } from "vitest";
import {
  applyContextPinMention,
  buildContextPinAttachments,
  buildContextPinOptions,
  filterContextPinOptions,
  findContextPinMention,
  hasContextPinToken,
  parseUnityAssetContext,
  parseUnityHierarchyContext,
  type ContextPin,
} from "./context-pins";

const pagePin: ContextPin = {
  id: "bezi:page:page-1",
  source: "bezi",
  kind: "Page",
  name: "Combat Design",
  detail: "Bezi Page",
  uri: "bezi://workspace/workspace-1/page/page-1",
};

describe("context pins", () => {
  it("opens a mention immediately after @ and keeps multi-word search text", () => {
    expect(findContextPinMention("Fix @", 5, [])).toEqual({
      start: 4,
      end: 5,
      query: "",
    });
    expect(findContextPinMention("Use @Player Controller", 22, [])).toEqual({
      start: 4,
      end: 22,
      query: "Player Controller",
    });
    expect(findContextPinMention("mail@test.com", 13, [])).toBeNull();
    expect(
      findContextPinMention("Use @Combat Design ", 19, [pagePin]),
    ).toBeNull();
  });

  it("combines Bezi pages with Unity hierarchy objects and project assets", () => {
    const hierarchy = parseUnityHierarchyContext(
      {
        nodes: [
          {
            id: "GlobalObjectId_V1-1-2-3-4",
            name: "Player Root",
            scene: "Assets/Scenes/Arena.unity",
            depth: 0,
          },
        ],
      },
      "R:\\Games\\Arena",
    );
    const assets = parseUnityAssetContext(
      {
        assets: [
          {
            id: "GlobalObjectId_V1-1-5-6-7",
            name: "PlayerController",
            typeName: "UnityEditor.MonoScript",
            path: "Assets/Scripts/PlayerController.cs",
          },
        ],
      },
      "R:\\Games\\Arena",
    );
    const options = buildContextPinOptions({
      workspaceId: "workspace-1",
      pages: [{ id: "page-1", title: "Combat Design", kind: "page" }],
      hierarchy,
      assets,
    });

    expect(options.map((option) => option.kind)).toEqual([
      "Page",
      "GameObject",
      "Script",
    ]);
    expect(options[1].uri).toContain("Arena.unity#GlobalObjectId_V1-1-2-3-4");
    expect(options[2].uri).toBe(
      "file:///R:/Games/Arena/Assets/Scripts/PlayerController.cs",
    );
  });

  it("ranks exact and prefix name matches above path matches", () => {
    const options: ContextPin[] = [
      pagePin,
      {
        id: "unity:object:1",
        source: "unity",
        kind: "GameObject",
        name: "Player",
        detail: "Arena.unity",
        uri: "file:///Arena.unity#1",
      },
      {
        id: "unity:asset:1",
        source: "unity",
        kind: "Material",
        name: "Hero",
        detail: "Assets/Player/Hero.mat",
        uri: "file:///Hero.mat",
      },
    ];

    expect(filterContextPinOptions(options, "player").map((pin) => pin.name)).toEqual([
      "Player",
      "Hero",
    ]);
  });

  it("inserts the selected mention and emits ACP resource links", () => {
    const result = applyContextPinMention("Use @comb for this", {
      start: 4,
      end: 9,
      query: "comb",
    }, pagePin);
    expect(result).toEqual({
      text: "Use @Combat Design for this",
      caret: 19,
    });
    expect(buildContextPinAttachments([pagePin])).toEqual([
      {
        type: "resource_link",
        uri: "bezi://workspace/workspace-1/page/page-1",
        name: "Combat Design",
        title: "Combat Design",
        description: "Bezi Page",
      },
    ]);
  });

  it("embeds fetched Bezi page content in the ACP prompt", () => {
    expect(buildContextPinAttachments([{
      ...pagePin,
      content: "# Combat Design\n\nKeep encounters readable.",
    }])).toEqual([{
      type: "resource",
      resource: {
        uri: "bezi://workspace/workspace-1/page/page-1",
        mimeType: "text/markdown",
        text: "# Combat Design\n\nKeep encounters readable.",
      },
    }]);
  });

  it("only keeps pins while their complete mention token remains", () => {
    expect(hasContextPinToken("Review @Combat Design next", pagePin)).toBe(true);
    expect(hasContextPinToken("Review @Combat Designer next", pagePin)).toBe(false);
  });
});
