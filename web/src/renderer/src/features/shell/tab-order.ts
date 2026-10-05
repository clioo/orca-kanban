/* MIT Copyright (c) 2026 Lovecast Inc. Ported from Orca's
   src/renderer/src/components/tab-bar/reconcile-order.ts (stored-order
   reconciliation with render-boundary dedupe),
   src/renderer/src/store/slices/tabs/tabs-tab-order.ts (pinned partition)
   and src/renderer/src/store/slices/tabs/tabs-bulk-close-actions.ts
   (bulk-close skips pinned tabs). Adapter: the strip holds terminal
   sessions, browser pages and editor (open file) tabs, so the order domain
   is those three id lists; pin/title state lives in this file's
   per-workspace envelope instead of the zustand tab slice. R16-N adds the
   split-terminal pair map (terminal-split.ts sanitize) as an additive
   envelope key. R16-AJ adds the editor/browser membership keys (sanitize
   + remap), which are original to this repo. */

import {
  sanitizeTerminalSplits,
  type PersistedTerminalSplitMap,
} from "../terminal/terminal-split";

/**
 * One open browser tab's restore record (R16-AJ, fixes #215): the strip id
 * plus the URL to reload. Tab ids are host-minted per launch, so a restart
 * recreates the tab and remaps the stored order old id -> new id; the URL
 * is what actually survives.
 */
export type PersistedBrowserTab = {
  tabId: string;
  url: string;
};

/**
 * Envelope caps for the R16-AJ membership keys. The browser cap mirrors
 * MAX_BROWSER_TABS (shared/browser-contract.ts); the editor cap bounds one
 * localStorage envelope, and the path cap rejects garbage without judging
 * legal path characters (any non-empty string the files bridge accepted).
 */
/**
 * The Mentu tab's strip id (issue: Mentu must open as a real tab). Mentu
 * is a singleton per workspace and the strip envelope is already keyed by
 * workspace, so one stable id — never a host-minted one — is the whole
 * membership record. Namespaced so it can never collide with a daemon
 * session id or a host-minted browser tab id.
 */
export const MENTU_TAB_ID = "mentu-tab";

export const MAX_PERSISTED_EDITOR_TABS = 128;
export const MAX_PERSISTED_BROWSER_TABS = 16;
export const MAX_PERSISTED_PATH_CHARS = 1024;
export const MAX_PERSISTED_URL_CHARS = 2048;

export type TabStripState = {
  /** Stored strip order (session ids and browser tab ids, deduped at read). */
  order: string[];
  /** Pinned tab ids; rendered first, never closed by bulk actions. */
  pinned: string[];
  /** Custom session titles from the rename affordance ("" / absent = default). */
  titles: Record<string, string>;
  /**
   * Split-terminal pairs per tab root (R16-N Split Terminal Right): each
   * root session id maps to its two daemon-session panes with focus and
   * sizes. Absent/empty while every tab holds one pane.
   */
  splits: PersistedTerminalSplitMap;
  /**
   * Open editor files for this workspace, as paths (R16-AJ membership).
   * Paths, not tab ids: the id is `${workspaceId}::${path}` and the
   * workspace is the envelope key, so the path round-trips losslessly.
   * Absent/empty on pre-membership envelopes.
   */
  editors: string[];
  /**
   * Open browser tabs for this workspace, as id+url records (R16-AJ
   * membership). Absent/empty on pre-membership envelopes.
   */
  browsers: PersistedBrowserTab[];
  /**
   * Whether the workspace's Mentu tab is open (Mentu-as-tab membership,
   * additive). `false`/absent on older envelopes. The tab's strip position
   * still rides `order` under [`MENTU_TAB_ID`].
   */
  mentu: boolean;
  /**
   * Leader session ids whose subagent group is folded shut in the strip
   * (issue #606, additive). Durable per workspace so a fold survives a
   * reload, a workspace switch and a strip rebuild instead of resetting;
   * absent/empty on older envelopes.
   */
  collapsedLineage: string[];
};

export const EMPTY_TAB_STRIP_STATE: TabStripState = {
  order: [],
  pinned: [],
  titles: {},
  splits: {},
  editors: [],
  browsers: [],
  mentu: false,
  collapsedLineage: [],
};

/** Storage key pattern mirrors the right-sidebar keys (`drogon:<area>:<name>`); one envelope per workspace. */
export function tabStripStorageKey(workspaceId: string): string {
  return `drogon:tab-strip:${workspaceId}`;
}

/**
 * Reconcile a stored order with the tabs that exist now: keep stored ids
 * that still exist in their stored positions, append new ids at the end in
 * natural order. Dedupes at the boundary so a stale double-write can never
 * produce duplicate React keys.
 */
