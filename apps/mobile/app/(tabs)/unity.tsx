import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { Link } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
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
import { visibleUnityHierarchy } from "@/lib/unity-hierarchy";
import {
  friendlyUnityPropertyName,
  inspectorComponentScore,
  inspectorPropertyMatches,
  isCommonUnityProperty,
} from "@/lib/unity-inspector";
import { colors, radius, spacing, typography } from "@/theme/tokens";

type UnityTab = "hierarchy" | "inspector" | "assets";
type UnityViewKind = "game" | "scene";
type UnityCaptureView = {
  kind: UnityViewKind;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  pixelsPerPoint: number;
};
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
  captureViews: UnityCaptureView[];
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
  referenceType?: string;
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
  const [expandedHierarchyIds, setExpandedHierarchyIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [assetQuery, setAssetQuery] = useState("");
  const [viewKind, setViewKind] = useState<UnityViewKind>("game");
  const [error, setError] = useState<string | null>(null);
  const hierarchyRequest = useRef<string | null>(null);
  const assetsRequest = useRef<string | null>(null);
  const inspectorRequest = useRef<string | null>(null);
  const applyRequest = useRef<string | null>(null);
  const instancesRequest = useRef<string | null>(null);
  const remoteStream = useRemoteStream("unity", instanceId, viewKind);
  const selectedInstance = instances.find((instance) => instance.instanceId === instanceId) ?? null;

  useEffect(() => {
    const available = selectedInstance?.captureViews.map((view) => view.kind) ?? [];
    if (available.length > 0 && !available.includes(viewKind)) {
      setViewKind(available[0]);
    }
  }, [selectedInstance, viewKind]);

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
    setExpandedHierarchyIds(new Set());
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

  const filteredHierarchy = useMemo(
    () => visibleUnityHierarchy(hierarchy, expandedHierarchyIds, query),
    [expandedHierarchyIds, hierarchy, query],
  );
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
            label={selectedInstance ? `${capitalize(viewKind)} view` : "Waiting for Unity"}
            tone={selectedInstance ? "live" : "neutral"}
          />
        </View>
        {selectedInstance && selectedInstance.captureViews.length > 1 ? (
          <View style={styles.viewerPicker}>
            {(["game", "scene"] as const)
              .filter((kind) => selectedInstance.captureViews.some((view) => view.kind === kind))
              .map((kind) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: viewKind === kind }}
                  key={kind}
                  onPress={() => setViewKind(kind)}
                  style={[styles.viewerPickerButton, viewKind === kind && styles.viewerPickerActive]}
                >
                  <Text style={[styles.viewerPickerText, viewKind === kind && styles.viewerPickerTextActive]}>
                    {capitalize(kind)}
                  </Text>
                </Pressable>
              ))}
          </View>
        ) : null}
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
              {value === "assets" ? "Assets" : capitalize(value)}
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
                  <View
                    style={[
                      styles.hierarchyRow,
                      { paddingLeft: spacing.md + Math.min(node.depth, 8) * 16 },
                      selectedId === node.id && styles.hierarchySelected,
                      !node.active && styles.inactive,
                    ]}
                  >
                    {node.childCount > 0 ? (
                      <Pressable
                        accessibilityLabel={`${expandedHierarchyIds.has(node.id) ? "Collapse" : "Expand"} ${node.name}`}
                        accessibilityRole="button"
                        onPress={() =>
                          setExpandedHierarchyIds((current) => {
                            const next = new Set(current);
                            if (next.has(node.id)) next.delete(node.id);
                            else next.add(node.id);
                            return next;
                          })
                        }
                        style={styles.hierarchyToggle}
                      >
                        <MaterialCommunityIcons
                          color={colors.textSecondary}
                          name={expandedHierarchyIds.has(node.id) || query.trim() ? "chevron-down" : "chevron-right"}
                          size={18}
                        />
                      </Pressable>
                    ) : (
                      <View style={styles.hierarchyToggle} />
                    )}
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => inspectTarget(node.id, true)}
                      style={styles.hierarchyTarget}
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
                </View>
              );
            })
          )}
        </Card>
      ) : tab === "assets" ? (
        <Card style={styles.panel}>
          <SearchField placeholder="Search project assets" value={assetQuery} onChange={setAssetQuery} />
          {!selectedInstance ? (
            <PanelEmpty title="No Unity Editor connected" copy="Assets appear when the Editor package is online." />
          ) : assetsRequest.current && assets.length === 0 ? (
            <PanelEmpty title="Indexing project assets…" copy="Assets come directly from the connected Unity project." />
          ) : filteredAssets.length === 0 ? (
            <PanelEmpty title="No matching assets" copy="Try a script, prefab, material, model, or asset name." />
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
          assets={assets}
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
  assets,
  staged,
  hasControl,
  onStage,
  onApply,
}: {
  inspector: InspectorSnapshot | null;
  assets: AssetNode[];
  staged: StagedProperty | null;
  hasControl: boolean;
  onStage: (value: StagedProperty | null) => void;
  onApply: () => void;
}) {
  const [propertyQuery, setPropertyQuery] = useState("");
  const [expandedComponents, setExpandedComponents] = useState<Set<string>>(() => new Set());
  const [advancedComponents, setAdvancedComponents] = useState<Set<string>>(() => new Set());
  const groups = useMemo<ComponentSnapshot[]>(() => {
    if (!inspector) return [];
    return [
      {
        targetId: inspector.targetId,
        name: inspector.name,
        typeName: inspector.typeName,
        revision: inspector.revision,
        properties: inspector.properties,
      },
      ...inspector.components,
    ].filter((group) => group.properties.length > 0);
  }, [inspector]);
  const inspectorTargetId = inspector?.targetId;

  useEffect(() => {
    setPropertyQuery("");
    setAdvancedComponents(new Set());
    if (!inspectorTargetId) {
      setExpandedComponents(new Set());
      return;
    }
    const useful = [...groups]
      .sort(
        (left, right) =>
          inspectorComponentScore(right.typeName, right.properties) -
          inspectorComponentScore(left.typeName, left.properties),
      )
      .filter((group) => inspectorComponentScore(group.typeName, group.properties) > 0)
      .slice(0, 2)
      .map((group) => group.targetId);
    setExpandedComponents(
      new Set(useful.length > 0 ? useful : groups.slice(0, 1).map((group) => group.targetId)),
    );
  }, [groups, inspectorTargetId]);

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
  const normalizedQuery = propertyQuery.trim();
  const visibleGroups = groups
    .map((group) => {
      const common = group.properties.filter((property) =>
        isCommonUnityProperty(group.typeName, property),
      );
      const matching = group.properties.filter((property) =>
        inspectorPropertyMatches(group.typeName, property, normalizedQuery),
      );
      return {
        group,
        common,
        properties: normalizedQuery
          ? matching
          : advancedComponents.has(group.targetId)
            ? group.properties
            : common,
        editableCount: group.properties.filter((property) => !property.readOnly).length,
      };
    })
    .filter((entry) => !normalizedQuery || entry.properties.length > 0);

  return (
    <Card style={styles.inspectorPanel}>
      <View style={styles.inspectorTitle}>
        <View style={styles.objectIcon}>
          <MaterialCommunityIcons color={colors.primaryStrong} name="cube-scan" size={22} />
        </View>
        <View style={styles.grow}>
          <Text style={styles.objectName}>{inspector.name}</Text>
          <Text numberOfLines={1} style={styles.objectMeta}>
            {groups.length} {groups.length === 1 ? "component" : "components"} · {shortType(inspector.typeName)}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Collapse all inspector components"
          accessibilityRole="button"
          onPress={() => setExpandedComponents(new Set())}
          style={styles.inspectorIconButton}
        >
          <MaterialCommunityIcons color={colors.textMuted} name="collapse-all-outline" size={20} />
        </Pressable>
      </View>

      {staged ? (
        <View style={styles.stagedCard}>
          <View style={styles.stagedCopy}>
            <MaterialCommunityIcons color={colors.warning} name="pencil-circle" size={22} />
            <View style={styles.grow}>
              <Text style={styles.stagedTitle}>Change ready</Text>
              <Text numberOfLines={1} style={styles.stagedDetail}>
                {friendlyUnityPropertyName(staged.property)} · {remoteValueText(staged.value, staged.property)}
              </Text>
            </View>
            <Pressable
              accessibilityLabel="Discard staged inspector change"
              accessibilityRole="button"
              onPress={() => onStage(null)}
              style={styles.inspectorIconButton}
            >
              <MaterialCommunityIcons color={colors.textMuted} name="close" size={20} />
            </Pressable>
          </View>
          <ActionButton
            disabled={!hasControl}
            label={hasControl ? "Apply change in Unity" : "Take control to apply"}
            onPress={onApply}
          />
        </View>
      ) : null}

      <SearchField
        placeholder="Find a component or property"
        value={propertyQuery}
        onChange={setPropertyQuery}
      />
      <View style={styles.inspectorHintRow}>
        <MaterialCommunityIcons color={colors.primaryStrong} name="star-four-points-outline" size={16} />
        <Text style={styles.inspectorHint}>
          Showing useful fields first. Open All fields inside a component when you need Unity internals.
        </Text>
      </View>

      {visibleGroups.length === 0 ? (
        <PanelEmpty title="No matching fields" copy="Try a component name such as Text, Transform, or Renderer." />
      ) : (
        visibleGroups.map(({ group, common, properties, editableCount }) => {
          const expanded = normalizedQuery ? true : expandedComponents.has(group.targetId);
          const advanced = advancedComponents.has(group.targetId);
          return (
            <View key={group.targetId} style={styles.component}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() =>
                  setExpandedComponents((current) => toggleSetValue(current, group.targetId))
                }
                style={styles.componentHeader}
              >
                <View style={styles.componentIcon}>
                  <MaterialCommunityIcons
                    color={colors.primaryStrong}
                    name={componentIcon(group.typeName)}
                    size={18}
                  />
                </View>
                <View style={styles.grow}>
                  <Text style={styles.componentName}>{friendlyComponentName(group.typeName)}</Text>
                  <Text numberOfLines={1} style={styles.componentType}>
                    {common.length} useful · {editableCount} editable
                  </Text>
                </View>
                {staged?.targetId === group.targetId ? <View style={styles.stagedDot} /> : null}
                <MaterialCommunityIcons
                  color={colors.textMuted}
                  name={expanded ? "chevron-up" : "chevron-down"}
                  size={21}
                />
              </Pressable>

              {expanded ? (
                <View>
                  {!normalizedQuery ? (
                    <View style={styles.componentFilters}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: !advanced }}
                        onPress={() =>
                          setAdvancedComponents((current) => {
                            const next = new Set(current);
                            next.delete(group.targetId);
                            return next;
                          })
                        }
                        style={[styles.filterChip, !advanced && styles.filterChipActive]}
                      >
                        <Text style={[styles.filterChipText, !advanced && styles.filterChipTextActive]}>Useful</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: advanced }}
                        onPress={() =>
                          setAdvancedComponents((current) => {
                            const next = new Set(current);
                            next.add(group.targetId);
                            return next;
                          })
                        }
                        style={[styles.filterChip, advanced && styles.filterChipActive]}
                      >
                        <Text style={[styles.filterChipText, advanced && styles.filterChipTextActive]}>
                          All fields ({group.properties.length})
                        </Text>
                      </Pressable>
                    </View>
                  ) : null}

                  {properties.length === 0 ? (
                    <View style={styles.noUsefulFields}>
                      <Text style={styles.noUsefulFieldsText}>No commonly edited fields in this component.</Text>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() =>
                          setAdvancedComponents((current) => {
                            const next = new Set(current);
                            next.add(group.targetId);
                            return next;
                          })
                        }
                      >
                        <Text style={styles.showAllText}>Show all fields</Text>
                      </Pressable>
                    </View>
                  ) : (
                    properties.map((property) => {
                      const isStaged =
                        staged?.targetId === group.targetId && staged.property.path === property.path;
                      return (
                        <PropertyEditor
                          assets={assets}
                          isStaged={isStaged}
                          key={`${group.targetId}:${property.path}`}
                          property={property}
                          showMetadata={advanced || Boolean(normalizedQuery)}
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
                    })
                  )}
                </View>
              ) : null}
            </View>
          );
        })
      )}
      <Text style={styles.undoNote}>
        Every apply creates one Unity Undo step. Scene changes remain unsaved until you save in Unity.
      </Text>
    </Card>
  );
}

