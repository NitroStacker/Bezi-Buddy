import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { Link } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ActionButton,
  Card,
  PageHeader,
  Screen,
  StatusPill,
} from "@/components/primitives";
import { RemoteSurface } from "@/components/remote-surface";
import { useSession } from "@/context/session-context";
import { useRemoteStream } from "@/hooks/use-remote-stream";
import { colors, radius, spacing, typography } from "@/theme/tokens";

type UnityTab = "hierarchy" | "inspector" | "assets";
type UnityInstance = {
  instanceId: string;
  processId: number;
  projectName: string;
  projectPath: string;
  unityVersion: string;
  openScenes: string[];
  playing: boolean;
  paused: boolean;
  compiling: boolean;
};
type HierarchyNode = {
  id: string;
  parentId?: string;
  name: string;
  depth: number;
  active: boolean;
  childCount: number;
  scene: string;
};
type AssetNode = { id: string; name: string; typeName: string; path: string };
type RemoteValue = {
  kind?: string;
  boolValue?: boolean;
  intValue?: number;
  numberValue?: number;
  stringValue?: string;
  components?: number[];
  objectId?: string;
};
type RemoteProperty = {
  path: string;
  displayName: string;
  kind: string;
  readOnly: boolean;
  value: RemoteValue;
  enumOptions: string[];
};
type ComponentSnapshot = {
  targetId: string;
  name: string;
  typeName: string;
  revision: number;
  properties: RemoteProperty[];
};
type InspectorSnapshot = ComponentSnapshot & { components: ComponentSnapshot[] };
type StagedProperty = {
  targetId: string;
  revision: number;
  property: RemoteProperty;
  value: RemoteValue;
};

