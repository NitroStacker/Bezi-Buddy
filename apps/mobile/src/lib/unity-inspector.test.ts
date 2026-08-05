import { describe, expect, it } from "vitest";
import {
  friendlyUnityPropertyName,
  inspectorComponentScore,
  inspectorPropertyMatches,
  isCommonUnityProperty,
} from "./unity-inspector";

const property = (path: string, kind = "string", readOnly = false) => ({
  path,
  displayName: path,
  kind,
  readOnly,
});

describe("mobile Unity inspector", () => {
  it("promotes the fields people actually edit on text components", () => {
    expect(isCommonUnityProperty("TMPro.TextMeshProUGUI", property("m_text"))).toBe(true);
    expect(
      isCommonUnityProperty(
        "TMPro.TextMeshProUGUI",
        property("m_fontAsset", "objectReference"),
      ),
    ).toBe(true);
    expect(isCommonUnityProperty("TMPro.TextMeshProUGUI", property("m_Script", "objectReference", true))).toBe(false);
    expect(isCommonUnityProperty("TMPro.TextMeshProUGUI", property("m_characterSpacing", "number"))).toBe(false);
  });

  it("turns serialized paths into concise mobile labels", () => {
    expect(friendlyUnityPropertyName(property("m_LocalPosition", "vector3"))).toBe("Position");
    expect(friendlyUnityPropertyName(property("customMoveSpeed", "number"))).toBe("Custom Move Speed");
  });

  it("searches raw and friendly Unity metadata", () => {
    expect(inspectorPropertyMatches("UnityEngine.Transform", property("m_LocalScale", "vector3"), "scale")).toBe(true);
    expect(inspectorPropertyMatches("UnityEngine.Transform", property("m_LocalScale", "vector3"), "font")).toBe(false);
  });

  it("ranks focused visual components ahead of noisy internals", () => {
    expect(
      inspectorComponentScore("TMPro.TextMeshProUGUI", [
        property("m_text"),
        property("m_fontAsset", "objectReference"),
      ]),
    ).toBeGreaterThan(inspectorComponentScore("Custom.DebugState", [property("m_Cache", "Generic", true)]));
  });
});
