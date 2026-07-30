import { describe, expect, it } from "vitest";
import {
  parseBeziMarkdownBlocks,
  parseBeziMarkdownInline,
} from "./bezi-markdown";

describe("Bezi Markdown", () => {
  it("turns headings, lists, quotes, and fenced code into semantic blocks", () => {
    expect(
      parseBeziMarkdownBlocks(
        [
          "## Implemented",
          "",
          "- First change",
          "  - Nested change",
          "1. Verify it",
          "",
          "> Keep this safe.",
          "",
          "```csharp",
          "var speed = 0.2f;",
          "```",
        ].join("\n"),
      ),
    ).toEqual([
      { type: "heading", level: 2, text: "Implemented" },
      {
        type: "list-item",
        depth: 0,
        ordered: false,
        ordinal: undefined,
        text: "First change",
      },
      {
        type: "list-item",
        depth: 1,
        ordered: false,
        ordinal: undefined,
        text: "Nested change",
      },
      {
        type: "list-item",
        depth: 0,
        ordered: true,
        ordinal: 1,
        text: "Verify it",
      },
      { type: "quote", text: "Keep this safe." },
      { type: "code", language: "csharp", text: "var speed = 0.2f;" },
    ]);
  });

  it("formats emphasis, inline code, links, and Bezi references", () => {
    expect(
      parseBeziMarkdownInline(
        '**Bold** and *soft* with `0.2x`, [docs](https://example.com), and [@ id="node:123" label="Kicking"].',
      ),
    ).toEqual([
      { type: "strong", value: "Bold" },
      { type: "text", value: " and " },
      { type: "emphasis", value: "soft" },
      { type: "text", value: " with " },
      { type: "code", value: "0.2x" },
      { type: "text", value: ", " },
      { type: "link", value: "docs", href: "https://example.com" },
      { type: "text", value: ", and " },
      {
        type: "reference",
        value: "Kicking",
        referenceId: "node:123",
      },
      { type: "text", value: "." },
    ]);
  });

  it("leaves unmatched Markdown characters visible", () => {
    expect(parseBeziMarkdownInline("A *literal marker and `open code")).toEqual([
      { type: "text", value: "A *literal marker and `open code" },
    ]);
  });
});
