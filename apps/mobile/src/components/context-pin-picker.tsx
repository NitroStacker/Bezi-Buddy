import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ContextPin } from "@/lib/context-pins";
import { colors, radius, spacing, typography } from "@/theme/tokens";

export function ContextPinPicker({
  pins,
  query,
  loading,
  unityConnected,
  onSelect,
}: {
  pins: readonly ContextPin[];
  query: string;
  loading: boolean;
  unityConnected: boolean;
  onSelect: (pin: ContextPin) => void;
}) {
  let lastSource: ContextPin["source"] | null = null;
  return (
    <View
      accessibilityLabel="Mention Unity or Bezi context"
      style={styles.picker}
    >
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          {query ? `Results for "${query}"` : "Add context"}
        </Text>
        <Text style={styles.headerHint}>Tap to pin</Text>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        style={styles.results}
      >
        {pins.length === 0 ? (
          <View style={styles.empty}>
            {loading ? (
              <MaterialCommunityIcons
                color={colors.primaryStrong}
                name="progress-clock"
                size={20}
              />
            ) : null}
            <Text style={styles.emptyText}>
              {loading
                ? "Loading Unity and Bezi context..."
                : "No matching Unity objects, assets, or Bezi Pages"}
            </Text>
          </View>
        ) : (
          pins.map((pin) => {
            const showGroup = pin.source !== lastSource;
            lastSource = pin.source;
            return (
              <View key={pin.id}>
                {showGroup ? (
                  <Text style={styles.group}>
                    {pin.source === "unity" ? "Unity project" : "Bezi Pages"}
                  </Text>
                ) : null}
                <Pressable
                  accessibilityHint={pin.detail}
                  accessibilityLabel={`Pin ${pin.name}`}
                  accessibilityRole="button"
                  onPress={() => onSelect(pin)}
                  style={({ pressed }) => [
                    styles.option,
                    pressed && styles.optionPressed,
                  ]}
                >
                  <View
                    style={[
                      styles.icon,
                      pin.source === "unity" && styles.unityIcon,
                    ]}
                  >
                    <MaterialCommunityIcons
                      color={
                        pin.source === "unity"
                          ? colors.primaryStrong
                          : colors.textSecondary
                      }
                      name={pinIcon(pin)}
                      size={18}
                    />
                  </View>
                  <View style={styles.copy}>
                    <Text numberOfLines={1} style={styles.name}>
                      {pin.name}
                    </Text>
                    <Text numberOfLines={1} style={styles.detail}>
                      {pin.detail}
                    </Text>
                  </View>
                  <Text style={styles.kind}>{pin.kind}</Text>
                </Pressable>
              </View>
            );
          })
        )}
        {!unityConnected ? (
          <View style={styles.unityDisconnected}>
            <MaterialCommunityIcons
              color={colors.textMuted}
              name="connection"
              size={16}
            />
            <Text style={styles.unityDisconnectedText}>
              Unity project context is not connected on this PC
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

export function ContextPinPills({
  pins,
  loadingIds,
  onRemove,
}: {
  pins: readonly ContextPin[];
  loadingIds?: ReadonlySet<string>;
  onRemove: (pin: ContextPin) => void;
}) {
  if (pins.length === 0) return null;
  return (
    <ScrollView
      contentContainerStyle={styles.pills}
      horizontal
      keyboardShouldPersistTaps="handled"
      showsHorizontalScrollIndicator={false}
    >
      {pins.map((pin) => (
        <Pressable
          accessibilityLabel={`Remove ${pin.name} context pin`}
          accessibilityRole="button"
          key={pin.id}
          onPress={() => onRemove(pin)}
          style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
        >
          <MaterialCommunityIcons
            color={
              pin.source === "unity" ? colors.primaryStrong : colors.textSecondary
            }
            name={pin.source === "unity" ? "unity" : "file-document-outline"}
            size={14}
          />
          <Text numberOfLines={1} style={styles.pillName}>
            {pin.name}
          </Text>
          <MaterialCommunityIcons
            color={colors.textMuted}
            name={loadingIds?.has(pin.id) ? "progress-clock" : "close"}
            size={14}
          />
        </Pressable>
      ))}
    </ScrollView>
  );
}

function pinIcon(pin: ContextPin): keyof typeof MaterialCommunityIcons.glyphMap {
  if (pin.source === "bezi") return "file-document-outline";
  if (pin.kind === "GameObject") return "cube-outline";
  if (pin.kind === "Script") return "language-csharp";
  if (pin.kind === "Scene") return "cube-scan";
  if (pin.kind === "Prefab") return "cube";
  if (pin.kind === "Material" || pin.kind === "Shader") return "palette-outline";
  if (pin.kind === "Texture") return "image-outline";
  if (pin.kind === "Audio") return "volume-high";
  return "unity";
}

const styles = StyleSheet.create({
  picker: {
    maxHeight: 290,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  header: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  headerTitle: { ...typography.caption, color: colors.textSecondary },
  headerHint: { ...typography.caption, color: colors.textMuted },
  results: { maxHeight: 244, paddingHorizontal: spacing.xs },
  group: {
    ...typography.caption,
    color: colors.textMuted,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    textTransform: "uppercase",
    letterSpacing: 0.7,
  },
  option: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
  },
  optionPressed: { backgroundColor: colors.surfaceStrong },
  icon: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceStrong,
  },
  unityIcon: { backgroundColor: colors.primarySoft },
  copy: { flex: 1, minWidth: 0 },
  name: { ...typography.label, color: colors.text },
  detail: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  kind: { ...typography.caption, color: colors.textMuted },
  empty: {
    minHeight: 86,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  emptyText: { ...typography.caption, color: colors.textMuted, textAlign: "center" },
  unityDisconnected: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginHorizontal: spacing.sm,
    marginVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceStrong,
  },
  unityDisconnectedText: {
    ...typography.caption,
    color: colors.textMuted,
    flex: 1,
  },
  pills: {
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
  },
  pill: {
    maxWidth: 220,
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceStrong,
  },
  pillPressed: { borderColor: colors.primaryStrong },
  pillName: { ...typography.caption, color: colors.textSecondary, flexShrink: 1 },
});
