// Renderer settings store for the V2 settings UX. Implements the frozen
// SP-contract distinctions from docs/migration/parity-settings-persistence-contracts.md:
// ordered precedence defaults < persisted < migration < launchOverride, where
// explicit false, absent and migration stamps are different states; 1s save
// debounce with a 5s maximum pending delay; storage reads/writes are guarded
// (no durability or encryption promise).
//
// Scope: the UI-chrome subset plus the J10 settings additions (terminal font
// size, default harness, per-harness launch defaults, and the fork-shaped
// notification master/event switches). Anchored to the frozen catalog
// docs/migration/parity-settings-properties.json (schema
// drogon.parity-settings-properties/2): `theme` is declared
// 'system' | 'dark' | 'light' with builder default 'system'. `inspectorVisible`
// and `locale` are provisional renderer keys (the catalog has no inspector
// field; `uiLanguage` exists but its locale mapping is unverified). The
// catalog's statusNote: per-field UI mapping for the full 214-field catalog is
// unverified — do NOT claim full closure from this file.
//
// Extension point for the remaining catalog fields: extend SettingsSubset and
// SETTINGS_DEFAULTS (anchor each default to the catalog builder default), add
// one field guard in parsePersistedSettings, and mirror it in serializeState
// if it needs more than plain JSON. mergeSettingLayers, the debounce and the
// storage key need no changes.

import {
  isEditorFontFamily,
  isTerminalFontFamily,
  normalizeTerminalFontWeight,
  normalizeTerminalFontWeightBold,
  resolveDefaultTerminalFontFamily,
} from "./features/settings/terminal-typography";
import {
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
  normalizeDesktopTerminalScrollbackRows,
} from "./features/terminal/terminal-scrollback-policy";

export type Theme = "system" | "dark" | "light";

/** Source vocabulary (global-settings-types.ts): terminal GPU acceleration mode. */
export type TerminalGpuAcceleration = "auto" | "on" | "off";

/** Permission mode vocabulary shared with the harness launch form (inherit = prompts, unattended = skip). */
export type HarnessPermissionMode = "inherit" | "unattended";

/**
 * Per-harness launch defaults (journey J10). Empty model/effort means "no
 * preference" (the launch menu sends the key as absent, i.e. harness
 * default); permissionMode always has an explicit value.
 */
export type HarnessAgentDefault = {
  model: string;
  effort: string;
  permissionMode: HarnessPermissionMode;
};

export const EMPTY_HARNESS_AGENT_DEFAULT: HarnessAgentDefault = {
  model: "",
  effort: "",
  permissionMode: "inherit",
};

