import { Fragment, type ReactNode, useMemo } from "react";
import {
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  type TextStyle,
  View,
} from "react-native";
import {
  parseBeziMarkdownBlocks,
  parseBeziMarkdownInline,
  type BeziMarkdownBlock,
  type BeziMarkdownInline,
} from "@/lib/bezi-markdown";
import { colors, radius, spacing, typography } from "@/theme/tokens";

type BeziMarkdownProps = {
  children: string;
  compact?: boolean;
  secondary?: boolean;
};

function isSafeLink(value: string) {
  return /^(?:https?:\/\/|mailto:)/i.test(value);
}

function openLink(href: string) {
  if (!isSafeLink(href)) return;
  void Linking.openURL(href);
}

function inlineStyle(
  token: BeziMarkdownInline,
  secondary: boolean,
): TextStyle | undefined {
  switch (token.type) {
    case "strong":
      return styles.strong;
    case "emphasis":
      return styles.emphasis;
    case "strikethrough":
      return styles.strikethrough;
    case "code":
      return styles.inlineCode;
    case "link":
      return styles.link;
    case "reference":
      return styles.reference;
    default:
      return secondary ? styles.secondaryText : undefined;
  }
}

function renderInline(text: string, secondary: boolean): ReactNode {
  return parseBeziMarkdownInline(text).map((token, index) => {
    const key = `${token.type}-${index}`;
    if (token.type === "link") {
      return (
        <Text
          accessibilityHint={
            isSafeLink(token.href) ? "Opens this link" : "Link is unavailable"
          }
          accessibilityRole="link"
          key={key}
          onPress={() => openLink(token.href)}
          style={inlineStyle(token, secondary)}
        >
          {token.value}
        </Text>
      );
    }
    if (token.type === "reference") {
      return (
        <Text
          accessibilityLabel={`Bezi reference: ${token.value}`}
          key={key}
          style={inlineStyle(token, secondary)}
        >
          {"\u00A0"}
          {token.value}
          {"\u00A0"}
        </Text>
      );
    }
    return (
      <Text key={key} style={inlineStyle(token, secondary)}>
        {token.value}
      </Text>
    );
  });
}

function blockSpacing(
  block: BeziMarkdownBlock,
  previous: BeziMarkdownBlock | undefined,
  isLast: boolean,
) {
  if (isLast) return undefined;
  if (block.type === "list-item") return styles.listSpacing;
  if (previous?.type === "list-item") {
    return styles.blockSpacingAfterList;
  }
  return styles.blockSpacing;
}

export function BeziMarkdown({
  children,
  compact = false,
  secondary = false,
}: BeziMarkdownProps) {
  const blocks = useMemo(() => parseBeziMarkdownBlocks(children), [children]);
  const baseText = [
    styles.body,
    compact && styles.compactBody,
    secondary && styles.secondaryText,
  ];

  return (
    <View style={styles.root}>
      {blocks.map((block, index) => {
        const spacingStyle = blockSpacing(
          block,
          blocks[index - 1],
          index === blocks.length - 1,
        );
        const key = `${block.type}-${index}`;

        if (block.type === "heading") {
          return (
            <Text
              accessibilityRole="header"
              key={key}
              selectable
              style={[
                styles.heading,
                block.level === 1 && styles.headingOne,
                block.level >= 3 && styles.headingSmall,
                compact && styles.headingCompact,
                secondary && styles.secondaryHeading,
                spacingStyle,
              ]}
            >
              {renderInline(block.text, secondary)}
            </Text>
          );
        }

        if (block.type === "code") {
          return (
            <View key={key} style={[styles.codeBlock, spacingStyle]}>
              {block.language ? (
                <Text style={styles.codeLanguage}>{block.language}</Text>
              ) : null}
              <ScrollView
                contentContainerStyle={styles.codeScroll}
                horizontal
                nestedScrollEnabled
                showsHorizontalScrollIndicator={false}
              >
                <Text selectable style={styles.codeText}>
                  {block.text}
                </Text>
              </ScrollView>
            </View>
          );
        }

        if (block.type === "list-item") {
          return (
            <View
              key={key}
              style={[
                styles.listRow,
                { marginLeft: Math.min(block.depth, 4) * spacing.lg },
                spacingStyle,
              ]}
            >
              <Text style={[baseText, styles.listMarker]}>
                {block.ordered ? `${block.ordinal ?? index + 1}.` : "\u2022"}
              </Text>
              <Text selectable style={[baseText, styles.listText]}>
                {renderInline(block.text, secondary)}
              </Text>
            </View>
          );
        }

        if (block.type === "quote") {
          return (
            <View key={key} style={[styles.quote, spacingStyle]}>
              <Text selectable style={[baseText, styles.quoteText]}>
                {renderInline(block.text, secondary)}
              </Text>
            </View>
          );
        }

        if (block.type === "divider") {
          return <View key={key} style={[styles.divider, spacingStyle]} />;
        }

        return (
          <Fragment key={key}>
            <Text selectable style={[baseText, spacingStyle]}>
              {renderInline(block.text, secondary)}
            </Text>
          </Fragment>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    minWidth: 0,
    flexShrink: 1,
  },
  body: {
    ...typography.body,
    color: colors.text,
    fontSize: 15.5,
    lineHeight: 22,
  },
  compactBody: {
    fontSize: 14,
    lineHeight: 21,
  },
  secondaryText: {
    color: colors.textSecondary,
  },
  blockSpacing: {
    marginBottom: spacing.md,
  },
  listSpacing: {
    marginBottom: spacing.xs,
  },
  blockSpacingAfterList: {
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  heading: {
    ...typography.heading,
    color: colors.text,
    fontSize: 18,
    lineHeight: 23,
    marginTop: spacing.xs,
  },
  headingOne: {
    fontSize: 21,
    lineHeight: 27,
    fontWeight: "700",
  },
  headingSmall: {
    fontSize: 16,
    lineHeight: 21,
  },
  headingCompact: {
    fontSize: 15,
    lineHeight: 20,
  },
  secondaryHeading: {
    color: colors.textSecondary,
  },
  strong: {
    fontWeight: "700",
    color: colors.text,
  },
  emphasis: {
    fontStyle: "italic",
  },
  strikethrough: {
    textDecorationLine: "line-through",
    color: colors.textMuted,
  },
  inlineCode: {
    ...typography.mono,
    fontSize: 13,
    lineHeight: 19,
    color: colors.primaryStrong,
    backgroundColor: "#302D35",
  },
  link: {
    color: "#8DAAFF",
    textDecorationLine: "underline",
  },
  reference: {
    color: colors.primaryStrong,
    backgroundColor: "#353142",
    fontWeight: "600",
    borderRadius: 4,
  },
  listRow: {
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-start",
  },
  listMarker: {
    width: 23,
    color: colors.textSecondary,
    fontWeight: "600",
  },
  listText: {
    flex: 1,
  },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
    paddingLeft: spacing.md,
    paddingVertical: spacing.xs,
  },
  quoteText: {
    color: colors.textSecondary,
    fontStyle: "italic",
  },
  codeBlock: {
    overflow: "hidden",
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.backgroundDeep,
  },
  codeLanguage: {
    ...typography.caption,
    color: colors.textMuted,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    textTransform: "uppercase",
  },
  codeScroll: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  codeText: {
    ...typography.mono,
    color: colors.textSecondary,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.sm,
  },
});
