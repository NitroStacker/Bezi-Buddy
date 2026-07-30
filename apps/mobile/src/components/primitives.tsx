import type { PropsWithChildren, ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, radius, spacing, typography } from "@/theme/tokens";

export function Screen({
  children,
  scroll = true,
  contentStyle,
}: PropsWithChildren<{
  scroll?: boolean;
  contentStyle?: ViewStyle;
}>) {
  const content = <View style={[styles.content, contentStyle]}>{children}</View>;
  return (
    <SafeAreaView edges={["top"]} style={styles.safe}>
      {scroll ? (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {content}
        </ScrollView>
      ) : (
        content
      )}
    </SafeAreaView>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  action,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.headerCopy}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {action}
    </View>
  );
}

export function Card({
  children,
  style,
  elevated = false,
}: PropsWithChildren<{ style?: ViewStyle; elevated?: boolean }>) {
  return (
    <View style={[styles.card, elevated && styles.cardElevated, style]}>{children}</View>
  );
}

export function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {action}
    </View>
  );
}

export function StatusPill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "live" | "warning" | "danger" | "neutral" | "primary";
}) {
  const toneColor = {
    live: colors.live,
    warning: colors.warning,
    danger: colors.danger,
    neutral: colors.textSecondary,
    primary: colors.primary,
  }[tone];
  return (
    <View
      accessible
      accessibilityLabel={`Status: ${label}`}
      style={styles.pill}
    >
      <View style={[styles.dot, { backgroundColor: toneColor }]} />
      <Text style={styles.pillText}>{label}</Text>
    </View>
  );
}

export function ActionButton({
  label,
  onPress,
  icon,
  variant = "primary",
  disabled = false,
  loading = false,
  style,
}: {
  label: string;
  onPress: () => void;
  icon?: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        buttonStyles[variant],
        pressed && styles.buttonPressed,
        (disabled || loading) && styles.buttonDisabled,
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={buttonTextColors[variant]} /> : icon}
      <Text style={[styles.buttonText, { color: buttonTextColors[variant] }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Label({
  children,
  style,
}: PropsWithChildren<{ style?: TextStyle }>) {
  return <Text style={[styles.label, style]}>{children}</Text>;
}

const buttonStyles: Record<string, ViewStyle> = {
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.surfaceStrong, borderColor: colors.border },
  danger: { backgroundColor: colors.danger },
  ghost: { backgroundColor: "transparent", borderColor: colors.border },
};

const buttonTextColors: Record<string, string> = {
  primary: colors.primaryInk,
  secondary: colors.text,
  danger: colors.backgroundDeep,
  ghost: colors.textSecondary,
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  scrollContent: { flexGrow: 1 },
  content: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: 112,
    gap: spacing.xl,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  headerCopy: { flex: 1, gap: spacing.xs },
  eyebrow: {
    ...typography.caption,
    color: colors.primary,
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  title: { ...typography.title, color: colors.text, letterSpacing: -0.8 },
  subtitle: { ...typography.body, color: colors.textSecondary, maxWidth: 520 },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.borderSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  cardElevated: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  sectionTitle: { ...typography.heading, color: colors.text },
  pill: {
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { ...typography.caption, color: colors.text },
  button: {
    minHeight: 46,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.sm,
  },
  buttonPressed: { opacity: 0.78, transform: [{ scale: 0.985 }] },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { ...typography.label },
  label: { ...typography.label, color: colors.textSecondary },
});

