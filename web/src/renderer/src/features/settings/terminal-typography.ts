// MIT Copyright (c) 2026 Lovecast Inc.
// Ported from the Orca reference (read-only):
//   src/shared/terminal-fonts.ts
//     (DEFAULT_TERMINAL_FONT_WEIGHT[_BOLD], TERMINAL_FONT_WEIGHT_MIN/MAX/STEP,
//      normalizeTerminalFontWeight[_Bold], resolveTerminalFontWeights)
//   src/shared/constants.ts
//     (defaultTerminalFontFamily platform default)
//   src/renderer/src/components/settings/SettingsConstants.ts
//     (mergeFontSuggestions, getFallbackTerminalFonts)
//   src/renderer/src/components/settings/settings-form-option-filter.ts
//     (filterFontSuggestions, getRenderedFontSuggestions, 2KB query guard)
//   src/renderer/src/components/terminal-pane/layout-serialization.ts
//     (FALLBACK_FONTS monospace chain, buildFontFamily)
//   src/renderer/src/lib/editor-font-zoom.ts
//     (resolveEditorFontFamily: empty editor font follows the terminal font)
//   src/renderer/src/components/settings/terminal-typography-search.ts
//     (Font Size / Font Family / Font Weight search copy)
// Adapted: no i18n catalog (this repo uses literal copy); the query byte
// guard uses TextEncoder instead of shared/clipboard-text.

export const DEFAULT_TERMINAL_FONT_WEIGHT = 500;
export const DEFAULT_TERMINAL_FONT_WEIGHT_BOLD = 700;
export const TERMINAL_FONT_WEIGHT_MIN = 100;
export const TERMINAL_FONT_WEIGHT_MAX = 900;
export const TERMINAL_FONT_WEIGHT_STEP = 100;

/** Longest font-family string the settings envelope keeps (free text, validated). */
export const TERMINAL_FONT_FAMILY_MAX_LENGTH = 256;

function normalizeWeight(
  fontWeight: number | null | undefined,
  fallback: number,
): number {
  const numericFontWeight =
    typeof fontWeight === "number" ? fontWeight : Number.NaN;
  if (!Number.isFinite(numericFontWeight)) return fallback;
  return Math.min(
    TERMINAL_FONT_WEIGHT_MAX,
    Math.max(TERMINAL_FONT_WEIGHT_MIN, Math.round(numericFontWeight)),
  );
}

export function normalizeTerminalFontWeight(
  fontWeight: number | null | undefined,
): number {
  return normalizeWeight(fontWeight, DEFAULT_TERMINAL_FONT_WEIGHT);
}

export function normalizeTerminalFontWeightBold(
  fontWeight: number | null | undefined,
): number {
  return normalizeWeight(fontWeight, DEFAULT_TERMINAL_FONT_WEIGHT_BOLD);
}

// Numeric weight gaps do not guarantee distinct font faces, so bold stays independently configurable.
export function resolveTerminalFontWeights(
  fontWeight: number | null | undefined,
  fontWeightBold: number | null | undefined,
): { fontWeight: number; fontWeightBold: number } {
  return {
    fontWeight: normalizeTerminalFontWeight(fontWeight),
    fontWeightBold: normalizeTerminalFontWeightBold(fontWeightBold),
  };
}

/**
 * Source platform default (shared/constants.ts defaultTerminalFontFamily):
 * SF Mono on macOS, Cascadia Mono on Windows, DejaVu Sans Mono on Linux.
 * Takes the platform string explicitly so tests and non-DOM callers stay pure.
 */
export function defaultTerminalFontFamily(platform?: string): string {
  const normalized = (platform ?? "").toLowerCase();
  // Why win32-first with an anchored match: "darwin" contains "win", so an
  // unanchored substring check misclassifies macOS (source compares exact
  // process.platform values for the same reason).
  if (/^win/.test(normalized)) return "Cascadia Mono";
  if (normalized.includes("linux")) return "DejaVu Sans Mono";
  return "SF Mono";
}

/** Renderer platform default, detected like App does (user agent sniff). */
export function resolveDefaultTerminalFontFamily(): string {
  try {
    const userAgent =
      typeof navigator !== "undefined" ? (navigator.userAgent ?? "") : "";
    const platform =
      typeof navigator !== "undefined"
        ? ((navigator as Navigator & { userAgentData?: { platform?: string } })
            .userAgentData?.platform ??
          (navigator as Navigator & { platform?: string }).platform ??
          "")
        : "";
    if (/mac/i.test(userAgent) || /mac/i.test(platform)) return "SF Mono";
    if (/win/i.test(userAgent) || /win/i.test(platform))
      return "Cascadia Mono";
    if (/linux/i.test(userAgent) || /linux/i.test(platform))
      return "DejaVu Sans Mono";
    return defaultTerminalFontFamily(platform || userAgent);
  } catch {
    return "SF Mono";
  }
}

const NO_CONTROL_CHARS = /^[^\x00-\x1f\x7f]*$/;

