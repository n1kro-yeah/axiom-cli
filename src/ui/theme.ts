import { createContext, useContext } from "react";

export type AccentName = "violet" | "cyan" | "magenta" | "green" | "yellow" | "blue" | "red";

interface AccentPalette {
  primary: string;
  bright: string;
  dim: string;
  faint: string;
}

const ACCENTS: Record<AccentName, AccentPalette> = {
  violet: { primary: "#8b5cf6", bright: "#a78bfa", dim: "#6d28d9", faint: "#4c1d95" },
  cyan: { primary: "#06b6d4", bright: "#67e8f9", dim: "#0e7490", faint: "#155e75" },
  magenta: { primary: "#ec4899", bright: "#f9a8d4", dim: "#be185d", faint: "#831843" },
  green: { primary: "#22c55e", bright: "#86efac", dim: "#15803d", faint: "#14532d" },
  yellow: { primary: "#eab308", bright: "#fde047", dim: "#a16207", faint: "#713f12" },
  blue: { primary: "#3b82f6", bright: "#93c5fd", dim: "#1d4ed8", faint: "#1e3a8a" },
  red: { primary: "#ef4444", bright: "#fca5a5", dim: "#b91c1c", faint: "#7f1d1d" }
};

export const ACCENT_NAMES = Object.keys(ACCENTS) as AccentName[];

export interface Theme {
  accentName: AccentName;
  accent: string;
  accentBright: string;
  accentDim: string;
  accentFaint: string;

  success: string;
  warning: string;
  danger: string;
  info: string;

  textPrimary: string;
  textSecondary: string;
  textDim: string;
  textFaint: string;

  border: string;
  borderActive: string;
  overlayBorder: string;

  toolPending: string;
  toolRunning: string;
  toolDone: string;
  toolError: string;

  diffAdd: string;
  diffDel: string;
  diffMeta: string;

  gaugeOk: string;
  gaugeWarn: string;
  gaugeCritical: string;
}

function buildTheme(accent: AccentName): Theme {
  const palette = ACCENTS[accent] ?? ACCENTS.violet;
  return {
    accentName: accent,
    accent: palette.primary,
    accentBright: palette.bright,
    accentDim: palette.dim,
    accentFaint: palette.faint,

    success: "#22c55e",
    warning: "#eab308",
    danger: "#ef4444",
    info: "#38bdf8",

    textPrimary: "#e2e8f0",
    textSecondary: "#94a3b8",
    textDim: "#64748b",
    textFaint: "#475569",

    border: "#334155",
    borderActive: palette.primary,
    overlayBorder: palette.dim,

    toolPending: "#eab308",
    toolRunning: palette.bright,
    toolDone: "#4ade80",
    toolError: "#f87171",

    diffAdd: "#22c55e",
    diffDel: "#ef4444",
    diffMeta: "#64748b",

    gaugeOk: "#22c55e",
    gaugeWarn: "#eab308",
    gaugeCritical: "#ef4444"
  };
}

export const THEME_CACHE = new Map<AccentName, Theme>();

export function getTheme(accent: AccentName): Theme {
  const cached = THEME_CACHE.get(accent);
  if (cached) return cached;
  const built = buildTheme(accent);
  THEME_CACHE.set(accent, built);
  return built;
}

export interface ThemeContextValue {
  theme: Theme;
  setAccent: (accent: AccentName) => void;
}

export const ThemeContext = createContext<ThemeContextValue>({
  theme: getTheme("violet"),
  setAccent: () => undefined
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

export interface SpinnerFrames {
  frames: string[];
  intervalMs: number;
}

export const SPINNER_VARIANTS: Record<string, SpinnerFrames> = {
  dots: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 80 },
  line: { frames: ["|", "/", "-", "\\"], intervalMs: 130 },
  pulse: { frames: ["●", "◐", "○", "◑"], intervalMs: 200 },
  orbit: { frames: ["✶", "✸", "✹", "✺", "✹", "✷"], intervalMs: 120 }
};

export function statusColor(status: string, theme: Theme): string {
  switch (status) {
    case "idle":
      return theme.textSecondary;
    case "streaming":
      return theme.accentBright;
    case "executing_tools":
      return theme.info;
    case "waiting_permission":
      return theme.warning;
    case "compacting":
      return theme.accentDim;
    case "error":
      return theme.danger;
    case "aborted":
      return theme.textDim;
    default:
      return theme.textPrimary;
  }
}
