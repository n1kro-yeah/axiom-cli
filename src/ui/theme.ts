export type AccentName = "violet" | "cyan" | "magenta" | "green" | "yellow" | "blue" | "red";

export const ACCENT_NAMES: AccentName[] = ["violet", "cyan", "magenta", "green", "yellow", "blue", "red"];

export interface AccentPalette {
  primary: string;
  bright: string;
  dim: string;
  faint: string;
}

export const ACCENTS: Record<AccentName, AccentPalette> = {
  violet: { primary: "#8b5cf6", bright: "#a78bfa", dim: "#6d28d9", faint: "#4c1d95" },
  cyan: { primary: "#06b6d4", bright: "#67e8f9", dim: "#0e7490", faint: "#155e75" },
  magenta: { primary: "#ec4899", bright: "#f9a8d4", dim: "#be185d", faint: "#831843" },
  green: { primary: "#22c55e", bright: "#86efac", dim: "#15803d", faint: "#14532d" },
  yellow: { primary: "#eab308", bright: "#fde047", dim: "#a16207", faint: "#713f12" },
  blue: { primary: "#3b82f6", bright: "#93c5fd", dim: "#1d4ed8", faint: "#1e3a8a" },
  red: { primary: "#ef4444", bright: "#fca5a5", dim: "#b91c1c", faint: "#7f1d1d" }
};

export function getAccentPalette(accent: AccentName): AccentPalette {
  return ACCENTS[accent] ?? ACCENTS.violet;
}
