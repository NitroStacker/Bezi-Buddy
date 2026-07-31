export const colors = {
  background: "#1B1A19",
  backgroundDeep: "#151413",
  surface: "#242321",
  surfaceRaised: "#2B2927",
  surfaceStrong: "#393633",
  border: "#48443F",
  borderSoft: "#34312E",
  text: "#F2EFE9",
  textSecondary: "#B8B2A9",
  textMuted: "#89837A",
  primary: "#D6CFF2",
  primaryStrong: "#E4DEFF",
  primaryInk: "#27232F",
  primarySoft: "#34303E",
  brand: "#F47745",
  brandStrong: "#FF8A57",
  brandInk: "#24170F",
  live: "#4CCB84",
  warning: "#E0B35A",
  selection: "#7BA6F6",
  danger: "#F47A72",
  codeAdd: "#23563B",
  codeRemove: "#5A2D31",
  overlay: "rgba(12,11,10,0.78)",
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
  sm: 5,
  md: 7,
  lg: 10,
  pill: 999,
} as const;

export const typography = {
  title: { fontSize: 28, lineHeight: 33, fontWeight: "700" as const },
  heading: { fontSize: 18, lineHeight: 23, fontWeight: "600" as const },
  body: { fontSize: 15, lineHeight: 21, fontWeight: "400" as const },
  label: { fontSize: 13, lineHeight: 17, fontWeight: "600" as const },
  caption: { fontSize: 11.5, lineHeight: 16, fontWeight: "500" as const },
  mono: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: "Courier",
    fontWeight: "500" as const,
  },
} as const;