/**
 * Persisted terminal font family guard: free text, never NUL/newline/control
 * (same rule as the harness bridge opaque fields). Empty means "no
 * preference" and falls through to the monospace fallback chain.
 */
export function isTerminalFontFamily(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= TERMINAL_FONT_FAMILY_MAX_LENGTH &&
    NO_CONTROL_CHARS.test(value)
  );
}

/**
 * Persisted editor font guard: empty (the default) keeps following
 * `terminalFontFamily` (source global-settings-types.ts editorFontFamily).
 */
export function isEditorFontFamily(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= TERMINAL_FONT_FAMILY_MAX_LENGTH &&
    NO_CONTROL_CHARS.test(value)
  );
}

/**
 * Why: the editor font is opt-in and defaults to empty, so an unset value must
 * keep falling back to the terminal font exactly as before the setting existed.
 */
export function resolveEditorFontFamily(settings?: {
  editorFontFamily?: string;
  terminalFontFamily?: string;
} | null): string {
  return (
    settings?.editorFontFamily?.trim() ||
    settings?.terminalFontFamily ||
    "monospace"
  );
}

// Cross-platform monospace chain: browsers skip fonts absent on the current OS, so listing all is safe.
// Nerd Fonts come last to cover PUA glyphs (U+E000–U+F8FF) from OMP/Powerline that standard monospace fonts lack.
const TERMINAL_FONT_FALLBACKS = [
  "SF Mono", // macOS 10.12+
  "Menlo", // macOS (older)
  "Monaco", // macOS (legacy)
  "Cascadia Mono", // Windows 11+
  "Consolas", // Windows Vista+
  "DejaVu Sans Mono", // Linux (common)
  "Liberation Mono", // Linux (common)
  "Orca Nerd Font Symbols", // bundled PUA fallback for OMP/Powerline glyphs
  "Symbols Nerd Font Mono", // purpose-built Nerd Fonts symbols-only fallback
  "MesloLGS Nerd Font", // p10k's recommended font; very common on zsh setups
  "JetBrainsMono Nerd Font", // widely installed; Ghostty ships a JBM-derived font
  "Hack Nerd Font", // common Nerd Font among Linux developers
  "monospace", // ultimate generic fallback
] as const;

/**
 * Builds the xterm `fontFamily` CSS stack: the configured family first, then
 * every fallback not already present (case-insensitive, no duplicates).
 * Generic keywords like "monospace" stay unquoted; named fonts are quoted.
 */
export function buildTerminalFontFamily(fontFamily: string): string {
  const trimmed = fontFamily.trim();
  const parts = trimmed ? [`"${trimmed}"`] : [];
  const lowerParts = parts.map((p) => p.toLowerCase());
  for (const fallback of TERMINAL_FONT_FALLBACKS) {
    const lower = fallback.toLowerCase();
    if (!lowerParts.some((p) => p.includes(lower))) {
      parts.push(fallback === "monospace" ? fallback : `"${fallback}"`);
    }
  }
  return parts.join(", ");
}

export function getFallbackTerminalFonts(): string[] {
  try {
    const userAgent =
      typeof navigator !== "undefined" ? (navigator.userAgent ?? "") : "";
    const nav =
      typeof navigator !== "undefined"
        ? (navigator as Navigator & { userAgentData?: { platform?: string } })
        : null;
    const platform = nav
      ? ((nav as { userAgentData?: { platform?: string } }).userAgentData
          ?.platform ??
        (nav as unknown as { platform?: string }).platform ??
        "")
      : "";
    const probe = `${platform} ${userAgent}`.toLowerCase();
    if (probe.includes("mac"))
      return ["SF Mono", "Menlo", "Monaco", "JetBrains Mono", "Fira Code"];
    if (probe.includes("win"))
      return [
        "Cascadia Mono",
        "Consolas",
        "Lucida Console",
        "JetBrains Mono",
        "Fira Code",
      ];
  } catch {
    // Fall through to the Linux list below.
  }
  return [
    "JetBrains Mono",
    "Fira Code",
    "DejaVu Sans Mono",
    "Liberation Mono",
    "Ubuntu Mono",
    "Noto Sans Mono",
  ];
}

/**
 * Merges system-enumerated fonts over the curated fallback + previously seen
 * fonts, deduped. The picker render can be capped later, but the source list
 * must keep every installed font searchable/selectable.
 */
export function mergeFontSuggestions(
  systemFonts: readonly string[],
  previousFonts: readonly string[],
): string[] {
  return Array.from(new Set([...systemFonts, ...previousFonts]));
}

export const SETTINGS_FORM_OPTION_QUERY_MAX_BYTES = 2 * 1024;
export const FONT_SUGGESTION_RENDER_LIMIT = 320;

function utf8ByteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

function normalizeFontSuggestionQuery(query: string): string | null {
  if (utf8ByteLength(query) > SETTINGS_FORM_OPTION_QUERY_MAX_BYTES)
    return null;
  return query.trim().toLowerCase();
}

export type RenderedFontSuggestion = {
  font: string;
  sourceIndex: number;
};