export type SettingsSubset = {
  theme: Theme;
  inspectorVisible: boolean;
  locale: string;
  /** Terminal font size in px; consumed by the terminal surface CSS hook. */
  terminalFontSize: number;
  /** Terminal wheel multiplier for normal scrollback (source default 1.15). */
  terminalScrollSensitivity: number;
  /** Terminal wheel multiplier while Alt is held (source default 5). */
  terminalFastScrollSensitivity: number;
  /** Discrete wheel reports for fullscreen TUIs (source default 1). */
  terminalTuiScrollSensitivity: number;
  /** Windows convention: right-click pastes; Ctrl+right-click opens the menu. */
  terminalRightClickToPaste: boolean;
  /** Hovering a terminal pane focuses it without a click. */
  terminalFocusFollowsMouse: boolean;
  /** Copy terminal selections to the system clipboard automatically. */
  terminalClipboardOnSelect: boolean;
  /** Allow terminal programs to write clipboard data through OSC 52. */
  terminalAllowOsc52Clipboard: boolean;
  /** Rows retained in xterm scrollback. */
  terminalScrollbackRows: number;
  /** Characters treated as word boundaries for double-click selection; empty uses xterm's default. */
  terminalWordSeparator: string;
  /** macOS Option behavior: auto, both, one side, or off. */
  terminalMacOptionAsAlt: "auto" | "true" | "false" | "left" | "right";
  /** Rewrite the physical macOS JIS Yen key as a backslash. */
  terminalJISYenToBackslash: boolean;
  /**
   * Terminal font family (source terminalFontFamily). Empty means no
   * preference; xterm falls through to the monospace fallback chain.
   */
  terminalFontFamily: string;
  /** Terminal regular text weight, normalized to 100-900 (source default 500). */
  terminalFontWeight: number;
  /** Terminal bold text weight, normalized to 100-900 (source default 700). */
  terminalFontWeightBold: number;
  /**
   * Opt-in code-editor font; empty (the default) keeps following
   * `terminalFontFamily` (source editorFontFamily).
   */
  editorFontFamily: string;
  /** Default harness for the "+" launch menu; "" means no default. */
  defaultHarnessId: string;
  /** Per-harness launch defaults keyed by harness id; absent key = all defaults. */
  harnessDefaults: Record<string, HarnessAgentDefault>;
  /** Master switch for native notifications (`enabled` in the fork). */
  notifyOnAgentNeedsInput: boolean;
  /** Fork event toggles; absent persisted values use the fork defaults. */
  notifyOnAgentTaskComplete: boolean;
  notifyOnTerminalBell: boolean;
  notifySuppressWhenFocused: boolean;
  /** Terminal renderer policy: auto/on/off xterm.js WebGL gate (source terminalGpuAcceleration). */
  terminalGpuAcceleration: TerminalGpuAcceleration;
  // R14-B appearance flags (source global-settings showTasksButton /
  // showAutomationsButton / showTitlebarAppName + persisted-UI-state
  // statusBarVisible, all default-on): the shell and the native View >
  // Appearance submenu read these.
  statusBarVisible: boolean;
  tasksButtonVisible: boolean;
  automationsButtonVisible: boolean;
  titlebarAppNameVisible: boolean;
};

/** localStorage shape the store needs; injectable for tests and alternative stores. */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function defaultTerminalRightClickToPaste(): boolean {
  if (
    typeof navigator !== "undefined" &&
    /Windows/i.test(navigator.userAgent)
  ) {
    return true;
  }
  return typeof process !== "undefined" && process.platform === "win32";
}

export const SETTINGS_DEFAULTS: SettingsSubset = {
  theme: "system",
  inspectorVisible: true,
  locale: "en",
  // Source defaults (pane-terminal-options.ts and pane-terminal-mouse-wheel.ts).
  terminalFontSize: 14,
  terminalScrollSensitivity: 1.15,
  terminalFastScrollSensitivity: 5,
  terminalTuiScrollSensitivity: 1,
  terminalRightClickToPaste: defaultTerminalRightClickToPaste(),
  terminalFocusFollowsMouse: false,
  terminalClipboardOnSelect: false,
  terminalAllowOsc52Clipboard: true,
  terminalScrollbackRows: DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
  terminalWordSeparator: "",
  terminalMacOptionAsAlt: "auto",
  terminalJISYenToBackslash: false,
  terminalFontFamily: resolveDefaultTerminalFontFamily(),
  terminalFontWeight: 500,
  terminalFontWeightBold: 700,
  editorFontFamily: "",
  defaultHarnessId: "",
  harnessDefaults: {},
  notifyOnAgentNeedsInput: true,
  notifyOnAgentTaskComplete: true,
  notifyOnTerminalBell: false,
  notifySuppressWhenFocused: true,
  terminalGpuAcceleration: "auto",
  statusBarVisible: true,
  tasksButtonVisible: true,
  automationsButtonVisible: true,
  titlebarAppNameVisible: true,
};

const DEBOUNCE_MS = 1000;
const MAX_PENDING_MS = 5000;

export function settingsStorageKey(namespace: string): string {
  return `drogon:settings:${namespace}`;
}
/**
 * Applies layers in order; a key that is absent (undefined) in an upper layer
 * never overrides lower layers, so an explicit false survives migrations that
 * leave the key untouched.
 */
export function mergeSettingLayers(input: {
  defaults: SettingsSubset;
  persisted?: Partial<SettingsSubset> | null;
  migration?: Partial<SettingsSubset> | null;
  launchOverride?: Partial<SettingsSubset> | null;
}): SettingsSubset {
  const merged: SettingsSubset = { ...input.defaults };
  const record = merged as Record<keyof SettingsSubset, unknown>;
  for (const layer of [
    input.persisted,
    input.migration,
    input.launchOverride,
  ]) {
    if (!layer) continue;
    for (const key of Object.keys(merged) as (keyof SettingsSubset)[]) {
      const value = layer[key];
      if (value !== undefined) record[key] = value;
    }
  }
  return merged;
}