export default function UnityScreen() {
  const {
    connected,
    capabilities,
    hasControl,
    releaseControl,
    send,
    subscribe,
    takeControl,
  } = useSession();
  const [instances, setInstances] = useState<UnityInstance[]>(() =>
    parseInstances(asRecord(capabilities?.body.unity)?.instances),
  );
  const [instanceId, setInstanceId] = useState<string | null>(instances[0]?.instanceId ?? null);
  const [tab, setTab] = useState<UnityTab>("hierarchy");
  const [hierarchy, setHierarchy] = useState<HierarchyNode[]>([]);
  const [assets, setAssets] = useState<AssetNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspector, setInspector] = useState<InspectorSnapshot | null>(null);
  const [staged, setStaged] = useState<StagedProperty | null>(null);
  const [query, setQuery] = useState("");
  const [assetQuery, setAssetQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const hierarchyRequest = useRef<string | null>(null);
  const assetsRequest = useRef<string | null>(null);
  const inspectorRequest = useRef<string | null>(null);
  const applyRequest = useRef<string | null>(null);
  const instancesRequest = useRef<string | null>(null);
  const remoteStream = useRemoteStream("unity", instanceId);
  const selectedInstance = instances.find((instance) => instance.instanceId === instanceId) ?? null;

  useEffect(() => {
    const advertised = parseInstances(asRecord(capabilities?.body.unity)?.instances);
    if (advertised.length > 0) {
      setInstances(advertised);
      setInstanceId((current) =>
        current && advertised.some((entry) => entry.instanceId === current)
          ? current
          : advertised[0].instanceId,
      );
    }
  }, [capabilities]);

  useEffect(() => {
    if (!connected) {
      instancesRequest.current = null;
      setInstances([]);
      setInstanceId(null);
      return;
    }
    const refresh = () => {
      instancesRequest.current = send("unity.instances.list", {}, { kind: "signaling" });
    };
    refresh();
    const timer = setInterval(refresh, 2_500);
    return () => clearInterval(timer);
  }, [connected, send]);

  useEffect(() => {
    setHierarchy([]);
    setAssets([]);
    setSelectedId(null);
    setInspector(null);
    setStaged(null);
    hierarchyRequest.current = null;
    assetsRequest.current = null;
    inspectorRequest.current = null;
    if (!connected || !instanceId) return;
    hierarchyRequest.current = send(
      "unity.hierarchy.snapshot",
      { instanceId },
      { kind: "signaling" },
    );
    assetsRequest.current = send(
      "unity.assets.snapshot",
      { instanceId },
      { kind: "signaling" },
    );
  }, [connected, instanceId, send]);

  useEffect(
    () =>
      subscribe((payload) => {
        if (payload.type === "unity.instances") {
          const next = parseInstances(payload.body.instances);
          setInstances(next);
          setInstanceId((current) =>
            current && next.some((entry) => entry.instanceId === current)
              ? current
              : next[0]?.instanceId ?? null,
          );
          return;
        }
        if (payload.type === "unity.error") {
          setError(stringValue(payload.body.message) ?? "Unity rejected the command.");
          return;
        }
        if (payload.type !== "unity.result") return;
        const success = payload.body.success === true;
        const result = asRecord(payload.body.result);
        if (!success) {
          setError(
            stringValue(payload.body.message) ??
              stringValue(payload.body.errorCode) ??
              "Unity could not complete the command.",
          );
          if (payload.requestId === applyRequest.current) applyRequest.current = null;
          return;
        }
        setError(null);

        if (payload.requestId === hierarchyRequest.current && result) {
          hierarchyRequest.current = null;
          const nodes = parseHierarchy(result.nodes);
          setHierarchy(nodes);
          const selectedIds = Array.isArray(result.selectedIds)
            ? result.selectedIds.filter((value): value is string => typeof value === "string")
            : [];
          const nextSelection = selectedIds[0] ?? nodes[0]?.id ?? null;
          setSelectedId(nextSelection);
          if (nextSelection && instanceId) {
            inspectorRequest.current = send(
              "unity.inspector.snapshot",
              { instanceId, targetId: nextSelection },
              { kind: "signaling" },
            );
          }
          return;
        }

        if (payload.requestId === assetsRequest.current && result) {
          assetsRequest.current = null;
          setAssets(parseAssets(result.assets));
          return;
        }

        if (payload.requestId === inspectorRequest.current && result) {
          inspectorRequest.current = null;
          const snapshot = parseInspector(result);
          if (snapshot) {
            setInspector(snapshot);
            setStaged(null);
          }
          return;
        }

        if (payload.requestId === applyRequest.current) {
          applyRequest.current = null;
          setStaged(null);
          if (selectedId && instanceId) {
            inspectorRequest.current = send(
              "unity.inspector.snapshot",
              { instanceId, targetId: selectedId },
              { kind: "signaling" },
            );
          }
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          return;
        }

        if (typeof result?.playing === "boolean" && instanceId) {
          setInstances((current) =>
            current.map((entry) =>
              entry.instanceId === instanceId
                ? {
                    ...entry,
                    playing: result.playing as boolean,
                    paused: result.paused === true,
                  }
                : entry,
            ),
          );
        }
      }),
    [instanceId, selectedId, send, subscribe],
  );

  const filteredHierarchy = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return hierarchy;
    return hierarchy.filter(
      (node) =>
        node.name.toLowerCase().includes(normalized) ||
        node.scene.toLowerCase().includes(normalized),
    );
  }, [hierarchy, query]);
  const filteredAssets = useMemo(() => {
    const normalized = assetQuery.trim().toLowerCase();
    if (!normalized) return assets;
    return assets.filter(
      (asset) =>
        asset.name.toLowerCase().includes(normalized) ||
        asset.typeName.toLowerCase().includes(normalized) ||
        asset.path.toLowerCase().includes(normalized),
    );
  }, [assetQuery, assets]);

  const inspectTarget = (targetId: string, selectInEditor: boolean) => {
    if (!instanceId) return;
    setSelectedId(targetId);
    setInspector(null);
    setStaged(null);
    if (selectInEditor && hasControl) {
      send("unity.selection.set", { instanceId, targetId });
    }
    inspectorRequest.current = send(
      "unity.inspector.snapshot",
      { instanceId, targetId },
      { kind: "signaling" },
    );
    setTab("inspector");
  };

  const sendPlayControl = (operation: "play" | "stop" | "pause" | "resume" | "step") => {
    if (!instanceId || !hasControl || selectedInstance?.compiling) return;
    send(`unity.${operation}`, { instanceId });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  return (
    <Screen>
      <PageHeader
        eyebrow={selectedInstance?.projectName ?? "Unity Editor"}
        title="Unity"
        subtitle={
          selectedInstance
            ? `${selectedInstance.unityVersion} · ${sceneLabel(selectedInstance.openScenes)}`
            : "Direct control of the running Unity project"
        }
        action={
          <View style={styles.headerActions}>
            <StatusPill
              label={
                selectedInstance?.compiling
                  ? "Compiling"
                  : selectedInstance?.playing
                    ? selectedInstance.paused
                      ? "Paused"
                      : "Playing"
                    : connected && selectedInstance
                      ? "Live"
                      : "No Editor"
              }
              tone={
                selectedInstance?.compiling
                  ? "warning"
                  : selectedInstance?.playing || (connected && selectedInstance)
                    ? "live"
                    : "neutral"
              }
            />
            <Link href="/settings" asChild>
              <Pressable
                accessibilityLabel="Open settings"
                accessibilityRole="button"
                style={styles.headerButton}
              >
                <MaterialCommunityIcons color={colors.textSecondary} name="tune-variant" size={21} />
              </Pressable>
            </Link>
          </View>
        }
      />

      {instances.length > 1 ? (
        <View style={styles.instanceStrip}>
          {instances.map((instance) => (
            <Pressable
              accessibilityRole="button"
              key={instance.instanceId}
              onPress={() => setInstanceId(instance.instanceId)}
              style={[
                styles.instanceChip,
                instance.instanceId === instanceId && styles.instanceChipActive,
              ]}
            >
              <View style={[styles.liveDot, instance.instanceId !== instanceId && styles.mutedDot]} />
              <Text style={styles.instanceText}>{instance.projectName}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <View style={styles.viewerSection}>
        <RemoteSurface
          controlEnabled={hasControl && Boolean(selectedInstance)}
          onSignal={remoteStream.onSignal}
          signal={remoteStream.signal}
        />
        <View style={styles.viewerTop}>
          <StatusPill
            label={selectedInstance ? "Selected Unity window" : "Waiting for Unity"}
            tone={selectedInstance ? "live" : "neutral"}
          />
        </View>
      </View>

      <Card style={styles.transport}>
        <View style={styles.transportButtons}>
          <TransportButton
            disabled={!selectedInstance || !hasControl || selectedInstance.compiling}
            icon={selectedInstance?.playing ? "stop" : "play"}
            label={selectedInstance?.playing ? "Stop Play Mode" : "Enter Play Mode"}
            onPress={() => sendPlayControl(selectedInstance?.playing ? "stop" : "play")}
            tone={selectedInstance?.playing ? colors.danger : colors.live}
          />
          <TransportButton
            disabled={!selectedInstance?.playing || !hasControl || selectedInstance.compiling}
            icon={selectedInstance?.paused ? "play-pause" : "pause"}
            label={selectedInstance?.paused ? "Resume" : "Pause"}
            onPress={() => sendPlayControl(selectedInstance?.paused ? "resume" : "pause")}
            tone={selectedInstance?.paused ? colors.primary : colors.textSecondary}
          />
          <TransportButton
            disabled={!selectedInstance?.playing || !hasControl || selectedInstance.compiling}
            icon="skip-next"
            label="Step one frame"
            onPress={() => sendPlayControl("step")}
            tone={colors.textSecondary}
          />
        </View>
        <View style={styles.transportDivider} />
        <Pressable
          accessibilityLabel={hasControl ? "Release control" : "Hold to take control"}
          accessibilityRole="button"
          delayLongPress={650}
          disabled={!connected}
          onLongPress={() => {
            takeControl(30);
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
          }}
          onPress={hasControl ? releaseControl : undefined}
          style={[styles.takeControl, hasControl && styles.takeControlActive]}
        >
          <MaterialCommunityIcons
            color={hasControl ? colors.primaryInk : colors.text}
            name={hasControl ? "shield-check" : "gesture-tap-hold"}
            size={19}
          />
          <Text style={[styles.takeControlText, hasControl && styles.takeControlTextActive]}>
            {hasControl ? "Tap to release" : "Hold to control"}
          </Text>
        </Pressable>
      </Card>

      {error ? (
        <Card style={styles.errorCard}>
          <MaterialCommunityIcons color={colors.danger} name="alert-circle-outline" size={20} />
          <Text style={styles.errorText}>{error}</Text>
        </Card>
      ) : null}

      <View accessibilityRole="tablist" style={styles.segment}>
        {(["hierarchy", "inspector", "assets"] as const).map((value) => (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === value }}
            key={value}
            onPress={() => setTab(value)}
            style={[styles.segmentButton, tab === value && styles.segmentActive]}
          >
            <Text style={[styles.segmentText, tab === value && styles.segmentTextActive]}>
              {value === "assets" ? "ScriptableObjects" : capitalize(value)}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === "hierarchy" ? (
        <Card style={styles.panel}>
          <SearchField placeholder="Search the live hierarchy" value={query} onChange={setQuery} />
          {!selectedInstance ? (
            <PanelEmpty
              title="No Unity Editor connected"
              copy="Install or enable the Bezi Remote Editor package in the open project."
            />
          ) : hierarchyRequest.current && hierarchy.length === 0 ? (
            <PanelEmpty title="Reading Unity hierarchy…" copy={selectedInstance.projectPath} />
          ) : filteredHierarchy.length === 0 ? (
            <PanelEmpty title="No matching objects" copy="The hierarchy comes directly from the open scenes." />
          ) : (
            filteredHierarchy.map((node, index) => {
              const previousScene = index > 0 ? filteredHierarchy[index - 1]?.scene : null;
              return (
                <View key={node.id}>
                  {node.scene !== previousScene ? (
                    <View style={styles.sceneHeader}>
                      <MaterialCommunityIcons color={colors.primary} name="cube-outline" size={16} />
                      <Text numberOfLines={1} style={styles.sceneName}>{node.scene}</Text>
                    </View>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => inspectTarget(node.id, true)}
                    style={[
                      styles.hierarchyRow,
                      { paddingLeft: spacing.md + Math.min(node.depth, 8) * 16 },
                      selectedId === node.id && styles.hierarchySelected,
                      !node.active && styles.inactive,
                    ]}
                  >
                    <MaterialCommunityIcons
                      color={node.childCount > 0 ? colors.textSecondary : colors.textMuted}
                      name={node.childCount > 0 ? "cube" : "cube-outline"}
                      size={16}
                    />
                    <Text
                      numberOfLines={1}
                      style={[
                        styles.hierarchyText,
                        selectedId === node.id && styles.hierarchyTextSelected,
                      ]}
                    >
                      {node.name}
                    </Text>
                    {node.childCount > 0 ? (
                      <Text style={styles.childCount}>{node.childCount}</Text>
                    ) : null}
                  </Pressable>
                </View>
              );
            })
          )}
        </Card>
      ) : tab === "assets" ? (
        <Card style={styles.panel}>
          <SearchField placeholder="Search ScriptableObjects" value={assetQuery} onChange={setAssetQuery} />
          {!selectedInstance ? (
            <PanelEmpty title="No Unity Editor connected" copy="Assets appear when the Editor package is online." />
          ) : assetsRequest.current && assets.length === 0 ? (
            <PanelEmpty title="Indexing ScriptableObjects…" copy="Only assets inside this Unity project are returned." />
          ) : filteredAssets.length === 0 ? (
            <PanelEmpty title="No matching ScriptableObjects" copy="No preview assets are substituted." />
          ) : (
            filteredAssets.map((asset) => (
              <Pressable
                accessibilityRole="button"
                key={asset.id}
                onPress={() => inspectTarget(asset.id, true)}
                style={[styles.assetRow, selectedId === asset.id && styles.hierarchySelected]}
              >
                <View style={styles.assetIcon}>
                  <MaterialCommunityIcons color={colors.primaryStrong} name="database-outline" size={19} />
                </View>
                <View style={styles.grow}>
                  <Text style={styles.assetName}>{asset.name}</Text>
                  <Text numberOfLines={1} style={styles.assetPath}>{asset.path}</Text>
                  <Text numberOfLines={1} style={styles.assetType}>{asset.typeName}</Text>
                </View>
                <MaterialCommunityIcons color={colors.textMuted} name="chevron-right" size={20} />
              </Pressable>
            ))
          )}
        </Card>
      ) : (
        <InspectorPanel
          hasControl={hasControl}
          inspector={inspector}
          staged={staged}
          onStage={setStaged}
          onApply={() => {
            if (!staged || !instanceId) return;
            applyRequest.current = send(
              "unity.property.apply",
              {
                instanceId,
                targetId: staged.targetId,
                propertyPath: staged.property.path,
                value: staged.value,
              },
              {
                expectedRevision: staged.revision,
                idempotencyKey: Crypto.randomUUID(),
              },
            );
          }}
        />
      )}
    </Screen>
  );
}

function InspectorPanel({
  inspector,
  staged,
  hasControl,
  onStage,
  onApply,
}: {
  inspector: InspectorSnapshot | null;
  staged: StagedProperty | null;
  hasControl: boolean;
  onStage: (value: StagedProperty | null) => void;
  onApply: () => void;
}) {
  if (!inspector) {
    return (
      <Card style={styles.panel}>
        <PanelEmpty
          title="Nothing selected"
          copy="Select a live hierarchy object or ScriptableObject to inspect it."
        />
      </Card>
    );
  }
  const groups: ComponentSnapshot[] = [
    {
      targetId: inspector.targetId,
      name: inspector.name,
      typeName: inspector.typeName,
      revision: inspector.revision,
      properties: inspector.properties,
    },
    ...inspector.components,
  ].filter((group) => group.properties.length > 0);
  return (
    <Card style={styles.inspectorPanel}>
      <View style={styles.inspectorTitle}>
        <View style={styles.objectIcon}>
          <MaterialCommunityIcons color={colors.primaryStrong} name="cube-scan" size={22} />
        </View>
        <View style={styles.grow}>
          <Text style={styles.objectName}>{inspector.name}</Text>
          <Text numberOfLines={1} style={styles.objectMeta}>{inspector.typeName}</Text>
        </View>
        {staged ? <StatusPill label="Staged" tone="warning" /> : null}
      </View>
      {groups.map((group) => (
        <View key={group.targetId} style={styles.component}>
          <View style={styles.componentHeader}>
            <MaterialCommunityIcons color={colors.textMuted} name="puzzle-outline" size={17} />
            <View style={styles.grow}>
              <Text style={styles.componentName}>{shortType(group.typeName)}</Text>
              <Text numberOfLines={1} style={styles.componentType}>{group.typeName}</Text>
            </View>
          </View>
          {group.properties.slice(0, 80).map((property) => {
            const isStaged =
              staged?.targetId === group.targetId &&
              staged.property.path === property.path;
            return (
              <PropertyEditor
                key={`${group.targetId}:${property.path}`}
                property={property}
                stagedValue={isStaged ? staged.value : undefined}
                onStage={(value) =>
                  onStage({
                    targetId: group.targetId,
                    revision: group.revision,
                    property,
                    value,
                  })
                }
              />
            );
          })}
        </View>
      ))}
      <ActionButton
        disabled={!staged || !hasControl}
        label={staged ? (hasControl ? "Apply staged change" : "Take control to apply") : "No staged changes"}
        onPress={onApply}
      />
      <Text style={styles.undoNote}>
        Apply creates one Unity Undo group. ScriptableObject assets save explicitly; scene changes stay unsaved.
      </Text>
    </Card>
  );
}

function PropertyEditor({
  property,
  stagedValue,
  onStage,
}: {
  property: RemoteProperty;
  stagedValue?: RemoteValue;
  onStage: (value: RemoteValue) => void;
}) {
  const value = stagedValue ?? property.value;
  const editable =
    !property.readOnly &&
    [
      "boolean",
      "integer",
      "number",
      "string",
      "enum",
      "color",
      "vector2",
      "vector3",
      "vector4",
      "vector2Int",
      "vector3Int",
      "rect",
      "rectInt",
      "bounds",
      "boundsInt",
      "quaternion",
    ].includes(property.kind);

  return (
    <View style={styles.property}>
      <View style={styles.propertyCopy}>
        <Text style={styles.propertyName}>{property.displayName}</Text>
        <Text numberOfLines={1} style={styles.propertyPath}>
          {property.path} · {property.kind}
          {property.readOnly ? " · Read only" : ""}
        </Text>
      </View>
      {property.kind === "boolean" ? (
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: value.boolValue === true, disabled: !editable }}
          disabled={!editable}
          onPress={() => onStage({ kind: "boolean", boolValue: value.boolValue !== true })}
          style={[
            styles.boolean,
            value.boolValue !== true && styles.booleanOff,
            !editable && styles.disabled,
          ]}
        >
          {value.boolValue === true ? (
            <MaterialCommunityIcons color={colors.primaryInk} name="check" size={18} />
          ) : null}
        </Pressable>
      ) : property.kind === "enum" && property.enumOptions.length > 0 ? (
        <Pressable
          accessibilityLabel={`${property.displayName}: ${remoteValueText(value, property)}`}
          accessibilityRole="button"
          disabled={!editable}
          onPress={() => {
            const current = value.intValue ?? 0;
            const next = (current + 1) % property.enumOptions.length;
            onStage({ kind: "enum", intValue: next, stringValue: property.enumOptions[next] });
          }}
          style={[styles.enumButton, !editable && styles.disabled]}
        >
          <Text numberOfLines={1} style={styles.enumText}>{remoteValueText(value, property)}</Text>
          <MaterialCommunityIcons color={colors.textMuted} name="chevron-down" size={18} />
        </Pressable>
      ) : editable ? (
        <TextInput
          accessibilityLabel={property.displayName}
          keyboardType={property.kind === "string" ? "default" : "numbers-and-punctuation"}
          onChangeText={(text) => onStage(remoteValueFromText(property.kind, text, value))}
          style={styles.valueInput}
          value={remoteValueText(value, property)}
        />
      ) : (
        <Text numberOfLines={1} style={styles.readOnlyValue}>{remoteValueText(value, property)}</Text>
      )}
    </View>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <View style={styles.search}>
      <MaterialCommunityIcons color={colors.textMuted} name="magnify" size={19} />
      <TextInput
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        style={styles.searchInput}
        value={value}
      />
      {value ? (
        <Pressable accessibilityLabel="Clear search" accessibilityRole="button" onPress={() => onChange("")}>
          <MaterialCommunityIcons color={colors.textMuted} name="close-circle" size={18} />
        </Pressable>
      ) : null}
    </View>
  );
}

function TransportButton({
  icon,
  label,
  disabled,
  onPress,
  tone,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  disabled: boolean;
  onPress: () => void;
  tone: string;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.transportButton, disabled && styles.disabled]}
    >
      <MaterialCommunityIcons color={tone} name={icon} size={23} />
    </Pressable>
  );
}

function PanelEmpty({ title, copy }: { title: string; copy: string }) {
  return (
    <View style={styles.panelEmpty}>
      <Text style={styles.panelEmptyTitle}>{title}</Text>
      <Text style={styles.panelEmptyCopy}>{copy}</Text>
    </View>
  );
}

function parseInstances(value: unknown): UnityInstance[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .filter(
      (entry) =>
        typeof entry.instanceId === "string" &&
        typeof entry.projectName === "string" &&
        typeof entry.projectPath === "string",
    )
    .map((entry) => ({
      instanceId: entry.instanceId as string,
      processId: numberValue(entry.processId),
      projectName: entry.projectName as string,
      projectPath: entry.projectPath as string,
      unityVersion: stringValue(entry.unityVersion) ?? "Unity",
      openScenes: Array.isArray(entry.openScenes)
        ? entry.openScenes.filter((scene): scene is string => typeof scene === "string")
        : [],
      playing: entry.playing === true,
      paused: entry.paused === true,
      compiling: entry.compiling === true,
    }));
}

function parseHierarchy(value: unknown): HierarchyNode[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asRecord)
    .filter((node): node is Record<string, unknown> => node !== null)
    .filter(
      (node) =>
        typeof node.id === "string" &&
        typeof node.name === "string" &&
        typeof node.depth === "number",
    )
    .slice(0, 2_000)
    .map((node) => ({
      id: node.id as string,
      parentId: stringValue(node.parentId) ?? undefined,
      name: node.name as string,
      depth: node.depth as number,
      active: node.active !== false,
      childCount: numberValue(node.childCount),
      scene: stringValue(node.scene) ?? "Untitled Scene",
    }));
}

function parseAssets(value: unknown): AssetNode[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asRecord)
    .filter((asset): asset is Record<string, unknown> => asset !== null)
    .filter(
      (asset) =>
        typeof asset.id === "string" &&
        typeof asset.name === "string" &&
        typeof asset.typeName === "string" &&
        typeof asset.path === "string",
    )
    .map((asset) => ({
      id: asset.id as string,
      name: asset.name as string,
      typeName: asset.typeName as string,
      path: asset.path as string,
    }));
}

