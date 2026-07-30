export type BeziMarkdownInline =
  | { type: "text"; value: string }
  | { type: "strong"; value: string }
  | { type: "emphasis"; value: string }
  | { type: "strikethrough"; value: string }
  | { type: "code"; value: string }
  | { type: "link"; value: string; href: string }
  | { type: "reference"; value: string; referenceId?: string };

export type BeziMarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "code"; language?: string; text: string }
  | {
      type: "list-item";
      depth: number;
      ordered: boolean;
      ordinal?: number;
      text: string;
    }
  | { type: "quote"; text: string }
  | { type: "divider" };

const BLOCK_START =
  /^(?:\s*```|\s{0,3}#{1,6}\s+|\s{0,3}>\s?|\s*(?:[-+*]|\d+[.)])\s+)/;
const DIVIDER = /^\s{0,3}(?:([-*_])\s*){3,}$/;
const ATTRIBUTE = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function isBlockStart(line: string) {
  return BLOCK_START.test(line) || DIVIDER.test(line);
}

function listDepth(indent: string) {
  const width = indent.replace(/\t/g, "    ").length;
  return Math.max(0, Math.floor(width / 2));
}

/**
 * Parses the intentionally small Markdown subset emitted by Bezi threads.
 * Keeping this independent from React Native makes the protocol output easy to
 * test and keeps the Expo Go proof free from a native Markdown dependency.
 */
export function parseBeziMarkdownBlocks(input: string): BeziMarkdownBlock[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: BeziMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const language = fence[1]?.trim() || undefined;
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language, text: code.join("\n") });
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        text: heading[2],
      });
      index += 1;
      continue;
    }

    if (DIVIDER.test(line)) {
      blocks.push({ type: "divider" });
      index += 1;
      continue;
    }

    const list = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
    if (list) {
      const ordered = /^\d/.test(list[2]);
      blocks.push({
        type: "list-item",
        depth: listDepth(list[1]),
        ordered,
        ordinal: ordered ? Number.parseInt(list[2], 10) : undefined,
        text: list[3].trim(),
      });
      index += 1;
      continue;
    }

    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      const quoteLines = [quote[1]];
      index += 1;
      while (index < lines.length) {
        const next = lines[index].match(/^\s{0,3}>\s?(.*)$/);
        if (!next) break;
        quoteLines.push(next[1]);
        index += 1;
      }
      blocks.push({ type: "quote", text: quoteLines.join("\n") });
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isBlockStart(lines[index])
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
}

function parseReference(source: string) {
  if (!source.startsWith("[@")) return null;
  const end = source.indexOf("]");
  if (end < 0) return null;

  const attributes = source.slice(2, end);
  const values: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  for (const match of attributes.matchAll(ATTRIBUTE)) {
    values[match[1]] = match[2] ?? match[3] ?? "";
  }

  const value = values.label || values.name || values.title;
  if (!value) return null;
  return {
    length: end + 1,
    token: {
      type: "reference" as const,
      value,
      referenceId: values.id,
    },
  };
}

function parseInlineAt(source: string) {
  const reference = parseReference(source);
  if (reference) return reference;

  const patterns: {
    pattern: RegExp;
    token: (match: RegExpMatchArray) => BeziMarkdownInline;
  }[] = [
    {
      pattern: /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
      token: (match) => ({
        type: "link",
        value: match[1] || "Image",
        href: match[2],
      }),
    },
    {
      pattern: /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/,
      token: (match) => ({
        type: "link",
        value: match[1],
        href: match[2],
      }),
    },
    {
      pattern: /^(`+)([\s\S]*?)\1(?!`)/,
      token: (match) => ({ type: "code", value: match[2] }),
    },
    {
      pattern: /^\*\*(.+?)\*\*/,
      token: (match) => ({ type: "strong", value: match[1] }),
    },
    {
      pattern: /^__(.+?)__/,
      token: (match) => ({ type: "strong", value: match[1] }),
    },
    {
      pattern: /^~~(.+?)~~/,
      token: (match) => ({ type: "strikethrough", value: match[1] }),
    },
    {
      pattern: /^\*([^*\n]+?)\*/,
      token: (match) => ({ type: "emphasis", value: match[1] }),
    },
    {
      pattern: /^_([^_\n]+?)_/,
      token: (match) => ({ type: "emphasis", value: match[1] }),
    },
  ];

  for (const candidate of patterns) {
    const match = source.match(candidate.pattern);
    if (match) {
      return { length: match[0].length, token: candidate.token(match) };
    }
  }
  return null;
}

export function parseBeziMarkdownInline(input: string): BeziMarkdownInline[] {
  const tokens: BeziMarkdownInline[] = [];
  let plain = "";
  let index = 0;

  const flushPlain = () => {
    if (!plain) return;
    tokens.push({ type: "text", value: plain });
    plain = "";
  };

  while (index < input.length) {
    if (input[index] === "\\" && index + 1 < input.length) {
      plain += input[index + 1];
      index += 2;
      continue;
    }

    const parsed = parseInlineAt(input.slice(index));
    if (!parsed) {
      plain += input[index];
      index += 1;
      continue;
    }

    flushPlain();
    tokens.push(parsed.token);
    index += parsed.length;
  }

  flushPlain();
  return tokens;
}
