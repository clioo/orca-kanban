// MIT Copyright (c) 2026 Lovecast Inc. Ported from
// src/renderer/src/components/terminal-pane/terminal-pane-layout-tree.ts
// (collectLeafIds/pruneLeaves: a split tab owns its leaf ids, closing a
// pane prunes the tree back to the survivor) and the split entry points
// src/renderer/src/components/terminal-pane/TerminalPaneHeaderOverlay.tsx
// ("Split Terminal Right") and TerminalContextMenu.tsx (split items with
// the terminal.splitRight/terminal.splitDown chords from
// src/shared/keybindings/definitions-core-4.ts).
// Adapter: the fork splits one PTY tab into N pane-manager leaves; Drogon
// splits one session tab into at most two side-by-side daemon sessions of
// the same workspace (created through window.drogon.start), so the layout
// is a flat pair instead of a tree and only the right (vertical) direction
// exists. Split Down stays deferred with the rest of issue #129.

import type { AgentState } from "../../../../shared/session-contract";

/** Fork parity: one tab holds at most two side-by-side panes. */
export const TERMINAL_SPLIT_MAX_PANES = 2;

/** Default share while a fresh split has no dragged sizes yet. */
export const TERMINAL_SPLIT_DEFAULT_SIZES: [number, number] = [0.5, 0.5];

/** Pointer-drag clamp mirrors the fork: no pane shrinks past a fifth. */
export const TERMINAL_SPLIT_MIN_FRACTION = 0.2;
export const TERMINAL_SPLIT_MAX_FRACTION = 0.8;

/** Live split: root session id owns the tab, panes are daemon sessions. */
export type TerminalSplit = {
  rootId: string;
  panes: [string, string];
  activePaneId: string;
  sizes: [number, number];
};

/** Persisted envelope form (additive key inside the tab-strip state). */
export type PersistedTerminalSplit = {
  panes: [string, string];
  active?: string;
  sizes?: [number, number];
};

export type TerminalSplitMap = Record<string, TerminalSplit>;
export type PersistedTerminalSplitMap = Record<string, PersistedTerminalSplit>;

function isSessionId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 512
  );
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return TERMINAL_SPLIT_DEFAULT_SIZES[0];
  return Math.min(
    TERMINAL_SPLIT_MAX_FRACTION,
    Math.max(TERMINAL_SPLIT_MIN_FRACTION, value),
  );
}

/** Normalizes a dragged first-pane fraction into a clamped pair. */
export function splitSizesFromFirst(first: number): [number, number] {
  // Why: rounded so the persisted envelope holds exact decimals (1 - 0.8
  // is 0.19999999999999996 in binary floating point).
  const clamped = Math.round(clampFraction(first) * 10000) / 10000;
  return [clamped, Math.round((1 - clamped) * 10000) / 10000];
}

/** Pointer position as a first-pane fraction for a horizontal split host. */
export function splitFractionFromClientX(
  hostLeft: number,
  hostWidth: number,
  clientX: number,
): number {
  if (!Number.isFinite(hostLeft) || !Number.isFinite(hostWidth) || hostWidth <= 0)
    return TERMINAL_SPLIT_DEFAULT_SIZES[0];
  return clampFraction((clientX - hostLeft) / hostWidth);
}

/** Creates the split the "Split Terminal Right" entry point produces. */
export function createTerminalSplit(
  rootId: string,
  newPaneId: string,
): TerminalSplit {
  return {
    rootId,
    panes: [rootId, newPaneId],
    // Fork parity: the freshly split pane takes focus.
    activePaneId: newPaneId,
    sizes: [...TERMINAL_SPLIT_DEFAULT_SIZES],
  };
}

export function splitForTab(
  splits: TerminalSplitMap,
  tabId: string,
): TerminalSplit | null {
  return splits[tabId] ?? null;
}

/** True when the session renders inside a split (as root or second pane). */
export function isSplitPaneSession(
  splits: TerminalSplitMap,
  sessionId: string,
): boolean {
  return Object.values(splits).some((split) =>
    split.panes.includes(sessionId),
  );
}