export function reconcileTabOrder(
  storedOrder: readonly string[] | undefined,
  sessionIds: readonly string[],
  browserIds: readonly string[] = [],
  editorIds: readonly string[] = [],
  mentuOpen = false,
): string[] {
  const mentuIds = mentuOpen ? [MENTU_TAB_ID] : [];
  const valid = new Set([...sessionIds, ...browserIds, ...editorIds, ...mentuIds]);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of storedOrder ?? []) {
    if (valid.has(id) && !seen.has(id)) {
      result.push(id);
      seen.add(id);
    }
  }
  for (const id of [...sessionIds, ...browserIds, ...editorIds, ...mentuIds]) {
    if (!seen.has(id)) {
      result.push(id);
      seen.add(id);
    }
  }
  return result;
}

/** dnd-kit arrayMove equivalent over the committed order (pure). */
export function moveTabOrder(
  order: readonly string[],
  activeId: string,
  overId: string,
): string[] {
  const from = order.indexOf(activeId);
  const to = order.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return [...order];
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Rewrite stored ids through an old id -> new id mapping (R16-AJ browser
 * rehydrate: the host mints fresh tab ids per launch, so recreated tabs
 * take their stored positions instead of falling to the strip end).
 * Unmapped ids pass through untouched; mapping values are NOT deduped
 * against the order, so callers must map each stale id at most once.
 */
export function remapTabOrder(
  order: readonly string[],
  mapping: Readonly<Record<string, string>>,
): string[] {
  return order.map((id) => mapping[id] ?? id);
}

/** Move one entry by a signed delta (keyboard reorder primitive). */
export function shiftTabOrder(
  order: readonly string[],
  id: string,
  delta: number,
): string[] {
  const from = order.indexOf(id);
  if (from === -1) return [...order];
  const to = Math.min(order.length - 1, Math.max(0, from + delta));
  if (to === from) return [...order];
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Pinned tabs render first in stored relative order, then unpinned ones
 * (source partitionPinnedTabOrder semantics, without the in-flight mover).
 */
export function partitionPinnedOrder(
  order: readonly string[],
  pinnedIds: ReadonlySet<string> | readonly string[],
): string[] {
  const pinned = new Set(pinnedIds);
  return [
    ...order.filter((id) => pinned.has(id)),
    ...order.filter((id) => !pinned.has(id)),
  ];
}

/** Toggle pin; pinning moves the tab to the end of the pinned block. */
export function togglePinnedOrder(
  order: readonly string[],
  pinnedIds: readonly string[],
  id: string,
): { order: string[]; pinned: string[] } {
  const pinned = new Set(pinnedIds);
  if (pinned.has(id)) {
    pinned.delete(id);
    return {
      order: partitionPinnedOrder(order, pinned),
      pinned: [...pinned],
    };
  }
  pinned.add(id);
  const rest = order.filter((entry) => entry !== id);
  const pinnedBlock = rest.filter((entry) => pinned.has(entry));
  const unpinnedBlock = rest.filter((entry) => !pinned.has(entry));
  return { order: [...pinnedBlock, id, ...unpinnedBlock], pinned: [...pinned] };
}

/**
 * Bulk-close targets in strip order, never including pinned tabs (source
 * tabs-bulk-close-actions semantics for closeOthers/closeToRight/closeToLeft).
 */
export function bulkCloseTargets(
  order: readonly string[],
  pinnedIds: ReadonlySet<string> | readonly string[],
  anchorId: string,
  mode: "others" | "to-right" | "to-left",
): string[] {
  const pinned = new Set(pinnedIds);
  const at = order.indexOf(anchorId);
  if (at === -1) return [];
  const candidates =
    mode === "others"
      ? order.filter((id) => id !== anchorId)
      : mode === "to-right"
        ? order.slice(at + 1)
        : order.slice(0, at);
  return candidates.filter((id) => !pinned.has(id));
}

function sanitizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 512)
      continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.slice(0, 512);
}

function sanitizeTitles(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const out: Record<string, string> = {};
  for (const [key, title] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (key.length === 0 || key.length > 512) continue;
    if (typeof title !== "string" || title.length === 0 || title.length > 256)
      continue;
    if (/[\0-\x1f\x7f]/.test(title)) continue;
    out[key] = title;
    if (Object.keys(out).length >= 512) break;
  }
  return out;
}

function sanitizePathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    if (entry.length === 0 || entry.length > MAX_PERSISTED_PATH_CHARS)
      continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out.slice(0, MAX_PERSISTED_EDITOR_TABS);
}

