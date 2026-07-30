import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "expo-router";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ActionButton,
  Card,
  PageHeader,
  Screen,
  SectionHeader,
  StatusPill,
} from "@/components/primitives";
import { useRelayHosts, useSecureSettings } from "@/hooks/use-relay";
import { RelayClient } from "@/lib/relay-client";
import { removePairSecret, saveRelayCredentials } from "@/lib/secure-settings";
import { useRemoteStore } from "@/store/remote-store";
import { colors, radius, spacing, typography } from "@/theme/tokens";

const qualities = ["Auto", "1080p", "720p", "Data saver"];

export default function SettingsScreen() {
  const queryClient = useQueryClient();
  const settings = useSecureSettings();
  const { hosts } = useRelayHosts();
  const selectedHostId = useRemoteStore((state) => state.selectedHostId);
  const selectHost = useRemoteStore((state) => state.selectHost);
  const [relayUrl, setRelayUrl] = useState("");
  const [ownerToken, setOwnerToken] = useState("");
  const [quality, setQuality] = useState("Auto");
  const [haptics, setHaptics] = useState(true);
  const [diagnostics, setDiagnostics] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    setRelayUrl(settings.data.relayUrl);
    setOwnerToken(settings.data.ownerToken);
  }, [settings.data]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await saveRelayCredentials(relayUrl, ownerToken);
      await queryClient.invalidateQueries({ queryKey: ["secure-settings"] });
      await queryClient.invalidateQueries({ queryKey: ["hosts"] });
      setMessage("Relay credentials saved securely.");
      if (haptics) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen>
      <PageHeader
        eyebrow="Bezi Remote"
        title="Settings"
        subtitle="Proof environment and device security"
        action={<StatusPill label="Stage A" tone="primary" />}
      />

      <View>
        <SectionHeader title="Pairing" />
        <Card elevated style={styles.pairingCard}>
          <View style={styles.settingIcon}>
            <MaterialCommunityIcons name="qrcode-scan" color={colors.primaryStrong} size={24} />
          </View>
          <View style={styles.grow}>
            <Text style={styles.settingTitle}>Connect a Windows PC</Text>
            <Text style={styles.settingCopy}>
              Scan the one-time code shown by the desktop companion.
            </Text>
          </View>
          <Link href="/pair" asChild>
            <Pressable accessibilityRole="button" style={styles.chevronButton}>
              <MaterialCommunityIcons name="chevron-right" color={colors.text} size={24} />
            </Pressable>
          </Link>
        </Card>
      </View>

      <View>
        <SectionHeader title="Development relay" />
        <Card style={styles.form}>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>RELAY URL</Text>
            <TextInput
              accessibilityLabel="Relay URL"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              value={relayUrl}
              onChangeText={setRelayUrl}
              placeholder="https://…workers.dev"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>OWNER TOKEN</Text>
            <TextInput
              accessibilityLabel="Development owner token"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              value={ownerToken}
              onChangeText={setOwnerToken}
              placeholder="Stored in SecureStore"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
            />
          </View>
          <Text style={styles.securityNote}>
            The token is entered at runtime and never embedded in the Expo bundle.
          </Text>
          <ActionButton label="Save and test" loading={saving} onPress={() => void save()} />
          {message ? (
            <Text style={[styles.message, message.includes("saved") ? styles.success : styles.error]}>
              {message}
            </Text>
          ) : null}
        </Card>
      </View>

      <View>
        <SectionHeader title="Stream quality" />
        <View style={styles.chips}>
          {qualities.map((value) => (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: value === quality }}
              key={value}
              onPress={() => setQuality(value)}
              style={[styles.chip, value === quality && styles.chipSelected]}
            >
              <Text style={[styles.chipText, value === quality && styles.chipTextSelected]}>
                {value}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View>
        <SectionHeader title="Experience" />
        <Card style={styles.settingList}>
          <SettingToggle
            icon="gesture-tap"
            title="Control haptics"
            subtitle="Confirm control and important mutations"
            value={haptics}
            onValueChange={setHaptics}
          />
          <View style={styles.separator} />
          <SettingToggle
            icon="chart-timeline-variant"
            title="Private diagnostics"
            subtitle="Connection metrics only; never content"
            value={diagnostics}
            onValueChange={setDiagnostics}
          />
        </Card>
      </View>

      <View>
        <SectionHeader title="Paired PCs" />
        <Card style={styles.settingList}>
          {(hosts.data ?? []).length === 0 ? (
            <Text style={styles.empty}>No relay-backed PCs are paired yet.</Text>
          ) : (
            hosts.data!.map((host, index) => (
              <View key={host.id}>
                {index > 0 ? <View style={styles.separator} /> : null}
                <View style={styles.hostRow}>
                  <View style={styles.settingIcon}>
                    <MaterialCommunityIcons name="monitor" color={colors.text} size={21} />
                  </View>
                  <View style={styles.grow}>
                    <Text style={styles.settingTitle}>{host.name}</Text>
                    <Text style={styles.settingCopy}>Last seen {new Date(host.lastSeenAt).toLocaleString()}</Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      selectedHostId === host.id
                        ? `${host.name} is connected`
                        : `Connect to ${host.name}`
                    }
                    onPress={() => selectHost(host.id)}
                    style={[
                      styles.connectButton,
                      selectedHostId === host.id && styles.connectButtonActive,
                    ]}
                  >
                    <MaterialCommunityIcons
                      name={selectedHostId === host.id ? "check" : "connection"}
                      color={
                        selectedHostId === host.id ? colors.primaryInk : colors.text
                      }
                      size={18}
                    />
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Revoke ${host.name}`}
                    onPress={() => {
                      if (!settings.data) return;
                      void new RelayClient(settings.data)
                        .revokeHost(host.id)
                        .then(() => removePairSecret(host.id))
                        .then(() => hosts.refetch());
                    }}
                    style={styles.chevronButton}
                  >
                    <MaterialCommunityIcons name="trash-can-outline" color={colors.danger} size={20} />
                  </Pressable>
                </View>
              </View>
            ))
          )}
        </Card>
      </View>

      <Card style={styles.securityCard}>
        <MaterialCommunityIcons name="shield-lock-outline" color={colors.live} size={22} />
        <View style={styles.grow}>
          <Text style={styles.settingTitle}>End-to-end control encryption</Text>
          <Text style={styles.settingCopy}>
            Cloudflare routes encrypted frames and cannot read prompts, code, Unity values, or input.
          </Text>
        </View>
      </Card>
    </Screen>
  );
}

function SettingToggle({
  icon,
  title,
  subtitle,
  value,
  onValueChange,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  title: string;
  subtitle: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.settingIcon}>
        <MaterialCommunityIcons name={icon} color={colors.textSecondary} size={21} />
      </View>
      <View style={styles.grow}>
        <Text style={styles.settingTitle}>{title}</Text>
        <Text style={styles.settingCopy}>{subtitle}</Text>
      </View>
      <Switch
        accessibilityLabel={title}
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: colors.surfaceStrong, true: colors.primary }}
        thumbColor={value ? colors.primaryInk : colors.textSecondary}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  pairingCard: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  settingIcon: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceStrong,
  },
  settingTitle: { ...typography.label, color: colors.text },
  settingCopy: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  chevronButton: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  form: { gap: spacing.lg },
  field: { gap: spacing.sm },
  fieldLabel: { ...typography.caption, color: colors.textMuted, letterSpacing: 0.8 },
  input: {
    minHeight: 48,
    borderRadius: radius.md,
    backgroundColor: colors.background,
    borderColor: colors.borderSoft,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.text,
    ...typography.body,
    paddingHorizontal: spacing.md,
  },
  securityNote: { ...typography.caption, color: colors.textMuted },
  message: { ...typography.caption, textAlign: "center" },
  success: { color: colors.live },
  error: { color: colors.danger },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    minHeight: 40,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...typography.label, color: colors.textSecondary },
  chipTextSelected: { color: colors.primaryInk },
  settingList: { paddingVertical: spacing.sm },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 68 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.borderSoft, marginLeft: 54 },
  empty: { ...typography.body, color: colors.textMuted, padding: spacing.sm },
  hostRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 68 },
  connectButton: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceStrong,
  },
  connectButtonActive: { backgroundColor: colors.primary },
  securityCard: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md, backgroundColor: "#202923" },
});