/** Every second-pane id, so the strip can hide them as own tabs. */
export function secondarySplitPaneIds(
  splits: TerminalSplitMap,
): Set<string> {
  const ids = new Set<string>();
  for (const split of Object.values(splits)) ids.add(split.panes[1]);
  return ids;
}

export function activateSplitPane(
  splits: TerminalSplitMap,
  rootId: string,
  paneId: string,
): TerminalSplitMap {
  const split = splits[rootId];
  if (!split || !split.panes.includes(paneId)) return splits;
  if (split.activePaneId === paneId) return splits;
  return { ...splits, [rootId]: { ...split, activePaneId: paneId } };
}

export function resizeTerminalSplit(
  splits: TerminalSplitMap,
  rootId: string,
  first: number,
): TerminalSplitMap {
  const split = splits[rootId];
  if (!split) return splits;
  return { ...splits, [rootId]: { ...split, sizes: splitSizesFromFirst(first) } };
}

export function equalizeTerminalSplit(
  splits: TerminalSplitMap,
  rootId: string,
): TerminalSplitMap {
  const split = splits[rootId];
  if (!split) return splits;
  return {
    ...splits,
    [rootId]: { ...split, sizes: [...TERMINAL_SPLIT_DEFAULT_SIZES] },
  };
}

export type SplitPaneCloseOutcome = {
  splits: TerminalSplitMap;
  /** The tab keeps living as this single session (null when untouched). */
  survivorId: string | null;
  /** The dissolved split root, so strip titles/pins/order can migrate. */
  dissolvedRoot: string | null;
};

/**
 * Closing one pane of a split (fork pruneLeaves shape): the survivor keeps
 * the tab as a single. When the closed pane is the root, the second pane
 * is promoted — the caller migrates strip order/titles/pins from the
 * dissolved root to the survivor.
 */
export function closeTerminalSplitPane(
  splits: TerminalSplitMap,
  closingId: string,
): SplitPaneCloseOutcome {
  for (const split of Object.values(splits)) {
    if (!split.panes.includes(closingId)) continue;
    const survivorId =
      split.panes[0] === closingId ? split.panes[1] : split.panes[0];
    const next = { ...splits };
    delete next[split.rootId];
    return { splits: next, survivorId, dissolvedRoot: split.rootId };
  }
  return { splits, survivorId: null, dissolvedRoot: null };
}

/** Restart path: the replacement session takes the old pane's slot. */
export function replaceTerminalSplitPane(
  splits: TerminalSplitMap,
  oldPaneId: string,
  newPaneId: string,
): TerminalSplitMap {
  for (const split of Object.values(splits)) {
    const at = split.panes.indexOf(oldPaneId);
    if (at === -1) continue;
    const panes: [string, string] = [...split.panes] as [string, string];
    panes[at] = newPaneId;
    // Drogon's tab root is the first session ID. Migrate that key too,
    // or persistence rejects the replacement and dissolves the split.
    const next = { ...splits };
    delete next[split.rootId];
    return {
      ...next,
      [panes[0]]: {
        ...split,
        rootId: panes[0],
        panes,
        activePaneId:
          split.activePaneId === oldPaneId ? newPaneId : split.activePaneId,
      },
    };
  }
  return splits;
}

/**
 * Drops splits whose panes are no longer live (fork cold-restore shape:
 * a split survives a renderer reload only while the daemon still lists
 * both sessions). Never invents: unknown ids dissolve to a single tab.
 */
export function pruneTerminalSplits(
  splits: TerminalSplitMap,
  liveIds: ReadonlySet<string>,
): TerminalSplitMap {
  let changed = false;
  const next: TerminalSplitMap = {};
  for (const [rootId, split] of Object.entries(splits)) {
    if (
      liveIds.has(split.panes[0]) &&
      liveIds.has(split.panes[1]) &&
      split.panes[0] !== split.panes[1]
    ) {
      next[rootId] = split;
    } else {
      changed = true;
    }
  }
  return changed ? next : splits;
}