function parseInspector(value: Record<string, unknown>): InspectorSnapshot | null {
  const top = parseComponent(value);
  if (!top) return null;
  const components = Array.isArray(value.components)
    ? value.components
        .map(asRecord)
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .map(parseComponent)
        .filter((entry): entry is ComponentSnapshot => entry !== null)
    : [];
  return { ...top, components };
}

function parseComponent(value: Record<string, unknown>): ComponentSnapshot | null {
  if (
    typeof value.targetId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.typeName !== "string" ||
    typeof value.revision !== "number" ||
    !Array.isArray(value.properties)
  ) {
    return null;
  }
  return {
    targetId: value.targetId,
    name: value.name,
    typeName: value.typeName,
    revision: value.revision,
    properties: value.properties
      .map(asRecord)
      .filter((property): property is Record<string, unknown> => property !== null)
      .filter(
        (property) =>
          typeof property.path === "string" &&
          typeof property.displayName === "string" &&
          typeof property.kind === "string",
      )
      .map((property) => ({
        path: property.path as string,
        displayName: property.displayName as string,
        kind: property.kind as string,
        readOnly: property.readOnly === true,
        value: (asRecord(property.value) ?? {}) as RemoteValue,
        enumOptions: Array.isArray(property.enumOptions)
          ? property.enumOptions.filter((entry): entry is string => typeof entry === "string")
          : [],
      })),
  };
}

