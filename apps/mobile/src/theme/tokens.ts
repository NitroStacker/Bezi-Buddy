export const colors = {
  background: "#1B1A1A",
  backgroundDeep: "#141313",
  surface: "#242322",
  surfaceRaised: "#2D2C2A",
  surfaceStrong: "#393735",
  border: "#44413F",
  borderSoft: "#353331",
  text: "#F4F2EE",
  textSecondary: "#A7A39E",
  textMuted: "#77736E",
  primary: "#B8B0DD",
  primaryStrong: "#CEC7EF",
  primaryInk: "#25212F",
  live: "#45D483",
  warning: "#E0B35A",
  selection: "#4A7DFF",
  danger: "#FF746C",
  codeAdd: "#23563B",
  codeRemove: "#5A2D31",
  overlay: "rgba(15,14,14,0.76)",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 36,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

export const typography = {
  title: { fontSize: 30, lineHeight: 35, fontWeight: "700" as const },
  heading: { fontSize: 19, lineHeight: 24, fontWeight: "600" as const },
  body: { fontSize: 15, lineHeight: 21, fontWeight: "400" as const },
  label: { fontSize: 13, lineHeight: 17, fontWeight: "600" as const },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: "500" as const },
  mono: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: "Courier",
    fontWeight: "500" as const,
  },
} as const;
