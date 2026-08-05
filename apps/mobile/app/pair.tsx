import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  CameraView,
  type BarcodeScanningResult,
  useCameraPermissions,
} from "expo-camera";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  Platform,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ActionButton, Card } from "@/components/primitives";
import { RelayClient, parsePairingCode } from "@/lib/relay-client";
import { loadSecureSettings } from "@/lib/secure-settings";
import { useRemoteStore } from "@/store/remote-store";
import { colors, radius, spacing, typography } from "@/theme/tokens";

export default function PairScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const selectHost = useRemoteStore((state) => state.selectHost);
  const [permission, requestPermission] = useCameraPermissions();
  const [manualCode, setManualCode] = useState("");
  const [scanning, setScanning] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const claim = async (value: string) => {
    if (busy) return;
    setBusy(true);
    setScanning(false);
    setError(null);
    try {
      const pairing = parsePairingCode(value);
      const settings = await loadSecureSettings();
      const hostId = await new RelayClient(settings).claimPairing(
        pairing,
        Platform.OS === "android" ? "Personal Android phone" : "Personal iPhone",
      );
      await queryClient.invalidateQueries({ queryKey: ["hosts"] });
      selectHost(hostId);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace(`/bezi?paired=${encodeURIComponent(hostId)}`);
    } catch (claimError) {
      setError(
        claimError instanceof Error ? claimError.message : "Pairing could not be completed",
      );
      setScanning(true);
    } finally {
      setBusy(false);
    }
  };

  const onBarcode = (result: BarcodeScanningResult) => {
    if (scanning) void claim(result.data);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close pairing"
          onPress={() => router.back()}
          style={styles.close}
        >
          <MaterialCommunityIcons name="close" color={colors.text} size={24} />
        </Pressable>
        <Text accessibilityRole="header" style={styles.title}>Pair your PC</Text>
        <View style={styles.close} />
      </View>

      <View style={styles.content}>
        <Text style={styles.copy}>
          Open the Bezi companion on Windows and scan its one-time private code.
        </Text>

        <View style={styles.cameraFrame}>
          {!permission ? (
            <ActivityIndicator color={colors.primary} />
          ) : permission.granted ? (
            <CameraView
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={scanning ? onBarcode : undefined}
              style={StyleSheet.absoluteFill}
            />
          ) : (
            <View style={styles.permission}>
              <MaterialCommunityIcons name="camera-lock-outline" color={colors.primary} size={32} />
              <Text style={styles.permissionTitle}>Camera access is off</Text>
              <Text style={styles.permissionCopy}>It is used only to read the pairing QR.</Text>
              <ActionButton label="Allow camera" onPress={() => void requestPermission()} />
            </View>
          )}
          <View pointerEvents="none" style={styles.scanGuide}>
            <View style={[styles.corner, styles.topLeft]} />
            <View style={[styles.corner, styles.topRight]} />
            <View style={[styles.corner, styles.bottomLeft]} />
            <View style={[styles.corner, styles.bottomRight]} />
          </View>
          {busy ? (
            <View style={styles.busyOverlay}>
              <ActivityIndicator color={colors.primaryStrong} size="large" />
              <Text style={styles.busyText}>Verifying encrypted pairing…</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.security}>
          <MaterialCommunityIcons name="shield-check-outline" color={colors.live} size={20} />
          <Text style={styles.securityText}>
            The encryption secret travels in this QR and is never sent to Cloudflare.
          </Text>
        </View>

        <Card style={styles.manual}>
          <Text style={styles.manualTitle}>Or paste the pairing payload</Text>
          <TextInput
            accessibilityLabel="Pairing payload"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onChangeText={setManualCode}
            placeholder="beziremote://pair?payload=…"
            placeholderTextColor={colors.textMuted}
            style={styles.manualInput}
            value={manualCode}
          />
          <ActionButton
            disabled={!manualCode.trim()}
            label="Pair securely"
            onPress={() => void claim(manualCode)}
          />
        </Card>

        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
  },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  title: { ...typography.heading, color: colors.text },
  content: { flex: 1, padding: spacing.lg, gap: spacing.lg, alignItems: "stretch" },
  copy: { ...typography.body, color: colors.textSecondary, textAlign: "center", paddingHorizontal: spacing.xl },
  cameraFrame: {
    alignSelf: "center",
    width: "88%",
    maxWidth: 420,
    aspectRatio: 1,
    overflow: "hidden",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.backgroundDeep,
    alignItems: "center",
    justifyContent: "center",
  },
  permission: { alignItems: "center", gap: spacing.sm, padding: spacing.xl },
  permissionTitle: { ...typography.heading, color: colors.text },
  permissionCopy: { ...typography.body, color: colors.textSecondary, textAlign: "center", marginBottom: spacing.md },
  scanGuide: { position: "absolute", inset: 30 },
  corner: { position: "absolute", width: 42, height: 42, borderColor: colors.primary, borderWidth: 3 },
  topLeft: { left: 0, top: 0, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 6 },
  topRight: { right: 0, top: 0, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 6 },
  bottomLeft: { left: 0, bottom: 0, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 6 },
  bottomRight: { right: 0, bottom: 0, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 6 },
  busyOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.overlay, alignItems: "center", justifyContent: "center", gap: spacing.md },
  busyText: { ...typography.label, color: colors.text },
  security: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: spacing.sm },
  securityText: { ...typography.caption, color: colors.textSecondary, maxWidth: 320 },
  manual: { gap: spacing.md },
  manualTitle: { ...typography.label, color: colors.text },
  manualInput: { minHeight: 58, maxHeight: 100, borderRadius: radius.md, backgroundColor: colors.background, color: colors.text, ...typography.mono, padding: spacing.md },
  error: { ...typography.body, color: colors.danger, textAlign: "center" },
});