function sanitizeBrowserTabs(value: unknown): PersistedBrowserTab[] {
  if (!Array.isArray(value)) return [];
  const out: PersistedBrowserTab[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      continue;
    const { tabId, url } = entry as Record<string, unknown>;
    if (typeof tabId !== "string" || tabId.length === 0 || tabId.length > 128)
      continue;
    if (
      typeof url !== "string" ||
      url.length === 0 ||
      url.length > MAX_PERSISTED_URL_CHARS
    )
      continue;
    if (seen.has(tabId)) continue;
    seen.add(tabId);
    out.push({ tabId, url });
  }
  return out.slice(0, MAX_PERSISTED_BROWSER_TABS);
}

function emptyTabStripState(): TabStripState {
  return {
    ...EMPTY_TAB_STRIP_STATE,
    titles: {},
    splits: {},
    editors: [],
    browsers: [],
    mentu: false,
    collapsedLineage: [],
  };
}

export function parseTabStripState(raw: string | null | undefined): TabStripState {
  if (!raw) return emptyTabStripState();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return emptyTabStripState();
    const candidate = parsed as { state?: unknown };
    if (
      typeof candidate.state !== "object" ||
      candidate.state === null ||
      Array.isArray(candidate.state)
    )
      return emptyTabStripState();
    const state = candidate.state as Record<string, unknown>;
    const order = sanitizeIdList(state.order);
    const pinned = sanitizeIdList(state.pinned).filter((id) =>
      order.includes(id),
    );
    // Additive R16-N key: older envelopes simply hydrate to no splits.
    const splits = sanitizeTerminalSplits(state.splits);
    // Additive R16-AJ keys: older envelopes hydrate to no restored tabs.
    const editors = sanitizePathList(state.editors);
    const browsers = sanitizeBrowserTabs(state.browsers);
    // Additive Mentu-as-tab key: only a literal `true` counts, so a
    // corrupt or partial envelope can never fabricate a tab.
    const mentu = state.mentu === true;
    // Additive issue #606 key: folded subagent groups. Bounded by the same
    // id sanitizer as the other lists, so a tampered envelope can only ever
    // fold tabs, never mint or rename one.
    const collapsedLineage = sanitizeIdList(state.collapsedLineage);
    return {
      order,
      pinned,
      titles: sanitizeTitles(state.titles),
      splits,
      editors,
      browsers,
      mentu,
      collapsedLineage,
    };
  } catch {
    return emptyTabStripState();
  }
}

export function loadTabStripState(
  storage: Pick<Storage, "getItem">,
  workspaceId: string,
): TabStripState {
  try {
    return parseTabStripState(storage.getItem(tabStripStorageKey(workspaceId)));
  } catch {
    return emptyTabStripState();
  }
}

export function saveTabStripState(
  storage: Pick<Storage, "setItem">,
  workspaceId: string,
  state: TabStripState,
): void {
  try {
    storage.setItem(
      tabStripStorageKey(workspaceId),
      JSON.stringify({ state }),
    );
  } catch {
    // No durability promise; in-memory state stays authoritative.
  }
}

/** Resolve the visible label: a custom rename wins over the default title. */
export function resolveTabTitle(
  id: string,
  defaultTitle: string,
  titles: Record<string, string>,
): string {
  return titles[id] ?? defaultTitle;
}

/**
 * Default-shaped titles: the "Terminal N" shell numbers plus the harness
 * labels (mirrors HARNESS_LABELS in worktree-agent-rows.ts and
 * defaultTerminalTabTitle; kept local so this module stays import-clean).
 * A stored rename matching one of these can only ever mirror a default —
 * nobody renames a tab to "Terminal 8" for meaning — so it is a frozen
 * prefill copy even when the live number has since shifted.
 */
const FROZEN_DEFAULT_TITLE_PATTERN = /^(?:Terminal \d+|Claude|Pi|Codex|OpenCode)$/;

/**
 * Drop stored titles that carry no information: a rename equal to the
 * session's live default or generated title, or matching a default shape
 * ("Terminal N", a harness label), is a frozen prefill copy — saving the
 * rename dialog unchanged. Left in place it renders verbatim forever,
 * defeats the concise provider fold, and goes stale when shells renumber;
 * dropped, the row and the tab heal to the live title. Anything the user
 * actually typed survives. Pure; the store itself is untouched.
 */
export function stripRedundantTitles(
  titles: Record<string, string> | null | undefined,
  defaultsById: ReadonlyMap<string, string>,
  generatedById: Record<string, string> | null | undefined = null,
): Record<string, string> {
  if (!titles) return {};
  const kept: Record<string, string> = {};
  for (const [id, stored] of Object.entries(titles)) {
    if (stored === defaultsById.get(id)) continue;
    if (generatedById && stored === generatedById[id]) continue;
    if (FROZEN_DEFAULT_TITLE_PATTERN.test(stored)) continue;
    kept[id] = stored;
  }
  return kept;
}