function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "dark" || value === "light";
}

// Same control-character rule as the harness bridge's opaque fields
// (bridge-validation.ts): free text, never NUL/newline/control.
const NO_CONTROL_CHARS = /^[^\x00-\x1f\x7f]*$/;

function isTerminalFontSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 9 &&
    value <= 32
  );
}

function parseTerminalFontWeight(
  value: unknown,
  normalize: (weight: number | null | undefined) => number,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return normalize(value);
}

function normalizeTerminalScrollSensitivity(value: number): number {
  return Math.min(10, Math.max(0.1, value));
}

function normalizeTerminalFastScrollSensitivity(value: number): number {
  return Math.min(20, Math.max(1, value));
}

function normalizeTerminalTuiScrollSensitivity(value: number): number {
  return Math.round(Math.min(10, Math.max(1, value)));
}

function parseFiniteTerminalNumber(
  value: unknown,
  normalize: (value: number) => number,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return normalize(value);
}

function isDefaultHarnessId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    NO_CONTROL_CHARS.test(value)
  );
}

function isPermissionMode(value: unknown): value is HarnessPermissionMode {
  return value === "inherit" || value === "unattended";
}

function isGpuAcceleration(value: unknown): value is TerminalGpuAcceleration {
  return value === "auto" || value === "on" || value === "off";
}

function isMacOptionAsAlt(
  value: unknown,
): value is SettingsSubset["terminalMacOptionAsAlt"] {
  return (
    value === "auto" ||
    value === "true" ||
    value === "false" ||
    value === "left" ||
    value === "right"
  );
}

function parseHarnessAgentDefault(value: unknown): HarnessAgentDefault | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.model !== "string" ||
    candidate.model.length > 4096 ||
    !NO_CONTROL_CHARS.test(candidate.model)
  )
    return null;
  if (
    typeof candidate.effort !== "string" ||
    candidate.effort.length > 256 ||
    !NO_CONTROL_CHARS.test(candidate.effort)
  )
    return null;
  if (!isPermissionMode(candidate.permissionMode)) return null;
  return {
    model: candidate.model,
    effort: candidate.effort,
    permissionMode: candidate.permissionMode,
  };
}

function parseHarnessDefaults(value: unknown): Record<string, HarnessAgentDefault> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length > 16) return null;
  const out: Record<string, HarnessAgentDefault> = {};
  for (const key of keys) {
    if (key.length === 0 || key.length > 128 || !NO_CONTROL_CHARS.test(key))
      continue;
    const parsed = parseHarnessAgentDefault(candidate[key]);
    if (parsed) out[key] = parsed;
  }
  return out;
}

/**
 * Parses the persisted envelope { settings: {...} }. Anything malformed or
 * foreign (other schemas' envelopes, arrays, primitives) yields no overrides
 * instead of throwing; unknown or wrongly typed fields inside the envelope are
 * dropped individually.
 */