function PropertyEditor({
  property,
  assets,
  isStaged,
  showMetadata,
  stagedValue,
  onStage,
}: {
  property: RemoteProperty;
  assets: AssetNode[];
  isStaged: boolean;
  showMetadata: boolean;
  stagedValue?: RemoteValue;
  onStage: (value: RemoteValue) => void;
}) {
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [referenceQuery, setReferenceQuery] = useState("");
  const [enumPickerOpen, setEnumPickerOpen] = useState(false);
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
      "objectReference",
    ].includes(property.kind);

  const referenceAssets = useMemo(() => {
    if (property.kind !== "objectReference") return [];
    const expectedType = referenceTypeName(property.referenceType);
    const normalized = referenceQuery.trim().toLowerCase();
    return assets
      .filter((asset) => !expectedType || assetTypeMatches(asset.typeName, expectedType))
      .filter(
        (asset) =>
          !normalized ||
          asset.name.toLowerCase().includes(normalized) ||
          asset.path.toLowerCase().includes(normalized) ||
          asset.typeName.toLowerCase().includes(normalized),
      )
      .slice(0, 30);
  }, [assets, property.kind, property.referenceType, referenceQuery]);
  const assignedAsset = assets.find((asset) => asset.id === value.objectId);
  const vectorComponents = Array.isArray(value.components) ? value.components : null;
  const labels = vectorComponents ? componentLabels(property.kind, vectorComponents.length) : [];

  return (
    <View style={[styles.property, isStaged && styles.propertyStaged]}>
      <View style={styles.propertyHeader}>
        <View style={styles.propertyKindIcon}>
          <MaterialCommunityIcons
            color={isStaged ? colors.warning : colors.textMuted}
            name={propertyIcon(property.kind)}
            size={16}
          />
        </View>
        <View style={styles.grow}>
          <Text style={styles.propertyName}>{friendlyUnityPropertyName(property)}</Text>
          {showMetadata ? (
            <Text numberOfLines={1} style={styles.propertyPath}>
          {property.path} · {property.kind}
          {property.readOnly ? " · Read only" : ""}
            </Text>
          ) : null}
        </View>
        {isStaged ? <Text style={styles.stagedLabel}>CHANGED</Text> : null}
      </View>
      {property.kind === "boolean" ? (
        <View style={styles.booleanRow}>
          <Text style={styles.controlValueText}>{value.boolValue === true ? "On" : "Off"}</Text>
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
            <View style={[styles.booleanThumb, value.boolValue === true && styles.booleanThumbOn]} />
          </Pressable>
        </View>
      ) : property.kind === "objectReference" ? (
        <>
          <Pressable
            accessibilityLabel={`${property.displayName}: ${assignedAsset?.name ?? "None"}`}
            accessibilityRole="button"
            disabled={!editable}
            onPress={() => setReferencePickerOpen(true)}
            style={[styles.fullWidthControl, !editable && styles.disabled]}
          >
            <MaterialCommunityIcons color={colors.primaryStrong} name="database-search-outline" size={18} />
            <View style={styles.grow}>
              <Text numberOfLines={1} style={styles.controlValueText}>
                {assignedAsset?.name ?? (value.objectId ? "Assigned asset" : "None")}
              </Text>
              <Text numberOfLines={1} style={styles.controlHintText}>
                {referenceTypeName(property.referenceType) ?? "Unity asset"}
              </Text>
            </View>
            <MaterialCommunityIcons color={colors.textMuted} name="chevron-right" size={19} />
          </Pressable>
          <Modal
            animationType="slide"
            onRequestClose={() => setReferencePickerOpen(false)}
            presentationStyle="pageSheet"
            visible={referencePickerOpen}
          >
            <View style={styles.pickerSheet}>
              <View style={styles.pickerSheetHeader}>
                <View style={styles.grow}>
                  <Text style={styles.pickerSheetTitle}>Choose {friendlyUnityPropertyName(property)}</Text>
                  <Text style={styles.pickerSheetSubtitle}>
                    {referenceTypeName(property.referenceType) ?? "Compatible Unity assets"}
                  </Text>
                </View>
                <Pressable
                  accessibilityLabel="Close asset picker"
                  accessibilityRole="button"
                  onPress={() => setReferencePickerOpen(false)}
                  style={styles.inspectorIconButton}
                >
                  <MaterialCommunityIcons color={colors.text} name="close" size={22} />
                </Pressable>
              </View>
              <SearchField
                placeholder={`Search ${referenceTypeName(property.referenceType) ?? "assets"}`}
                value={referenceQuery}
                onChange={setReferenceQuery}
              />
              <ScrollView contentContainerStyle={styles.pickerSheetList}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    onStage({ kind: "objectReference", objectId: "" });
                    setReferencePickerOpen(false);
                  }}
                  style={styles.referenceOption}
                >
                  <MaterialCommunityIcons color={colors.textMuted} name="cancel" size={20} />
                  <Text style={styles.referenceOptionName}>None</Text>
                </Pressable>
                {referenceAssets.map((asset) => (
                  <Pressable
                    accessibilityRole="button"
                    key={asset.id}
                    onPress={() => {
                      onStage({ kind: "objectReference", objectId: asset.id });
                      setReferencePickerOpen(false);
                    }}
                    style={[
                      styles.referenceOption,
                      asset.id === value.objectId && styles.referenceOptionSelected,
                    ]}
                  >
                    <View style={styles.referenceOptionIcon}>
                      <MaterialCommunityIcons color={colors.primaryStrong} name="file-outline" size={19} />
                    </View>
                    <View style={styles.grow}>
                      <Text style={styles.referenceOptionName}>{asset.name}</Text>
                      <Text numberOfLines={1} style={styles.referenceOptionPath}>{asset.path}</Text>
                    </View>
                    {asset.id === value.objectId ? (
                      <MaterialCommunityIcons color={colors.primary} name="check-circle" size={20} />
                    ) : null}
                  </Pressable>
                ))}
                {referenceAssets.length === 0 ? (
                  <Text style={styles.referenceEmpty}>No compatible project assets found.</Text>
                ) : null}
              </ScrollView>
            </View>
          </Modal>
        </>
      ) : property.kind === "enum" && property.enumOptions.length > 0 ? (
        <>
          <Pressable
            accessibilityLabel={`${property.displayName}: ${remoteValueText(value, property)}`}
            accessibilityRole="button"
            disabled={!editable}
            onPress={() => setEnumPickerOpen(true)}
            style={[styles.fullWidthControl, !editable && styles.disabled]}
          >
            <Text numberOfLines={1} style={[styles.controlValueText, styles.grow]}>
              {remoteValueText(value, property)}
            </Text>
            <MaterialCommunityIcons color={colors.textMuted} name="chevron-right" size={19} />
          </Pressable>
          <ChoiceSheet
            onClose={() => setEnumPickerOpen(false)}
            onSelect={(index, option) => {
              onStage({ kind: "enum", intValue: index, stringValue: option });
              setEnumPickerOpen(false);
            }}
            options={property.enumOptions}
            selectedIndex={value.intValue ?? 0}
            title={friendlyUnityPropertyName(property)}
            visible={enumPickerOpen}
          />
        </>
      ) : editable && vectorComponents ? (
        <View style={styles.componentValueGrid}>
          {vectorComponents.map((component, index) => (
            <View key={`${property.path}:${labels[index]}`} style={styles.componentValueField}>
              <Text style={styles.componentValueLabel}>{labels[index]}</Text>
              <TextInput
                accessibilityLabel={`${property.displayName} ${labels[index]}`}
                keyboardType="numbers-and-punctuation"
                onChangeText={(text) => {
                  const next = [...vectorComponents];
                  next[index] = Number.parseFloat(text) || 0;
                  onStage({ kind: property.kind, components: next });
                }}
                selectTextOnFocus
                style={styles.componentValueInput}
                value={String(component)}
              />
            </View>
          ))}
        </View>
      ) : editable ? (
        <TextInput
          accessibilityLabel={property.displayName}
          keyboardType={property.kind === "string" ? "default" : "numbers-and-punctuation"}
          multiline={property.kind === "string"}
          onChangeText={(text) => onStage(remoteValueFromText(property.kind, text, value))}
          placeholder={property.kind === "string" ? "Enter text" : undefined}
          placeholderTextColor={colors.textMuted}
          selectTextOnFocus={property.kind !== "string"}
          style={[styles.valueInput, property.kind === "string" && styles.stringInput]}
          value={remoteValueText(value, property)}
        />
      ) : (
        <View style={styles.readOnlyBox}>
          <Text numberOfLines={2} style={styles.readOnlyValue}>{remoteValueText(value, property)}</Text>
        </View>
      )}
    </View>
  );
}

