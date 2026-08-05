export type UnityInspectorProperty = {
  path: string;
  displayName: string;
  kind: string;
  readOnly: boolean;
};

const EXACT_COMMON_PATHS = new Set([
  "m_IsActive",
  "m_Enabled",
  "m_LocalPosition",
  "m_LocalRotation",
  "m_LocalScale",
  "m_AnchorMin",
  "m_AnchorMax",
  "m_AnchoredPosition",
  "m_SizeDelta",
  "m_Pivot",
  "m_text",
  "m_fontAsset",
  "m_fontSize",
  "m_fontStyle",
  "m_fontColor",
  "m_enableAutoSizing",
  "m_HorizontalAlignment",
  "m_VerticalAlignment",
  "m_Sprite",
  "m_Color",
  "m_Material",
  "m_Interactable",
  "m_Transition",
  "m_TargetGraphic",
  "m_Clip",
  "m_PlayOnAwake",
  "m_Loop",
  "m_Volume",
  "m_Pitch",
]);

const FRIENDLY_NAMES: Record<string, string> = {
  m_IsActive: "Active",
  m_Enabled: "Enabled",
  m_LocalPosition: "Position",
  m_LocalRotation: "Rotation",
  m_LocalScale: "Scale",
  m_AnchorMin: "Anchor Min",
  m_AnchorMax: "Anchor Max",
  m_AnchoredPosition: "Position",
  m_SizeDelta: "Size",
  m_Pivot: "Pivot",
  m_text: "Text",
  m_fontAsset: "Font",
  m_fontSize: "Font Size",
  m_fontStyle: "Font Style",
  m_fontColor: "Text Color",
  m_enableAutoSizing: "Auto Size",
  m_HorizontalAlignment: "Horizontal Alignment",
  m_VerticalAlignment: "Vertical Alignment",
  m_Sprite: "Sprite",
  m_Color: "Color",
  m_Material: "Material",
  m_Interactable: "Interactable",
  m_Transition: "Transition",
  m_TargetGraphic: "Target Graphic",
};

const COMMON_KEYWORDS = [
  "position",
  "rotation",
  "scale",
  "size",
  "color",
  "font",
  "text",
  "sprite",
  "material",
  "enabled",
  "interactable",
  "volume",
  "pitch",
  "loop",
  "speed",
  "duration",
];

export function friendlyUnityPropertyName(property: UnityInspectorProperty): string {
  const exact = FRIENDLY_NAMES[property.path];
  if (exact) return exact;
  const display = property.displayName.trim();
  if (display && !/^m[_ ]/i.test(display)) {
    return titleCase(
      display.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " "),
    );
  }
  return titleCase(
    property.path
      .replace(/^m_/, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " "),
  );
}

export function isCommonUnityProperty(
  componentType: string,
  property: UnityInspectorProperty,
): boolean {
  if (property.readOnly || property.path === "m_Script" || property.kind === "Generic") {
    return false;
  }
  if (EXACT_COMMON_PATHS.has(property.path)) return true;
  const haystack = `${property.path} ${property.displayName}`.toLowerCase();
  return COMMON_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

export function inspectorPropertyMatches(
  componentType: string,
  property: UnityInspectorProperty,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${componentType} ${property.path} ${property.displayName} ${property.kind}`
    .toLowerCase()
    .includes(normalized);
}

export function inspectorComponentScore(
  componentType: string,
  properties: UnityInspectorProperty[],
): number {
  const common = properties.filter((property) =>
    isCommonUnityProperty(componentType, property),
  );
  const type = componentType.toLowerCase();
  const typeBoost = /text|transform|camera|light|renderer|image|button|audio/.test(type)
    ? 20
    : 0;
  return common.length * 10 + typeBoost;
}

function titleCase(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