function sanitizePersistedSplit(value: unknown): PersistedTerminalSplit | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const candidate = value as Record<string, unknown>;
  const panes = candidate.panes;
  if (
    !Array.isArray(panes) ||
    panes.length !== 2 ||
    !isSessionId(panes[0]) ||
    !isSessionId(panes[1]) ||
    panes[0] === panes[1]
  )
    return null;
  const out: PersistedTerminalSplit = { panes: [panes[0], panes[1]] };
  if (isSessionId(candidate.active) && (candidate.active === panes[0] || candidate.active === panes[1]))
    out.active = candidate.active;
  const sizes = candidate.sizes;
  if (
    Array.isArray(sizes) &&
    sizes.length === 2 &&
    typeof sizes[0] === "number" &&
    typeof sizes[1] === "number" &&
    Number.isFinite(sizes[0]) &&
    Number.isFinite(sizes[1])
  )
    out.sizes = splitSizesFromFirst(sizes[0]);
  return out;
}

/** Storage boundary: malformed splits never reach the live map. */
export function sanitizeTerminalSplits(
  value: unknown,
): PersistedTerminalSplitMap {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const out: PersistedTerminalSplitMap = {};
  for (const [key, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!isSessionId(key)) continue;
    const clean = sanitizePersistedSplit(entry);
    if (!clean) continue;
    if (key !== clean.panes[0]) continue;
    out[key] = clean;
    if (Object.keys(out).length >= 512) break;
  }
  return out;
}

export function hydrateTerminalSplits(
  persisted: PersistedTerminalSplitMap,
): TerminalSplitMap {
  const out: TerminalSplitMap = {};
  for (const [rootId, entry] of Object.entries(persisted)) {
    out[rootId] = {
      rootId,
      panes: [...entry.panes] as [string, string],
      activePaneId: entry.active ?? entry.panes[0],
      sizes: entry.sizes ? [...entry.sizes] as [number, number] : [...TERMINAL_SPLIT_DEFAULT_SIZES],
    };
  }
  return out;
}

export function persistTerminalSplits(
  splits: TerminalSplitMap,
): PersistedTerminalSplitMap {
  const out: PersistedTerminalSplitMap = {};
  for (const [rootId, split] of Object.entries(splits)) {
    out[rootId] = {
      panes: [...split.panes] as [string, string],
      active: split.activePaneId,
      sizes: [...split.sizes] as [number, number],
    };
  }
  return out;
}

/**
 * Tab badge for a split tab (fork: the tab dot reflects the hottest pane):
 * waiting-for-input beats working beats everything else, which keeps the
 * root session's own state.
 */
export function aggregateSplitAgentState(
  rootState: AgentState,
  secondState: AgentState,
): AgentState {
  const rank = (state: AgentState): number => {
    switch (state) {
      case "needs_input":
        return 3;
      case "working":
        return 2;
      case "idle":
        return 1;
      case "exited":
        return 0;
      case "unknown":
        return -1;
    }
  };
  return rank(secondState) > rank(rootState) ? secondState : rootState;
}

export type StripIdentity = {
  order: string[];
  pinned: string[];
  titles: Record<string, string>;
};

/**
 * Promoting a surviving second pane to the tab root (its former root was
 * closed): strip order, pins and renames follow the survivor so the tab
 * keeps its position, pin and custom title.
 */
export function migrateSplitTabIdentity(
  state: StripIdentity,
  from: string,
  to: string,
): StripIdentity {
  if (from === to) return state;
  const order = state.order.map((id) => (id === from ? to : id));
  const pinned = state.pinned.includes(from)
    ? [...state.pinned.filter((id) => id !== from), to].filter((id, at, all) => all.indexOf(id) === at)
    : state.pinned;
  const titles = { ...state.titles };
  if (titles[from] !== undefined && titles[to] === undefined) {
    titles[to] = titles[from];
  }
  delete titles[from];
  return { order, pinned, titles };
}

/**
 * Renderer-side shortcut label for the split entry points. Mirrors the
 * fork's terminal.splitRight default bindings (Mod+D on macOS,
 * Mod+Shift+D elsewhere) without touching the shared keybinding table.
 */
export function splitRightShortcutLabel(isMac: boolean): string {
  return isMac ? "⌘D" : "Ctrl+Shift+D";
}
