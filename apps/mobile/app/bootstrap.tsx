import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ActionButton, Card } from "@/components/primitives";
import { parseAndroidBootstrapPayload } from "@/lib/android-bootstrap";
import { saveAndroidBootstrap } from "@/lib/secure-settings";
import { useRemoteStore } from "@/store/remote-store";
import { colors, spacing, typography } from "@/theme/tokens";

export default function AndroidBootstrapScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const selectHost = useRemoteStore((state) => state.selectHost);
  const params = useLocalSearchParams<{ payload?: string | string[] }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const result = useMemo(() => {
    try {
      const raw = Array.isArray(params.payload) ? params.payload[0] : params.payload;
      return { bootstrap: parseAndroidBootstrapPayload(raw ?? ""), error: null };
    } catch (error) {
      return {
        bootstrap: null,
        error: error instanceof Error ? error.message : "The Android setup link is invalid",
      };
    }
  }, [params.payload]);

  const connect = async () => {
    if (!result.bootstrap || busy) return;
    setBusy(true);
    setSaveError(null);
    try {
      await saveAndroidBootstrap(result.bootstrap);
      await queryClient.invalidateQueries({ queryKey: ["secure-settings"] });
      await queryClient.invalidateQueries({ queryKey: ["hosts"] });
      selectHost(result.bootstrap.hostId);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace(`/bezi?paired=${encodeURIComponent(result.bootstrap.hostId)}`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "The secure setup could not be saved");
    } finally {
      setBusy(false);
    }
  };

  const relayHost = result.bootstrap
    ? new URL(result.bootstrap.relayUrl).hostname
    : null;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.content}>
        <View style={styles.mark}>
          <MaterialCommunityIcons
            name={result.bootstrap ? "shield-link-variant" : "link-variant-off"}
            color={result.bootstrap ? colors.live : colors.danger}
            size={36}
          />
        </View>
        <Text accessibilityRole="header" style={styles.title}>
          {result.bootstrap ? "Connect this Android phone" : "Setup link unavailable"}
        </Text>
        <Text style={styles.copy}>
          {result.bootstrap
            ? "This private link pairs Bezi Buddy with the Windows session that sent it."
            : result.error}
        </Text>

        {result.bootstrap ? (
          <Card elevated style={styles.card}>
            <Text style={styles.label}>WINDOWS HOST</Text>
            <Text style={styles.value}>{result.bootstrap.hostId}</Text>
            <Text style={styles.label}>SECURE RELAY</Text>
            <Text style={styles.value}>{relayHost}</Text>
            <View style={styles.security}>
              <MaterialCommunityIcons name="lock-outline" color={colors.live} size={18} />
              <Text style={styles.securityCopy}>
                Credentials are stored in Android SecureStore. The emailed link expires with this session.
              </Text>
            </View>
            <ActionButton label="Connect securely" loading={busy} onPress={() => void connect()} />
          </Card>
        ) : (
          <ActionButton label="Close" onPress={() => router.replace("/settings")} />
        )}

        {saveError ? <Text accessibilityRole="alert" style={styles.error}>{saveError}</Text> : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: {
    flex: 1,
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.lg,
  },
  mark: { alignItems: "center" },
  title: { ...typography.title, color: colors.text, textAlign: "center" },
  copy: { ...typography.body, color: colors.textSecondary, textAlign: "center" },
  card: { gap: spacing.md },
  label: { ...typography.caption, color: colors.textMuted, letterSpacing: 0.8 },
  value: { ...typography.mono, color: colors.text },
  security: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  securityCopy: { ...typography.caption, color: colors.textSecondary, flex: 1 },
  error: { ...typography.body, color: colors.danger, textAlign: "center" },
});