export function parsePersistedSettings(
  raw: string | null | undefined,
): Partial<SettingsSubset> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {};
    const settings = (parsed as { settings?: unknown }).settings;
    if (
      typeof settings !== "object" ||
      settings === null ||
      Array.isArray(settings)
    )
      return {};
    const candidate = settings as Record<string, unknown>;
    const out: Partial<SettingsSubset> = {};
    if (isTheme(candidate.theme)) out.theme = candidate.theme;
    if (typeof candidate.inspectorVisible === "boolean")
      out.inspectorVisible = candidate.inspectorVisible;
    if (typeof candidate.locale === "string" && candidate.locale.length > 0)
      out.locale = candidate.locale;
    if (isTerminalFontSize(candidate.terminalFontSize))
      out.terminalFontSize = candidate.terminalFontSize;
    {
      const value = parseFiniteTerminalNumber(
        candidate.terminalScrollSensitivity,
        normalizeTerminalScrollSensitivity,
      );
      if (value !== null) out.terminalScrollSensitivity = value;
    }
    {
      const value = parseFiniteTerminalNumber(
        candidate.terminalFastScrollSensitivity,
        normalizeTerminalFastScrollSensitivity,
      );
      if (value !== null) out.terminalFastScrollSensitivity = value;
    }
    {
      const value = parseFiniteTerminalNumber(
        candidate.terminalTuiScrollSensitivity,
        normalizeTerminalTuiScrollSensitivity,
      );
      if (value !== null) out.terminalTuiScrollSensitivity = value;
    }
    if (typeof candidate.terminalRightClickToPaste === "boolean")
      out.terminalRightClickToPaste = candidate.terminalRightClickToPaste;
    if (typeof candidate.terminalFocusFollowsMouse === "boolean")
      out.terminalFocusFollowsMouse = candidate.terminalFocusFollowsMouse;
    if (typeof candidate.terminalClipboardOnSelect === "boolean")
      out.terminalClipboardOnSelect = candidate.terminalClipboardOnSelect;
    if (typeof candidate.terminalAllowOsc52Clipboard === "boolean")
      out.terminalAllowOsc52Clipboard = candidate.terminalAllowOsc52Clipboard;
    if (
      typeof candidate.terminalScrollbackRows === "number" &&
      Number.isFinite(candidate.terminalScrollbackRows)
    )
      out.terminalScrollbackRows = normalizeDesktopTerminalScrollbackRows(
        candidate.terminalScrollbackRows,
      );
    if (
      typeof candidate.terminalWordSeparator === "string" &&
      candidate.terminalWordSeparator.length <= 256 &&
      NO_CONTROL_CHARS.test(candidate.terminalWordSeparator)
    )
      out.terminalWordSeparator = candidate.terminalWordSeparator;
    if (isMacOptionAsAlt(candidate.terminalMacOptionAsAlt))
      out.terminalMacOptionAsAlt = candidate.terminalMacOptionAsAlt;
    if (typeof candidate.terminalJISYenToBackslash === "boolean")
      out.terminalJISYenToBackslash = candidate.terminalJISYenToBackslash;
    if (isTerminalFontFamily(candidate.terminalFontFamily))
      out.terminalFontFamily = candidate.terminalFontFamily;
    {
      const weight = parseTerminalFontWeight(
        candidate.terminalFontWeight,
        normalizeTerminalFontWeight,
      );
      if (weight !== null) out.terminalFontWeight = weight;
    }
    {
      const boldWeight = parseTerminalFontWeight(
        candidate.terminalFontWeightBold,
        normalizeTerminalFontWeightBold,
      );
      if (boldWeight !== null) out.terminalFontWeightBold = boldWeight;
    }
    if (isEditorFontFamily(candidate.editorFontFamily))
      out.editorFontFamily = candidate.editorFontFamily;
    if (isDefaultHarnessId(candidate.defaultHarnessId))
      out.defaultHarnessId = candidate.defaultHarnessId;
    {
      const parsed = parseHarnessDefaults(candidate.harnessDefaults);
      if (parsed) out.harnessDefaults = parsed;
    }
    if (typeof candidate.notifyOnAgentNeedsInput === "boolean")
      out.notifyOnAgentNeedsInput = candidate.notifyOnAgentNeedsInput;
    if (typeof candidate.notifyOnAgentTaskComplete === "boolean")
      out.notifyOnAgentTaskComplete = candidate.notifyOnAgentTaskComplete;
    if (typeof candidate.notifyOnTerminalBell === "boolean")
      out.notifyOnTerminalBell = candidate.notifyOnTerminalBell;
    if (typeof candidate.notifySuppressWhenFocused === "boolean")
      out.notifySuppressWhenFocused = candidate.notifySuppressWhenFocused;
    if (isGpuAcceleration(candidate.terminalGpuAcceleration))
      out.terminalGpuAcceleration = candidate.terminalGpuAcceleration;
    for (const key of [
      "statusBarVisible",
      "tasksButtonVisible",
      "automationsButtonVisible",
      "titlebarAppNameVisible",
    ] as const) {
      if (typeof candidate[key] === "boolean") out[key] = candidate[key];
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Extracts envelope keys that aren't part of the typed SettingsSubset, so a
 * read-modify-write cycle can carry forward-compat fields (written by a newer
 * build, unknown to this one) through untouched instead of dropping them.
 * Malformed or foreign envelopes yield no extras, matching parsePersistedSettings.
 */
export function parseUnknownSettingsKeys(
  raw: string | null | undefined,
): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return {};
    const settings = (parsed as { settings?: unknown }).settings;
    if (
      typeof settings !== "object" ||
      settings === null ||
      Array.isArray(settings)
    )
      return {};
    const candidate = settings as Record<string, unknown>;
    const known = new Set(Object.keys(SETTINGS_DEFAULTS));
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(candidate)) {
      if (!known.has(key)) out[key] = candidate[key];
    }
    return out;
  } catch {
    return {};
  }
}