function ChoiceSheet({
  title,
  options,
  selectedIndex,
  visible,
  onSelect,
  onClose,
}: {
  title: string;
  options: string[];
  selectedIndex: number;
  visible: boolean;
  onSelect: (index: number, option: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible={visible}>
      <View style={styles.pickerSheet}>
        <View style={styles.pickerSheetHeader}>
          <View style={styles.grow}>
            <Text style={styles.pickerSheetTitle}>{title}</Text>
            <Text style={styles.pickerSheetSubtitle}>Choose one option</Text>
          </View>
          <Pressable
            accessibilityLabel="Close option picker"
            accessibilityRole="button"
            onPress={onClose}
            style={styles.inspectorIconButton}
          >
            <MaterialCommunityIcons color={colors.text} name="close" size={22} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.pickerSheetList}>
          {options.map((option, index) => (
            <Pressable
              accessibilityRole="button"
              key={`${option}:${index}`}
              onPress={() => onSelect(index, option)}
              style={[
                styles.choiceOption,
                index === selectedIndex && styles.referenceOptionSelected,
              ]}
            >
              <Text
                style={[
                  styles.choiceOptionText,
                  index === selectedIndex && styles.choiceOptionTextSelected,
                ]}
              >
                {option}
              </Text>
              {index === selectedIndex ? (
                <MaterialCommunityIcons color={colors.primary} name="check-circle" size={20} />
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
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
      captureViews: parseCaptureViews(entry.captureViews),
    }));
}

function parseCaptureViews(value: unknown): UnityCaptureView[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asRecord)
    .filter((view): view is Record<string, unknown> => view !== null)
    .filter(
      (view) =>
        (view.kind === "game" || view.kind === "scene") &&
        typeof view.width === "number" &&
        typeof view.height === "number" &&
        view.width > 1 &&
        view.height > 1,
    )
    .map((view) => ({
      kind: view.kind as UnityViewKind,
      title: stringValue(view.title) ?? capitalize(view.kind as string),
      x: numberValue(view.x),
      y: numberValue(view.y),
      width: numberValue(view.width),
      height: numberValue(view.height),
      pixelsPerPoint: numberValue(view.pixelsPerPoint) || 1,
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
        referenceType: stringValue(property.referenceType) ?? undefined,
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

function friendlyComponentName(typeName: string): string {
  const type = shortType(typeName);
  const names: Record<string, string> = {
    GameObject: "Object",
    RectTransform: "Rect Transform",
    TextMeshProUGUI: "Text",
    TextMeshPro: "Text",
    CanvasRenderer: "Canvas Renderer",
    AudioSource: "Audio Source",
  };
  return names[type] ?? type.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function componentIcon(typeName: string): keyof typeof MaterialCommunityIcons.glyphMap {
  const type = typeName.toLowerCase();
  if (type.includes("transform")) return "axis-arrow";
  if (type.includes("text")) return "format-text";
  if (type.includes("camera")) return "camera-outline";
  if (type.includes("light")) return "lightbulb-outline";
  if (type.includes("audio")) return "volume-high";
  if (type.includes("renderer") || type.includes("mesh")) return "cube-outline";
  if (type.includes("image") || type.includes("sprite")) return "image-outline";
  if (type.includes("button")) return "gesture-tap-button";
  return "puzzle-outline";
}

function propertyIcon(kind: string): keyof typeof MaterialCommunityIcons.glyphMap {
  if (kind === "boolean") return "toggle-switch-outline";
  if (kind === "string") return "format-text";
  if (kind === "objectReference") return "link-variant";
  if (kind === "color") return "palette-outline";
  if (kind === "enum") return "format-list-bulleted";
  if (kind.startsWith("vector") || kind === "quaternion") return "axis-arrow";
  if (kind.startsWith("rect") || kind.startsWith("bounds")) return "vector-square";
  if (kind === "integer" || kind === "number") return "numeric";
  return "code-tags";
}

function componentLabels(kind: string, count: number): string[] {
  const labels = kind === "color"
    ? ["R", "G", "B", "A"]
    : kind.startsWith("rect")
      ? ["X", "Y", "W", "H"]
      : kind.startsWith("bounds")
        ? ["X", "Y", "Z", "W", "H", "D"]
        : ["X", "Y", "Z", "W"];
  return Array.from({ length: count }, (_, index) => labels[index] ?? String(index + 1));
}

function toggleSetValue(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function referenceTypeName(serializedType?: string): string | null {
  if (!serializedType) return null;
  const pointer = /^PPtr<\$?(.+)>$/.exec(serializedType);
  return shortType(pointer?.[1] ?? serializedType);
}

function assetTypeMatches(assetType: string, expectedType: string): boolean {
  const actual = shortType(assetType).toLowerCase();
  const expected = shortType(expectedType).toLowerCase();
  return actual === expected || actual.endsWith(expected) || expected.endsWith(actual);
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
  viewerPicker: {
    position: "absolute",
    top: spacing.sm,
    right: spacing.sm,
    flexDirection: "row",
    gap: 3,
    padding: 3,
    borderRadius: radius.pill,
    backgroundColor: "rgba(20, 22, 29, 0.84)",
  },
  viewerPickerButton: { minHeight: 30, justifyContent: "center", paddingHorizontal: spacing.md, borderRadius: radius.pill },
  viewerPickerActive: { backgroundColor: colors.primary },
  viewerPickerText: { ...typography.caption, color: colors.textMuted },
  viewerPickerTextActive: { color: colors.primaryInk },
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
  hierarchyToggle: { width: 24, height: 40, alignItems: "center", justifyContent: "center" },
  hierarchyTarget: { flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm },
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
  inspectorIconButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  stagedCard: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.warning,
    backgroundColor: "#342E22",
  },
  stagedCopy: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  stagedTitle: { ...typography.label, color: colors.warning },
  stagedDetail: { ...typography.caption, color: colors.textSecondary },
  inspectorHintRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  inspectorHint: { ...typography.caption, color: colors.textMuted, flex: 1 },
  component: {
    overflow: "hidden",
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSoft,
    backgroundColor: colors.backgroundDeep,
  },
  componentHeader: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surfaceRaised,
  },
  componentIcon: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
  },
  componentName: { ...typography.label, color: colors.text },
  componentType: { ...typography.caption, color: colors.textMuted },
  stagedDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.warning },
  componentFilters: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSoft,
  },
  filterChip: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  filterChipActive: { backgroundColor: colors.primary },
  filterChipText: { ...typography.caption, color: colors.textMuted },
  filterChipTextActive: { color: colors.primaryInk },
  noUsefulFields: { gap: spacing.sm, padding: spacing.lg, alignItems: "center" },
  noUsefulFieldsText: { ...typography.body, color: colors.textMuted, textAlign: "center" },
  showAllText: { ...typography.label, color: colors.primaryStrong },
  property: {
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSoft,
  },
  propertyStaged: { backgroundColor: "#302B22" },
  propertyHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  propertyKindIcon: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  propertyCopy: { flex: 1, paddingRight: spacing.md },
  propertyName: { ...typography.label, color: colors.text },
  propertyPath: { ...typography.caption, fontSize: 10, color: colors.textMuted },
  stagedLabel: { ...typography.caption, fontSize: 9, color: colors.warning, letterSpacing: 0.6 },
  valueInput: {
    width: "100%",
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: 9,
    backgroundColor: colors.surface,
    color: colors.text,
    ...typography.mono,
    textAlign: "left",
  },
  stringInput: { minHeight: 88, maxHeight: 180, textAlignVertical: "top", paddingVertical: spacing.md },
  readOnlyBox: { minHeight: 40, justifyContent: "center", paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.background },
  readOnlyValue: { ...typography.mono, color: colors.textMuted },
  booleanRow: { minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  controlValueText: { ...typography.body, color: colors.text },
  controlHintText: { ...typography.caption, color: colors.textMuted },
  boolean: {
    width: 50,
    height: 30,
    padding: 3,
    alignItems: "flex-end",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  booleanOff: {
    backgroundColor: colors.surfaceStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  booleanThumb: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.textMuted, alignSelf: "flex-start" },
  booleanThumbOn: { backgroundColor: colors.primaryInk, alignSelf: "flex-end" },
  fullWidthControl: {
    width: "100%",
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  componentValueGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  componentValueField: { flexGrow: 1, flexBasis: 70, gap: spacing.xs },
  componentValueLabel: { ...typography.caption, color: colors.textMuted, textAlign: "center" },
  componentValueInput: {
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    color: colors.text,
    ...typography.mono,
    textAlign: "center",
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
  referenceEditor: { width: 170, alignItems: "stretch", paddingVertical: spacing.sm },
  referenceButton: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: 9,
    backgroundColor: colors.surface,
  },
  referenceButtonText: { ...typography.caption, color: colors.text, flex: 1 },
  referenceMenu: {
    marginTop: spacing.xs,
    padding: spacing.xs,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceStrong,
  },
  pickerSheet: { flex: 1, gap: spacing.md, padding: spacing.lg, backgroundColor: colors.backgroundDeep },
  pickerSheetHeader: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingTop: spacing.sm },
  pickerSheetTitle: { ...typography.heading, color: colors.text },
  pickerSheetSubtitle: { ...typography.body, color: colors.textMuted },
  pickerSheetList: { gap: spacing.xs, paddingBottom: spacing.xxxl },
  referenceOption: {
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  referenceOptionSelected: { backgroundColor: colors.primarySoft, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.primary },
  referenceOptionIcon: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.background },
  referenceOptionName: { ...typography.label, color: colors.text },
  referenceOptionPath: { ...typography.caption, color: colors.textMuted },
  referenceEmpty: { ...typography.caption, color: colors.textMuted, padding: spacing.md, textAlign: "center" },
  choiceOption: { minHeight: 54, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.surface },
  choiceOptionText: { ...typography.body, color: colors.textSecondary },
  choiceOptionTextSelected: { color: colors.text, fontWeight: "600" },
  undoNote: { ...typography.caption, color: colors.textMuted, textAlign: "center", padding: spacing.sm },
});