function remoteValueText(value: RemoteValue, property?: RemoteProperty): string {
  if (property?.kind === "enum" && typeof value.intValue === "number") {
    return property.enumOptions[value.intValue] ?? value.stringValue ?? String(value.intValue);
  }
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.numberValue === "number") return String(value.numberValue);
  if (typeof value.intValue === "number") return String(value.intValue);
  if (typeof value.boolValue === "boolean") return value.boolValue ? "On" : "Off";
  if (Array.isArray(value.components)) return value.components.join(", ");
  if (typeof value.objectId === "string") return value.objectId || "None";
  return "—";
}

function remoteValueFromText(kind: string, text: string, prior: RemoteValue): RemoteValue {
  if (kind === "string") return { kind, stringValue: text };
  if (kind === "integer") return { kind, intValue: Number.parseInt(text || "0", 10) || 0 };
  if (kind === "number") return { kind, numberValue: Number.parseFloat(text || "0") || 0 };
  if (Array.isArray(prior.components)) {
    return {
      kind,
      components: text.split(",").map((part) => Number.parseFloat(part.trim()) || 0),
    };
  }
  return prior;
}

function sceneLabel(scenes: string[]): string {
  const last = scenes[0]?.split(/[\\/]/).at(-1);
  return last?.replace(/\.unity$/i, "") ?? "No open scene";
}