/** Small typed store: get/set with defaults, persisted state, migrations and launch overrides; debounced guarded saves. */
export class SettingsStore {
  #storage: StorageLike;
  #key: string;
  #state: SettingsSubset;
  #unknownKeys: Record<string, unknown> = {};
  #dirtyKeys = new Set<keyof SettingsSubset>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #firstPendingAt: number | null = null;

  constructor(
    storage: StorageLike,
    options: {
      namespace: string;
      defaults?: SettingsSubset;
      migration?: Partial<SettingsSubset>;
      launchOverride?: Partial<SettingsSubset>;
    },
  ) {
    this.#storage = storage;
    this.#key = settingsStorageKey(options.namespace);
    let persisted: Partial<SettingsSubset> = {};
    try {
      const raw = storage.getItem(this.#key);
      persisted = parsePersistedSettings(raw);
      this.#unknownKeys = parseUnknownSettingsKeys(raw);
    } catch {
      persisted = {};
      this.#unknownKeys = {};
    }
    this.#state = mergeSettingLayers({
      defaults: options.defaults ?? SETTINGS_DEFAULTS,
      persisted,
      migration: options.migration,
      launchOverride: options.launchOverride,
    });
  }

  get<K extends keyof SettingsSubset>(key: K): SettingsSubset[K] {
    return this.#state[key];
  }

  /** Updates in-memory state, returns it, and schedules a debounced save (1s, at most 5s pending). */
  set<K extends keyof SettingsSubset>(
    key: K,
    value: SettingsSubset[K],
  ): SettingsSubset {
    this.#state = { ...this.#state, [key]: value };
    this.#dirtyKeys.add(key);
    const now = Date.now();
    if (this.#firstPendingAt === null) this.#firstPendingAt = now;
    const delay = Math.min(DEBOUNCE_MS, MAX_PENDING_MS - (now - this.#firstPendingAt));
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.flush(), Math.max(0, delay));
    return this.#state;
  }

  /** Writes immediately and clears the pending window. Storage failures are swallowed; in-memory state stays authoritative. */
  flush(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#firstPendingAt = null;
    try {
      // Settings controls that predate the full store (for example the
      // terminal Interaction/Advanced pane) use an envelope read-modify-write
      // path. Refresh fields this instance did not edit so its later flush
      // cannot clobber those live changes with an older startup snapshot.
      const raw = this.#storage.getItem(this.#key);
      const persisted = parsePersistedSettings(raw);
      for (const key of Object.keys(this.#state) as (keyof SettingsSubset)[]) {
        if (!this.#dirtyKeys.has(key) && persisted[key] !== undefined) {
          this.#state = { ...this.#state, [key]: persisted[key] };
        }
      }
      this.#unknownKeys = {
        ...this.#unknownKeys,
        ...parseUnknownSettingsKeys(raw),
      };
      this.#storage.setItem(
        this.#key,
        JSON.stringify({ settings: { ...this.#unknownKeys, ...this.#state } }),
      );
      this.#dirtyKeys.clear();
    } catch {
      // Storage unavailable: keep serving in-memory state; no durability promise.
    }
  }
}

/**
 * Reads the GPU mode straight from the persisted envelope (default "auto").
 * TerminalPane consumes the setting at pane construction through this reader
 * so the terminal feature does not need an App-level prop thread.
 */
export function readTerminalGpuAcceleration(
  storage: StorageLike,
): TerminalGpuAcceleration {
  try {
    return (
      parsePersistedSettings(storage.getItem(settingsStorageKey("ui")))
        .terminalGpuAcceleration ?? "auto"
    );
  } catch {
    return "auto";
  }
}

/**
 * Envelope read-modify-write for the GPU mode that preserves every other
 * persisted key (known and unknown). Used by the Settings control, whose
 * writes do not flow through an App-held store instance.
 */
export function writeTerminalGpuAcceleration(
  storage: StorageLike,
  mode: TerminalGpuAcceleration,
): void {
  try {
    const key = settingsStorageKey("ui");
    const raw = storage.getItem(key);
    const settings = {
      ...parseUnknownSettingsKeys(raw),
      ...parsePersistedSettings(raw),
      terminalGpuAcceleration: mode,
    };
    storage.setItem(key, JSON.stringify({ settings }));
  } catch {
    // Storage unavailable: nothing to persist; the caller keeps local state.
  }
}

export type TerminalTypographyEnvelope = {
  terminalFontFamily: string;
  terminalFontWeight: number;
  terminalFontWeightBold: number;
  editorFontFamily: string;
};

/**
 * Reads the terminal typography subset straight from the persisted envelope
 * (source defaults for absent keys). TerminalPane consumes the setting at
 * pane construction through this reader so the terminal feature does not
 * need an App-level prop thread (same pattern as the GPU mode reader).
 */
export function readTerminalTypography(
  storage: StorageLike,
): TerminalTypographyEnvelope {
  const fallback: TerminalTypographyEnvelope = {
    terminalFontFamily: SETTINGS_DEFAULTS.terminalFontFamily,
    terminalFontWeight: SETTINGS_DEFAULTS.terminalFontWeight,
    terminalFontWeightBold: SETTINGS_DEFAULTS.terminalFontWeightBold,
    editorFontFamily: SETTINGS_DEFAULTS.editorFontFamily,
  };
  try {
    const parsed = parsePersistedSettings(
      storage.getItem(settingsStorageKey("ui")),
    );
    return {
      terminalFontFamily:
        parsed.terminalFontFamily ?? fallback.terminalFontFamily,
      terminalFontWeight:
        parsed.terminalFontWeight ?? fallback.terminalFontWeight,
      terminalFontWeightBold:
        parsed.terminalFontWeightBold ?? fallback.terminalFontWeightBold,
      editorFontFamily: parsed.editorFontFamily ?? fallback.editorFontFamily,
    };
  } catch {
    return fallback;
  }
}

/**
 * Envelope read-modify-write for the typography subset that preserves every
 * other persisted key (known and unknown). Used by the Settings controls,
 * whose writes do not flow through an App-held store instance.
 */
export function writeTerminalTypography(
  storage: StorageLike,
  updates: Partial<TerminalTypographyEnvelope>,
): void {
  try {
    const key = settingsStorageKey("ui");
    const raw = storage.getItem(key);
    const parsed = parsePersistedSettings(raw);
    if (
      updates.terminalFontFamily !== undefined &&
      !isTerminalFontFamily(updates.terminalFontFamily)
    )
      return;
    if (
      updates.editorFontFamily !== undefined &&
      !isEditorFontFamily(updates.editorFontFamily)
    )
      return;
    const normalized = { ...updates };
    if (normalized.terminalFontWeight !== undefined) {
      if (
        typeof normalized.terminalFontWeight !== "number" ||
        !Number.isFinite(normalized.terminalFontWeight)
      )
        return;
      normalized.terminalFontWeight = normalizeTerminalFontWeight(
        normalized.terminalFontWeight,
      );
    }
    if (normalized.terminalFontWeightBold !== undefined) {
      if (
        typeof normalized.terminalFontWeightBold !== "number" ||
        !Number.isFinite(normalized.terminalFontWeightBold)
      )
        return;
      normalized.terminalFontWeightBold = normalizeTerminalFontWeightBold(
        normalized.terminalFontWeightBold,
      );
    }
    const settings = {
      ...parseUnknownSettingsKeys(raw),
      ...parsed,
      ...normalized,
    };
    storage.setItem(key, JSON.stringify({ settings }));
  } catch {
    // Storage unavailable: nothing to persist; the caller keeps local state.
  }
}