/** Starts-with first, then contains — stable within each group. */
export function filterFontSuggestions(
  suggestions: readonly string[],
  query: string,
): string[] {
  const normalizedQuery = normalizeFontSuggestionQuery(query);
  if (normalizedQuery === null) return [];
  if (!normalizedQuery) return [...suggestions];
  const startsWith: string[] = [];
  const includes: string[] = [];
  for (const font of suggestions) {
    const normalizedFont = font.toLowerCase();
    if (normalizedFont.startsWith(normalizedQuery)) startsWith.push(font);
    else if (normalizedFont.includes(normalizedQuery)) includes.push(font);
  }
  return [...startsWith, ...includes];
}

export function getRenderedFontSuggestions(
  suggestions: readonly string[],
  highlightedIndex: number,
  limit = FONT_SUGGESTION_RENDER_LIMIT,
): RenderedFontSuggestion[] {
  const cappedLength = Math.min(suggestions.length, limit);
  if (cappedLength <= 0) return [];
  const sourceIndexes = Array.from(
    { length: cappedLength },
    (_value, index) => index,
  );
  if (highlightedIndex >= cappedLength && highlightedIndex < suggestions.length) {
    sourceIndexes[cappedLength - 1] = highlightedIndex;
  }
  return sourceIndexes.map((sourceIndex) => ({
    font: suggestions[sourceIndex] ?? "",
    sourceIndex,
  }));
}

export type TerminalTypographySearchEntry = {
  title: string;
  description: string;
  keywords: readonly string[];
};

/** Source copy (terminal-typography-search.ts): the scannable typography rows. */
export function getTerminalTypographySearchEntries(): TerminalTypographySearchEntry[] {
  return [
    {
      title: "Font Size",
      description:
        "Default terminal font size for new panes and live updates.",
      keywords: ["terminal", "typography", "text size"],
    },
    {
      title: "Font Family",
      description:
        "Default terminal font family for new panes and live updates.",
      keywords: ["terminal", "typography", "font"],
    },
    {
      title: "Font Weight",
      description: "Controls the terminal text font weight.",
      keywords: ["terminal", "typography", "weight"],
    },
    {
      title: "Bold Font Weight",
      description:
        "Adjust independently from Font Weight. Some fonts map several values to one face, so lower Font Weight or choose another font if bold looks unchanged.",
      keywords: ["terminal", "typography", "weight", "bold"],
    },
    {
      title: "Editor Font Family",
      description:
        "Font used by file editors and diff views. Leave empty to follow the terminal font.",
      keywords: ["editor", "font", "typography", "family", "code"],
    },
  ];
}

/** Every whitespace-separated token must appear in some entry field. */
export function matchesTerminalTypographySearch(
  query: string,
  entries: readonly TerminalTypographySearchEntry[] = getTerminalTypographySearchEntries(),
): boolean {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized === "") return true;
  const haystack = entries
    .map((e) => [e.title, e.description, ...e.keywords].join(" "))
    .join(" ")
    .toLowerCase();
  return normalized.split(" ").every((token) => haystack.includes(token));
}

export type TerminalTypographySettings = {
  terminalFontSize?: number;
  terminalFontFamily?: string;
  terminalFontWeight?: number;
  terminalFontWeightBold?: number;
};

export type TerminalTypographyOptions = {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  fontWeightBold: number;
};

/**
 * Pure xterm option projection: normalizes weights (clamp 100-900, round),
 * keeps the persisted size, and expands the family into the CSS fallback
 * stack. TerminalPane and tests share this contract.
 */
export function projectTerminalTypographyOptions(
  settings: TerminalTypographySettings,
): TerminalTypographyOptions {
  const weights = resolveTerminalFontWeights(
    settings.terminalFontWeight,
    settings.terminalFontWeightBold,
  );
  return {
    fontFamily: buildTerminalFontFamily(settings.terminalFontFamily ?? ""),
    // Source fallback 14 for terminal panes (editors stay 13).
    fontSize: settings.terminalFontSize ?? 14,
    fontWeight: weights.fontWeight,
    fontWeightBold: weights.fontWeightBold,
  };
}

export type SystemFontListBridge = {
  listFonts(): Promise<string[]>;
};

/**
 * Best-effort system font enumeration through the preload bridge
 * (`drogon:fontsList`, main/fonts.ts, exposed as settings.listFonts like the
 * source's window.api.settings.listFonts). Resolves [] when the bridge is
 * absent (older builds, tests) so callers always fall back to the curated
 * list — never a rejection.
 */
export async function requestSystemFontFamilies(): Promise<string[]> {
  try {
    const settings = (
      window as unknown as {
        drogon?: { settings?: SystemFontListBridge };
      }
    ).drogon?.settings;
    if (!settings || typeof settings.listFonts !== "function") return [];
    const fonts = await settings.listFonts();
    return Array.isArray(fonts)
      ? fonts.filter((f): f is string => typeof f === "string" && f.length > 0)
      : [];
  } catch {
    return [];
  }
}
