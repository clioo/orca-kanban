/* MIT Copyright (c) 2026 Lovecast Inc. Ported from Orca's
   worktree-agent-rows.ts, worktree-agent-row-order.ts,
   worktree-agent-row-type.ts, worktree-agent-row-fallback-tab.ts,
   agent-row-decay-state.ts, short-time-ago.ts and agent-type-label.ts.
   Adapter: Orca derives rows from hook-reported agent-status entries; this
   repo's daemon reports one `agentState` per Session, read here through
   `sessionAgentState`, so one Session is exactly one row — including a
   session that never reported (fallback row with freshness secondary).
   Title resolution reuses the tab strip's own functions so a row reads
   exactly what its tab reads. Pure functions, unit-tested. */
import type {
  AgentState,
  HarnessId,
  Session,
} from "../../../../shared/session-contract";
import { agentStateLabel, sessionAgentState } from "./agent-state";
import { defaultTerminalTabTitle } from "./tab-title";
import {
  partitionPinnedOrder,
  reconcileTabOrder,
  resolveTabTitle,
} from "./tab-order";
import { recoveryTabLabel } from "../../session-recovery";
import { deriveGeneratedTabTitle } from "../../../../shared/agent-tab-title";

/** Fork-verbatim harness labels (src/shared/agent-type-label.ts). */
const HARNESS_LABELS: Record<HarnessId, string> = {
  claude: "Claude",
  pi: "Pi",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  codex: "Codex",
};

/** Label for a row's harness identity; plain shells read `Shell`. */
export function formatRowHarnessLabel(harnessId: HarnessId | null): string {
  if (harnessId === null) return "Shell";
  return HARNESS_LABELS[harnessId] ?? harnessId;
}

/**
 * Which harness a session is running (issue #622): the launched harness
 * when `harness.start` named one, else the harness the daemon observed in
 * the session PTY's foreground process group, else null for a plain shell.
 * The ONE shared answer — every surface (row title, secondary, glyph, tab
 * badge) uses this function and no surface re-derives it.
 */
export function resolveRowHarnessId(session: Session): HarnessId | null {
  return session.harnessId ?? session.observedHarnessId ?? null;
}

/**
 * Coarse `34m` / `2h` / `3d` duration, floored so it never overstates the
 * gap (fork's formatCompactDuration verbatim).
 */
