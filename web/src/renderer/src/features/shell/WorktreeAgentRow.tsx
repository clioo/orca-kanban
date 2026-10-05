/* MIT Copyright (c) 2026 Lovecast Inc. Ported from Orca's
   src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx
   (CompactAgentRow: identity glyph, primary/secondary text, relative time,
   focused-pane highlight, activation click with drag and key propagation
   guards; issue #359 adds the fork's child-agent disclosure from the same
   file: the chevron button with its Show/Hide-N-child-agents label, the +N
   count while collapsed, the reserved disclosure gutter on leaf root rows,
   and the worktree-agent-lineage-parent/child-row classes).
   Owner's sidebar design (2026-09-21) reorders the row to read like the
   owner's guide: `[chevron] [harness glyph] [name] [MAIN] … [state dot +
   label] [age]`. The state text is always present — the owner's decision is
   that a main row's state matters as much as a subagent's — and it is the
   freshness report ("No update in 34m") while the session is not reporting,
   so the row never states a condition the daemon did not report. The MAIN
   badge marks a root row that actually owns subagents (the nesting's parent
   end), never a lone session. The name is the concise provider identity when
   the visible title is only an auto-generated prompt preview (explicit user
   renames still render verbatim, prompt and shell details stay in the
   tooltip and the accessible label).
   Adapter: Orca rows read hook-reported agent entries (model chip, tool
   preview, last assistant message, cache timer, subagent disclosure); this
   repo's contract carries none of those, so the row shows the tab title
   (which reads the resolved harness, issue #622), the freshness/harness
   secondary from worktree-agent-rows.ts and the compact age. The fork's
   div becomes a button for leaf rows (valid nesting beside the card's
   select button, free keyboard support); a row with children keeps the
   fork's div + nested disclosure-button shape — interactive content may
   not descend from a button, and the source row is exactly this div. Not
   ported: model chip, cache timer, send-target mode — no backing data in
   the session contract. The visible texts are aria-hidden on purpose: the
   row's own aria-label (and each state glyph's label) is the announcement,
   so a screen reader never hears the state twice. */
import { memo, useCallback } from "react";
import { ChevronRight, Terminal } from "lucide-react";
import { AgentStateIcon } from "./AgentStateIcon";
import { AgentCacheTimer } from "./AgentCacheTimer";
import { SidebarProviderGlyph } from "./WorktreeAgentGlyph";
import { agentStateLabel } from "./agent-state";
import {
  formatRowHarnessLabel,
  resolveRowHarnessId,
  resolveRowMessagePreview,
  type WorktreeAgentRow as WorktreeAgentRowData,
} from "./worktree-agent-rows";

function stopCardDragPropagation(event: React.SyntheticEvent): void {
  // Why: the card surface arms pointer-drag reorder and the surrounding
  // list activates on click — a nested row must keep both local, like the
  // source's stopPropagation on mouse/pointer/drag start.
  event.stopPropagation();
}

function stopActivationKeyPropagation(event: React.KeyboardEvent): void {
  // Why: the surrounding worktree list handles Enter/Space as row
  // activation. Focused nested buttons need those keys to stay local.
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
}

/**
 * Sidebar-local provider branding (owner's reference): the sidebar reads
 * "Claude Code". F1's shared `formatRowHarnessLabel` stays the product-wide
 * "Claude" and is never touched here — this mapping lives in the sidebar
 * row component only. Pure, unit-tested via the design suite.
 */
const SIDEBAR_PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude Code",
};

export function formatSidebarProviderLabel(
  harnessId: Parameters<typeof formatRowHarnessLabel>[0],
): string {
  if (harnessId !== null && SIDEBAR_PROVIDER_LABELS[harnessId] !== undefined) {
    return SIDEBAR_PROVIDER_LABELS[harnessId]!;
  }
  return formatRowHarnessLabel(harnessId);
}

/**
 * The visible primary name for a row. An explicit user rename always renders
 * verbatim; a prompt-derived title folds back to the concise sidebar
 * provider identity; an actual default harness title ("Claude", "Pi",
 * "Terminal N") renders the sidebar provider branding in place. The full
 * title stays in the tooltip/accessible label, so no detail is lost.
 * Pure, unit-tested via the design suite.
 */
