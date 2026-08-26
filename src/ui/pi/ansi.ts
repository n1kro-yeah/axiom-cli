export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const ACCENT_RGB: Record<string, Rgb> = {
  violet: { r: 139, g: 92, b: 246 },
  cyan: { r: 6, g: 182, b: 212 },
  magenta: { r: 236, g: 72, b: 153 },
  green: { r: 34, g: 197, b: 94 },
  yellow: { r: 234, g: 179, b: 8 },
  blue: { r: 59, g: 130, b: 246 },
  red: { r: 239, g: 68, b: 68 }
};

export type AccentName = keyof typeof ACCENT_RGB;

export const ACCENT_NAMES = Object.keys(ACCENT_RGB) as AccentName[];

function fg(rgb: Rgb): string {
  return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
}

function boldFg(rgb: Rgb): string {
  return `\x1b[1m${fg(rgb)}`;
}

function apply(open: string, close: string): (text: string) => string {
  return (text: string) => `${open}${text}${close}`;
}

export interface AnsiTheme {
  accent: (text: string) => string;
  accentBright: (text: string) => string;
  success: (text: string) => string;
  ok: (text: string) => string;
  warning: (text: string) => string;
  danger: (text: string) => string;
  error: (text: string) => string;
  info: (text: string) => string;
  muted: (text: string) => string;
  faint: (text: string) => string;
  text: (text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
  italic: (text: string) => string;
  underline: (text: string) => string;
  inverse: (text: string) => string;
  diffAdd: (text: string) => string;
  diffDel: (text: string) => string;
  diffMeta: (text: string) => string;
}

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const INVERSE = "\x1b[7m";

export function makeAnsiTheme(accentName: AccentName): AnsiTheme {
  const accentRgb = ACCENT_RGB[accentName] ?? ACCENT_RGB.violet;
  const brightRgb = lighten(accentRgb, 1.35);

  const okRgb: Rgb = { r: 74, g: 222, b: 128 };
  const warnRgb: Rgb = { r: 234, g: 179, b: 8 };
  const errRgb: Rgb = { r: 248, g: 113, b: 113 };
  const infoRgb: Rgb = { r: 56, g: 189, b: 248 };
  const addRgb: Rgb = { r: 34, g: 197, b: 94 };
  const delRgb: Rgb = { r: 239, g: 68, b: 68 };
  const metaRgb: Rgb = { r: 100, g: 116, b: 139 };
  const textRgb: Rgb = { r: 226, g: 232, b: 240 };
  const mutedRgb: Rgb = { r: 148, g: 163, b: 184 };
  const faintRgb: Rgb = { r: 100, g: 116, b: 139 };

  return {
    accent: apply(fg(accentRgb), RESET),
    accentBright: apply(boldFg(brightRgb), RESET),
    success: apply(fg(okRgb), RESET),
    ok: apply(fg(okRgb), RESET),
    warning: apply(fg(warnRgb), RESET),
    danger: apply(fg(errRgb), RESET),
    error: apply(fg(errRgb), RESET),
    info: apply(fg(infoRgb), RESET),
    muted: apply(fg(mutedRgb), RESET),
    faint: apply(fg(faintRgb), RESET),
    text: apply(fg(textRgb), RESET),
    bold: apply(BOLD, RESET),
    dim: apply(DIM, RESET),
    italic: apply(ITALIC, RESET),
    underline: apply(UNDERLINE, RESET),
    inverse: apply(INVERSE, RESET),
    diffAdd: apply(fg(addRgb), RESET),
    diffDel: apply(fg(delRgb), RESET),
    diffMeta: apply(fg(metaRgb), RESET)
  };
}

function lighten(rgb: Rgb, factor: number): Rgb {
  return {
    r: Math.min(255, Math.round(rgb.r * factor)),
    g: Math.min(255, Math.round(rgb.g * factor)),
    b: Math.min(255, Math.round(rgb.b * factor))
  };
}

export function resolveAccentName(value: string | undefined): AccentName {
  if (value && value in ACCENT_RGB) return value as AccentName;
  return "violet";
}