export function formatCompactDuration(deltaMs: number): string {
  const minutes = Math.max(0, Math.floor(deltaMs / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Compact "now / 5m / 3h / 2d" age label (fork's formatShortTimeAgo
 * verbatim) — the row timestamp in the issue (`22m`).
 */
export function formatShortTimeAgo(ts: number, now: number = Date.now()): string {
  const delta = now - ts;
  if (delta < 60_000) return "now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The observer's freshness report for a row whose agent is not reporting
 * (fork's agentNoUpdateLabel verbatim): what was last heard and how long
 * the silence has run, never a claim about what the agent is doing.
 */
export function agentNoUpdateLabel(evidenceMs: number, now: number): string {
  return `No update in ${formatCompactDuration(now - evidenceMs)}`;
}

/** Last-heard millisecond for a session; falls back to creation. */
export function rowEvidenceMs(session: Session): number {
  const at = session.agentStateAt ? Date.parse(session.agentStateAt) : NaN;
  if (!Number.isNaN(at)) return at;
  const created = Date.parse(session.createdAt);
  return Number.isNaN(created) ? 0 : created;
}

/** Creation millisecond for ordering; unparseable sorts first. */
function rowCreatedMs(session: Session): number {
  const created = Date.parse(session.createdAt);
  return Number.isNaN(created) ? 0 : created;
}

/** Basename of the session command (session-label.ts fallback verbatim). */
function commandBasename(session: Session): string {
  return session.command.split(/[\\/]/).at(-1) || "Terminal";
}

/**
 * The row's message preview — the reference's `lastAssistantMessage` /
 * tool-preview slot (`worktree-card-compact-agent-row.tsx`). Drogon's
 * `session.list` records no last-assistant-message field
 * (`crates/drogon-core/src/session.rs`), so the real text used here is
 * `agentPromptPreview`: the daemon's bounded (512-char, first-known) prompt
 * preview, i.e. genuine user-visible message text, never a fabricated line.
 * A row whose own title already derives from that same prompt
 * (`agent-generated-titles.ts` reuses `deriveGeneratedTabTitle`) returns ""
 * so the dash never repeats the title it follows.
 */
export function resolveRowMessagePreview(
  session: Session,
  primaryTitle: string,
): string {
  const preview = session.agentPromptPreview?.trim() ?? "";
  if (preview === "") return "";
  if (deriveGeneratedTabTitle(preview) === primaryTitle) return "";
  return preview;
}

/**
 * Secondary row text (the fork's CompactAgentRow secondary slot): the
 * freshness report while the agent is not reporting, then the session's
 * message preview, then the harness identity for agent sessions and the
 * command basename for plain shells.
 */
export function resolveRowSecondary(
  session: Session,
  now: number,
  primaryTitle = "",
): string {
  const state = sessionAgentState(session);
  if (state === "unknown") return agentNoUpdateLabel(rowEvidenceMs(session), now);
  const preview = resolveRowMessagePreview(session, primaryTitle);
  if (preview) return preview;
  const resolvedHarnessId = resolveRowHarnessId(session);
  if (resolvedHarnessId) {
    if (primaryTitle === formatRowHarnessLabel(resolvedHarnessId)) return "";
    return formatRowHarnessLabel(resolvedHarnessId);
  }
  return commandBasename(session);
}

/**
 * Row order (fork's compareWorktreeAgentRows adapted): the source sorts by
 * agent startedAt, tab sortOrder/createdAt, then pane key. Sessions carry
 * no pane keys or per-tab records, so creation time then session id is the
 * whole deterministic order.
 */
export function compareWorktreeAgentRows(a: Session, b: Session): number {
  return (
    rowCreatedMs(a) - rowCreatedMs(b) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * The row's trailing state text (owner's design, 2026-09-21): the state's
 * own label, or — while the session is not reporting — how long the silence
 * has run. `unknown` never borrows a state word the daemon did not report:
 * the freshness report is the honest thing to say, and it is the same
 * string the row's secondary slot would otherwise have repeated.
 */
export function resolveRowStateLabel(
  session: Session,
  state: AgentState,
  now: number,
): string {
  if (state === "unknown") return agentNoUpdateLabel(rowEvidenceMs(session), now);
  return agentStateLabel(state);
}

export type WorktreeAgentRow = {
  session: Session;
  /** Dot state via `sessionAgentState` (unproven shell `working` reads `unknown`). */
  state: AgentState;
  /** Tab title, resolved exactly like the strip (rename wins). */
  title: string;
  /** Freshness report, message preview, or harness/command identity. */
  secondary: string;
  /**
   * Always-true trailing state text: the state label, or the freshness
   * report while the session is not reporting. Present on every row (the
   * owner's decision), main rows included.
   */
  stateLabel: string;
  /** Compact age (`22m`) of the last report, or "" when unknowable. */
  relativeTime: string;
  /** True when this row's tab is the active one (focused highlight). */
  focused: boolean;
};

export type WorktreeAgentRowInputs = {
  /** Stored strip order (session ids); absent keeps creation order only. */
  stripOrder?: readonly string[];
  /** Pinned tab ids, rendered first like the strip. */
  pinnedIds?: readonly string[] | ReadonlySet<string>;
  /** Custom session titles from the rename affordance. */
  customTitles?: Record<string, string>;
  /** Active session tab id for the focused-row highlight. */
  activeSessionId?: string;
  nowMs?: number;
};

/**
 * The unrenamed default title per session, in row order: the harness label
 * for launched or observed agents, otherwise the strip position's
 * "Terminal N". Shared by row building and the stale-copy heal so both
 * sides number shells identically.
 */
export function defaultTitleBySession(
  sessions: Session[],
  inputs: Pick<WorktreeAgentRowInputs, "stripOrder" | "pinnedIds"> = {},
): Map<string, string> {
  const ordered = [...sessions].sort(compareWorktreeAgentRows);
  const stripSequence = partitionPinnedOrder(
    reconcileTabOrder(
      inputs.stripOrder,
      ordered.map((session) => session.id),
    ),
    inputs.pinnedIds ?? [],
  );
  const positionById = new Map<string, number>();
  stripSequence.forEach((id, index) => {
    if (!positionById.has(id)) positionById.set(id, index + 1);
  });
  const defaults = new Map<string, string>();
  for (const session of ordered) {
    const resolvedHarnessId = resolveRowHarnessId(session);
    defaults.set(
      session.id,
      resolvedHarnessId
        ? formatRowHarnessLabel(resolvedHarnessId)
        : defaultTerminalTabTitle(positionById.get(session.id) ?? 1),
    );
  }
  return defaults;
}

/**
 * One nested card row per session, in row order. The caller passes the
 * sessions attached to one worktree (already strip-filtered); every
 * session yields a row, including one that never reported — that fallback
 * row is what the fork's `tabFromWorktreeAttributedStatusEntry` provides
 * for tabs with no agent entry.
 */
export function buildWorktreeAgentRows(
  sessions: Session[],
  inputs: WorktreeAgentRowInputs = {},
): WorktreeAgentRow[] {
  const now = inputs.nowMs ?? Date.now();
  const ordered = [...sessions].sort(compareWorktreeAgentRows);
  // Title numbering reuses the strip's own order reconciliation (same
  // functions TabBar numbers "Terminal N" with), so the row title is the
  // tab title character for character.
  const defaults = defaultTitleBySession(sessions, inputs);
  const customTitles = inputs.customTitles ?? {};
  return ordered.map((session) => {
    const evidenceMs = rowEvidenceMs(session);
    // A custom rename still wins; otherwise a session running a resolved
    // harness reads the harness label, and only a session with no resolved
    // harness keeps `Terminal N`. Numbering still counts every session, so
    // plain shells keep their exact `Terminal N` titles.
    const title = recoveryTabLabel({
      label: resolveTabTitle(
        session.id,
        defaults.get(session.id) ?? defaultTerminalTabTitle(1),
        customTitles,
      ),
      verdict: session.verdict,
      id: session.id,
      incarnation: session.incarnation,
    });
    return {
      session,
      state: sessionAgentState(session),
      title,
      secondary: resolveRowSecondary(session, now, title),
      stateLabel: resolveRowStateLabel(session, sessionAgentState(session), now),
      relativeTime: evidenceMs > 0 ? formatShortTimeAgo(evidenceMs, now) : "",
      focused: session.id === inputs.activeSessionId,
    };
  });
}