export function resolveRowDisplayPrimary(
  row: WorktreeAgentRowData,
  titles: { customTitle?: string | null; generatedTitle?: string | null },
): string {
  if (titles.customTitle) return row.title;
  const concise = resolveRowConciseIdentity(row, titles);
  if (concise) {
    const harnessId = resolveRowHarnessId(row.session);
    return harnessId ? formatSidebarProviderLabel(harnessId) : concise.primary;
  }
  // Actual default titles (no generated-title record, e.g. observed harness
  // sessions whose prompt preview never produced a stored title): when the
  // title is exactly F1's harness label it is the provider identity, so it
  // reads the sidebar branding instead of the product-wide label.
  const resolvedHarnessId = resolveRowHarnessId(row.session);
  if (
    resolvedHarnessId &&
    row.title === formatRowHarnessLabel(resolvedHarnessId)
  ) {
    return formatSidebarProviderLabel(resolvedHarnessId);
  }
  return row.title;
}

export type WorktreeAgentRowProps = {
  row: WorktreeAgentRowData;
  disabled: boolean;
  /** Selects the row's session tab (workspace first, then the tab). */
  onSelect: (sessionId: string) => void;
  /** Issue #359: fork child-agent disclosure props (see header). */
  childCount?: number;
  childrenExpanded?: boolean;
  onToggleChildren?: () => void;
  reserveDisclosureGutter?: boolean;
  isChildRow?: boolean;
  /** Owner's design: the badge a root row that owns subagents carries. */
  isMainRow?: boolean;
  /**
   * Owner's guide: where the visible title came from. An explicit user
   * rename always renders verbatim; an auto-generated prompt title folds
   * back to the concise harness identity (the prompt stays in the
   * tooltip/aria label and the preview secondary). Both absent means the
   * title is already concise (harness label or `Terminal N`).
   */
  customTitle?: string | null;
  generatedTitle?: string | null;
};

/** Visible width budget for a folded-back prompt preview secondary. */
export const CONCISE_PREVIEW_SECONDARY_MAX_LENGTH = 120;

function truncateConcisePreview(preview: string): string {
  const text = preview.trim().replace(/\s+/g, " ");
  if (text.length <= CONCISE_PREVIEW_SECONDARY_MAX_LENGTH) return text;
  const slice = text.slice(0, CONCISE_PREVIEW_SECONDARY_MAX_LENGTH).trimEnd();
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace >= Math.floor(CONCISE_PREVIEW_SECONDARY_MAX_LENGTH * 0.55)) {
    return slice.slice(0, lastSpace);
  }
  return slice;
}

/**
 * Owner's guide identity for a row whose visible title is an
 * auto-generated prompt preview: the concise provider name up front, the
 * prompt as the secondary, the full generated title kept for the
 * tooltip/aria label by the caller. Returns null when the row already
 * reads concise (explicit rename, harness label, plain shell) — those
 * render exactly as before. Pure, unit-tested via the design suite.
 */
export function resolveRowConciseIdentity(
  row: WorktreeAgentRowData,
  titles: { customTitle?: string | null; generatedTitle?: string | null },
): { primary: string; secondary: string } | null {
  // An explicit rename is the user's own words: never folded away.
  if (titles.customTitle) return null;
  const generated = titles.generatedTitle;
  if (!generated) return null;
  // The title may carry the recovery decoration for unverifiable verdicts
  // (`label · id:incarnation`); the generated text is still its head.
  if (row.title !== generated && !row.title.startsWith(`${generated} · `)) {
    return null;
  }
  // Plain shells already read `Terminal N` with the command as secondary.
  const harnessId = resolveRowHarnessId(row.session);
  if (!harnessId) return null;
  const primary = formatRowHarnessLabel(harnessId);
  const preview = resolveRowMessagePreview(row.session, primary);
  return { primary, secondary: truncateConcisePreview(preview) };
}

/**
 * PERF-03: the card rebuilds every row object on each App render (and the
 * card's own select handler is re-created with it), so the default shallow
 * memo never hits. Compare by rendered content instead: the row's display
 * fields plus the session facts the row actually reads (dot/harness/timer).
 * Callback identity is deliberately ignored — both callbacks are behaviorally
 * stable per session (workspace-first activation; lineage toggle), so a fresh
 * closure with the same target must not re-render the row.
 */
export function areWorktreeAgentRowPropsEqual(
  previous: WorktreeAgentRowProps,
  next: WorktreeAgentRowProps,
): boolean {
  if (previous === next) return true;
  return (
    previous.disabled === next.disabled &&
    previous.childCount === next.childCount &&
    previous.childrenExpanded === next.childrenExpanded &&
    previous.reserveDisclosureGutter === next.reserveDisclosureGutter &&
    previous.isChildRow === next.isChildRow &&
    previous.isMainRow === next.isMainRow &&
    previous.customTitle === next.customTitle &&
    previous.generatedTitle === next.generatedTitle &&
    previous.row.state === next.row.state &&
    previous.row.title === next.row.title &&
    previous.row.secondary === next.row.secondary &&
    previous.row.stateLabel === next.row.stateLabel &&
    previous.row.relativeTime === next.row.relativeTime &&
    previous.row.focused === next.row.focused &&
    previous.row.session.id === next.row.session.id &&
    previous.row.session.harnessId === next.row.session.harnessId &&
    previous.row.session.observedHarnessId ===
      next.row.session.observedHarnessId &&
    previous.row.session.verdict === next.row.session.verdict &&
    previous.row.session.agentState === next.row.session.agentState &&
    previous.row.session.agentStateAt === next.row.session.agentStateAt &&
    previous.row.session.cacheIdleAt === next.row.session.cacheIdleAt
  );
}