function shortType(typeName: string): string {
  return typeName.split(".").at(-1) ?? typeName;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  disabled: { opacity: 0.35 },
  inactive: { opacity: 0.48 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  headerButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  instanceStrip: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  instanceChip: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  instanceChipActive: { backgroundColor: colors.surfaceStrong, borderColor: colors.primary },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.live },
  mutedDot: { backgroundColor: colors.textMuted },
  instanceText: { ...typography.label, color: colors.text },
  viewerSection: { position: "relative" },
  viewerTop: { position: "absolute", top: spacing.sm, left: spacing.sm },
  transport: { flexDirection: "row", alignItems: "center", padding: spacing.sm },
  transportButtons: { flexDirection: "row", gap: spacing.xs },
  transportButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  transportDivider: {
    width: StyleSheet.hairlineWidth,
    height: 30,
    marginHorizontal: spacing.md,
    backgroundColor: colors.border,
  },
  takeControl: {
    flex: 1,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceStrong,
  },
  takeControlActive: { backgroundColor: colors.primary },
  takeControlText: { ...typography.label, color: colors.text },
  takeControlTextActive: { color: colors.primaryInk },
  errorCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderColor: colors.danger,
  },
  errorText: { ...typography.body, color: colors.danger, flex: 1 },
  segment: {
    flexDirection: "row",
    gap: 4,
    padding: 4,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  segmentButton: {
    flex: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xs,
    borderRadius: 9,
  },
  segmentActive: { backgroundColor: colors.surfaceStrong },
  segmentText: { ...typography.caption, fontSize: 10, color: colors.textMuted },
  segmentTextActive: { color: colors.text },
  panel: { gap: spacing.sm, padding: spacing.sm },
  search: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.xs,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  searchInput: { flex: 1, ...typography.body, color: colors.text },
  sceneHeader: {
    minHeight: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.xs,
  },
  sceneName: { ...typography.caption, color: colors.primary, flex: 1 },
  hierarchyRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingRight: spacing.md,
    borderRadius: 9,
  },
  hierarchySelected: { backgroundColor: "#34394A" },
  hierarchyText: { ...typography.body, color: colors.textSecondary, flex: 1 },
  hierarchyTextSelected: { color: colors.text },
  childCount: { ...typography.caption, color: colors.textMuted },
  panelEmpty: { alignItems: "center", gap: spacing.sm, paddingVertical: spacing.xxxl, paddingHorizontal: spacing.lg },
  panelEmptyTitle: { ...typography.heading, color: colors.text, textAlign: "center" },
  panelEmptyCopy: { ...typography.body, color: colors.textMuted, textAlign: "center" },
  assetRow: {
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  assetIcon: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 11,
    backgroundColor: "#37333F",
  },
  assetName: { ...typography.label, color: colors.text },
  assetPath: { ...typography.caption, color: colors.textMuted },
  assetType: { ...typography.mono, fontSize: 10, color: colors.textMuted },
  inspectorPanel: { gap: spacing.md, padding: spacing.sm },
  inspectorTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.sm,
  },
  objectIcon: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: "#383340",
  },
  objectName: { ...typography.heading, color: colors.text },
  objectMeta: { ...typography.caption, color: colors.textMuted },
  component: {
    overflow: "hidden",
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSoft,
    backgroundColor: colors.backgroundDeep,
  },
  componentHeader: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surfaceStrong,
  },
  componentName: { ...typography.label, color: colors.text },
  componentType: { ...typography.caption, color: colors.textMuted },
  property: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSoft,
  },
  propertyCopy: { flex: 1, paddingRight: spacing.md },
  propertyName: { ...typography.label, color: colors.text },
  propertyPath: { ...typography.caption, fontSize: 10, color: colors.textMuted },
  valueInput: {
    minWidth: 92,
    maxWidth: 154,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: 9,
    backgroundColor: colors.surface,
    color: colors.text,
    ...typography.mono,
    textAlign: "right",
  },
  readOnlyValue: { ...typography.mono, color: colors.textMuted, maxWidth: 142, textAlign: "right" },
  boolean: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: colors.primary,
  },
  booleanOff: {
    backgroundColor: colors.surfaceStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  enumButton: {
    maxWidth: 154,
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: 9,
    backgroundColor: colors.surface,
  },
  enumText: { ...typography.mono, color: colors.text, flexShrink: 1 },
  undoNote: { ...typography.caption, color: colors.textMuted, textAlign: "center", padding: spacing.sm },
});