export const WorktreeAgentRow = memo(function WorktreeAgentRow({
  row,
  disabled,
  onSelect,
  childCount,
  childrenExpanded = false,
  onToggleChildren,
  reserveDisclosureGutter = false,
  isChildRow = false,
  isMainRow = false,
  customTitle = null,
  generatedTitle = null,
}: WorktreeAgentRowProps) {
  const handleActivate = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onSelect(row.session.id);
    },
    [onSelect, row.session.id],
  );
  const hasChildDisclosure =
    typeof childCount === "number" &&
    childCount > 0 &&
    typeof onToggleChildren === "function";
  const handleToggleChildren = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      onToggleChildren?.();
    },
    [onToggleChildren],
  );
  // Owner's guide: a prompt-derived title folds back to the concise
  // provider name (sidebar branding: "Claude Code"); the full generated
  // title stays in the accessible label below, so no prompt detail is lost
  // to a screen reader or tooltip.
  const concise = resolveRowConciseIdentity(row, {
    customTitle,
    generatedTitle,
  });
  const primary =
    resolveRowDisplayPrimary(row, { customTitle, generatedTitle }) ||
    agentStateLabel(row.state);
  // Why: while a session is not reporting, its secondary slot repeats the
  // freshness report the trailing state text already carries — one honest
  // line, not two.
  const secondary = concise
    ? concise.secondary
    : row.state === "unknown" && row.secondary === row.stateLabel
      ? ""
      : row.secondary;
  // Why: the trailing state text IS the freshness report for a session that
  // is not reporting ("No update in 17h"), so the row's own age column would
  // print that duration a second time. A row that knows its state keeps the
  // age: "Idle 5m" is two different facts.
  const showAge = row.state !== "unknown" && row.relativeTime !== "";
  const rowTitle = [
    // A folded-back row announces its full generated title, not the
    // concise provider name standing in for it; a sidebar-branded default
    // title ("Claude Code" for F1's "Claude") announces as displayed.
    concise ? row.title : primary,
    secondary,
    row.stateLabel,
  ]
    .filter(Boolean)
    .join(" - ");
  const focused = row.focused;
  const childAgentLabel = childCount === 1 ? "agent" : "agents";
  const lineageClasses =
    // Why: the fork's lineage chrome — the parent reads as a tree node,
    // the child as a member of the group below it.
    (hasChildDisclosure ? " worktree-agent-lineage-parent-row" : "") +
    (isChildRow ? " worktree-agent-lineage-child-row" : "");

  const disclosure = hasChildDisclosure ? (
    <button
      type="button"
      className="compact-agent-child-disclosure-button flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-worktree-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-worktree-sidebar-ring"
      aria-label={`${childrenExpanded ? "Hide" : "Show"} ${childCount} child ${childAgentLabel}`}
      aria-expanded={childrenExpanded}
      disabled={disabled}
      onClick={handleToggleChildren}
      onKeyDown={stopActivationKeyPropagation}
    >
      <ChevronRight
        className={
          "size-3 transition-transform duration-150" +
          (childrenExpanded ? " rotate-90" : "")
        }
        aria-hidden="true"
      />
    </button>
  ) : reserveDisclosureGutter ? (
    // Why: keep leaf rows aligned with parent rows whose leading chevron
    // takes this slot (the fork's reserveDisclosureGutter).
    <span className="size-4 shrink-0" aria-hidden="true" />
  ) : null;

  // The resolved harness (launch or observed, issue #622): the harness
  // icon for a session running an agent, the Terminal glyph only when
  // nothing is resolved.
  const resolvedHarnessId = resolveRowHarnessId(row.session);
  // The glyph tooltip keeps F1's shared harness label (pinned by the
  // row-identity suite): sidebar "Claude Code" branding applies to the
  // visible primary name only, never to the shared label surfaces.
  const identity = (
    <span
      className="shell-worktree-agent-glyph inline-flex shrink-0"
      title={formatRowHarnessLabel(resolvedHarnessId)}
    >
      {resolvedHarnessId ? (
        <SidebarProviderGlyph
          harnessId={resolvedHarnessId}
          displayName={formatRowHarnessLabel(resolvedHarnessId)}
          size={13}
        />
      ) : (
        <Terminal size={13} className="shrink-0" aria-hidden="true" />
      )}
    </span>
  );

  // Width budget (owner's guide: the provider name must stay readable at the
  // natural 280px sidebar width, with MAIN outside truncation and the row's
  // own state visible): the identity group never shrinks — a long rename
  // truncates inside it, a short provider name always reads whole. The
  // secondary yields first (flex-basis 0: it collapses toward nothing before
  // anything else gives). The state group never shrinks either: when even
  // the collapsed secondary leaves no room, the row wraps and the state
  // rides a second line, right-aligned, instead of eating the identity.
  const text = (
    <>
      <span className="shell-worktree-agent-identity" aria-hidden="true">
        {/* Why: the selected-row fill washes out dimmed text, so the name
            lifts toward full foreground when focused (source). */}
        <span
          data-worktree-agent-primary=""
          className={
            "shell-worktree-agent-primary " +
            (focused ? "text-foreground" : "text-muted-foreground/90")
          }
        >
          {primary}
        </span>
        {/* Why: the badge sits OUTSIDE the truncating name — a long title
            truncates, the fact that this row is the tree's main agent must
            not disappear with it. */}
        {isMainRow && (
          <span className="shell-worktree-agent-main-badge" aria-hidden="true">
            MAIN
          </span>
        )}
      </span>
      {/* Owner's guideline: a row reads provider, MAIN and state only. The
          title (secondary) stays in the row's tooltip and accessible name. */}
    </>
  );

  const tail = (
    <span className="shell-worktree-agent-tail">
      {hasChildDisclosure && !childrenExpanded && (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          +{childCount}
        </span>
      )}
      {/* Owner's design: every row states what its session is doing. The
          glyph carries the state's accessible label (the same one the tab
          badge uses); the text beside it is aria-hidden, so the state is
          announced once. */}
      <span
        className="shell-worktree-agent-state shrink-0"
        data-worktree-agent-state={row.state}
      >
        <AgentStateIcon state={row.state} size={10} variant="row" />
        <span className="shell-worktree-agent-state-label" aria-hidden="true">
          {row.stateLabel}
        </span>
      </span>
      <AgentCacheTimer session={row.session} />
      {showAge && (
        <span
          data-worktree-agent-age=""
          className={
            "shrink-0 text-[10px] tabular-nums " +
            // Why: the muted timestamp drops out against the
            // selected-row fill (source).
            (focused ? "text-foreground/70" : "text-muted-foreground/60")
          }
        >
          {row.relativeTime}
        </span>
      )}
    </span>
  );

  if (hasChildDisclosure) {
    // Why: the fork's row with children is a div carrying a real nested
    // disclosure button; a <button> may not contain interactive content,
    // so the parent-row shape follows the source verbatim (leaf rows
    // below keep this repo's button adapter).
    return (
      <div
        className={
          "compact-agent-row group/compact-agent-row flex h-auto min-h-6 min-w-0 cursor-pointer flex-wrap items-center gap-x-1 gap-y-0.5 overflow-hidden rounded-sm px-1 py-px text-[11px] leading-none text-muted-foreground worktree-agent-row-hover" +
          lineageClasses
        }
        onClick={handleActivate}
        onMouseDown={stopCardDragPropagation}
        onPointerDown={stopCardDragPropagation}
        onDragStart={stopCardDragPropagation}
        data-focused-agent-pane={focused ? "true" : undefined}
        data-worktree-agent-row={row.session.id}
        title={rowTitle}
      >
        {disclosure}
        {identity}
        {text}
        {tail}
      </div>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      className={
        "compact-agent-row group/compact-agent-row flex h-auto min-h-6 w-full min-w-0 cursor-pointer flex-wrap items-center gap-x-1 gap-y-0.5 overflow-hidden rounded-sm px-1 py-px text-left text-[11px] leading-none text-muted-foreground worktree-agent-row-hover" +
        lineageClasses
      }
      onClick={handleActivate}
      onMouseDown={stopCardDragPropagation}
      onPointerDown={stopCardDragPropagation}
      onDragStart={stopCardDragPropagation}
      onKeyDown={stopActivationKeyPropagation}
      data-focused-agent-pane={focused ? "true" : undefined}
      data-worktree-agent-row={row.session.id}
      aria-label={rowTitle}
      aria-current={focused ? "true" : undefined}
      title={rowTitle}
    >
      {disclosure}
      {identity}
      {text}
      {tail}
    </button>
  );
}, areWorktreeAgentRowPropsEqual);
