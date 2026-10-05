// The Work page: Drogon tickets on a board of configurable columns (Board),
// the same tickets as a table (List), and the external systems they link to
// (Sources). A column's "…" opens its prompt panel; a ticket opens its own
// panel, where each linked session opens (or resumes) in one click.
//
// The board picker holds My work and every imported board (Jira, Linear,
// GitHub; the Sources tab says which sources are allowed and connects
// them). An imported sprint board shows one sprint at a time (the active one by
// default), the backlog, or a closed sprint — read-only, with its outcome —
// and every card says where it stands against its source (unsynced, conflict,
// refused, unmapped, gone) with the action that settles it.
import { type ReactNode, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  CircleCheck,
  Clock3,
  ExternalLink,
  FileText,
  Filter,
  Import,
  Folder,
  GitPullRequest,
  LayoutList,
  Link2,
  ListTree,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import type { Session } from "../../../../shared/session-contract";
import {
  WORK_COLUMN_ICONS,
  WORK_LOCAL_BOARD,
  type WorkBoard,
  type WorkBoardSummary,
  type WorkBridge,
  type WorkColumn,
  type WorkSession,
  type WorkSource,
  type WorkSprint,
  type WorkTicket,
} from "../../../../shared/work-contract";
import { useWorkBoard } from "./use-work-board";
import {
  columnTriggerLabel,
  deliverySummary,
  formatClock,
  isLiveSession,
  matchesFilter,
  matchesSearch,
  sessionCountLabel,
  sourceKind,
  ticketIsWorking,
  WORK_FILTER_LABELS,
  type WorkFilter,
} from "./work-format";
import { WorkColumnIcon, iconForColumnName, workColumnIconLabel } from "./work-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { WorkColumnPanel } from "./WorkColumnPanel";
import { WorkTicketPanel, type WorkWorkspace } from "./WorkTicketPanel";
import { WorkImportDialog } from "./WorkImportDialog";
import { useDragAutoScroll } from "./work-drag-autoscroll";
import { listWorkspaceSessions, type SessionsReply } from "./work-session-candidates";
import { isTaskSource, requestTaskSourceConnect } from "../tasks/task-source-navigation";
import { WorkCreateIssueDialog } from "./WorkCreateIssueDialog";
import { WorkSyncActions, type WorkSyncHandlers } from "./WorkSyncActions";
import {
  BackToActive,
  ClosedSprintBanner,
  SprintOutcomePanel,
  SprintSummary,
} from "./WorkSprintViews";
import {
  Avatar,
  boardLabel,
  CarriedPill,
  IssueTypeBadge,
  PriorityBadge,
  ProviderMark,
  providerLabel,
  capitalize,
  sprintLabel,
  sprintTerm,
  sprintStateDot,
  ticketDisplayKey,
} from "./work-sources";
import {
  allowedSources,
  importLabel,
  SyncSourcesCard,
  useSyncCardDismissed,
  useWorkSources,
  WorkSourcesPanel,
} from "./WorkSources";

const TICKET_MIME = "application/x-drogon-work-ticket";
const COLUMN_MIME = "application/x-drogon-work-column";
/** What the board's edges scroll for while dragged. */
const BOARD_DRAG_TYPES = [TICKET_MIME, COLUMN_MIME] as const;

/** The line a column shows on the side a dragged column would land. */
function columnDropClass(side: "before" | "after" | null): string {
  if (side === "before") return "shadow-[inset_2px_0_0_0_var(--color-ring)]";
  if (side === "after") return "shadow-[inset_-2px_0_0_0_var(--color-ring)]";
  return "";
}

/** Where a column dragged from `from` lands when dropped on the `side` of
 *  the column at `target` (board positions), or null when it stays put. */
export function columnDropIndex(from: number, target: number, side: "before" | "after"): number | null {
  const at = side === "before" ? target : target + 1;
  const index = from < at ? at - 1 : at;
  return index === from ? null : index;
}

type Panel = { kind: "column"; id: string } | { kind: "ticket"; id: string } | null;
type Tab = "board" | "list" | "sources";
/** Which board and which slice of it: `sprintId` is a sprint id, `backlog`,
 *  or unset (the active sprint); `summary` shows a closed sprint's summary. */
type Selection = { boardId: string; sprintId?: string; summary?: boolean };

export type WorkSessionTarget = { workspaceId: string; sessionId: string };

/** The view the page returns to after a remount (Settings, a reload of the
 *  shell): the tab, the open panel and the board, for this renderer's
 *  lifetime. The board also survives a restart (an update reinstalls the
 *  app): it is kept in the renderer's storage, read once per launch. */
const lastView: { tab: Tab; panel: Panel; selection: Selection; seeded: boolean } = {
  tab: "board",
  panel: null,
  selection: { boardId: WORK_LOCAL_BOARD },
  seeded: false,
};

export const WORK_BOARD_KEY = "drogon:work:board";

function remembered(): Selection {
  if (!lastView.seeded) {
    lastView.seeded = true;
    try {
      const stored = localStorage.getItem(WORK_BOARD_KEY);
      if (stored) lastView.selection = { boardId: stored };
    } catch {
      // Storage unavailable: My work, as before.
    }
  }
  return lastView.selection;
}

function remember(selection: Selection): void {
  if (selection.boardId === lastView.selection.boardId && lastView.seeded) {
    lastView.selection = selection;
    return;
  }
  lastView.selection = selection;
  lastView.seeded = true;
  try {
    if (selection.boardId === WORK_LOCAL_BOARD) localStorage.removeItem(WORK_BOARD_KEY);
    else localStorage.setItem(WORK_BOARD_KEY, selection.boardId);
  } catch {
    // Storage unavailable: remembered until the app closes.
  }
}

/** Test seam: forget the remembered view (this launch's and the stored board). */
export function resetWorkViewMemoryForTests(): void {
  lastView.tab = "board";
  lastView.panel = null;
  lastView.selection = { boardId: WORK_LOCAL_BOARD };
  lastView.seeded = false;
  try {
    localStorage.removeItem(WORK_BOARD_KEY);
  } catch {
    // Nothing stored to forget.
  }
}

export function WorkPage({
  bridge,
  active = true,
  workspaces,
  onOpenSession,
  onOpenExternal = (url) => {
    void (window as unknown as { drogon?: { shell?: { openExternal?: (u: string) => unknown } } }).drogon?.shell?.openExternal?.(url);
  },
  listSessions,
  onOpenTasks,
  onClose,
}: {
  bridge: WorkBridge | null;
  active?: boolean;
  workspaces: WorkWorkspace[];
  /** Selects the session's workspace and focuses its terminal tab. */
  onOpenSession: (target: WorkSessionTarget) => void;
  onOpenExternal?: (url: string) => void;
  listSessions?: () => Promise<Session[]>;
  /** Opens the Tasks page, where Jira connects. */
  onOpenTasks?: () => void;
  onClose?: () => void;
}) {
  const [selection, setSelectionState] = useState<Selection>(remembered);
  const setSelection = (next: Selection) => {
    remember(next);
    setSelectionState(next);
  };
  const state = useWorkBoard(bridge, active, {
    boardId: selection.boardId === WORK_LOCAL_BOARD ? undefined : selection.boardId,
    sprintId: selection.sprintId,
  });
  const [tab, setTabState] = useState<Tab>(lastView.tab);
  const setTab = (next: Tab) => {
    lastView.tab = next;
    setTabState(next);
  };
  const [project, setProject] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<WorkFilter>("all");
  const [panel, setPanelState] = useState<Panel>(lastView.panel);
  const setPanel = (next: Panel) => {
    lastView.panel = next;
    setPanelState(next);
  };
  const [newTicketColumn, setNewTicketColumn] = useState<string | null>(null);
  const [newColumnOpen, setNewColumnOpen] = useState(false);
  /** The import dialog: a source, and the board to start from (Import
   *  more issues) or none (pick one). */
  const [importing, setImporting] = useState<null | {
    source: WorkSource;
    board?: { externalId: string; projectId?: string | null };
  }>(null);
  const sourcesState = useWorkSources(bridge, active);
  // Connecting through Tasks leaves this page mounted but hidden, so the
  // import dialog (a portal) must close first or it covers the Tasks page;
  // Tasks then opens on the source with its connect dialog up.
  const openTasksToConnect = (sourceId: string | undefined) => {
    setImporting(null);
    if (sourceId && isTaskSource(sourceId)) requestTaskSourceConnect(sourceId);
    onOpenTasks?.();
  };
  // The Sources tab's Tasks-page "Connect" belongs to the source that
  // connects through Tasks (Jira).
  const tasksConnectSourceId = sourcesState.sources.find((s) => s.connect === "tasks")?.id;
  const allowed = allowedSources(sourcesState.sources);
  const [cardDismissed, dismissCard, restoreCard] = useSyncCardDismissed();
  const [syncing, setSyncing] = useState(false);

  const notice = (message: string, kind: "error" | "success" = "success") => {
    if (kind === "error") toast.error(message);
    else toast.success(message);
  };
  // Linkable sessions, one workspace at a time (see work-session-candidates).
  const listCandidates = listSessions ?? (() => listWorkspaceSessions(workspaces.map((w) => w.id), defaultSessionsOf));

  const board = state.board;
  // A board removed elsewhere (the CLI, another window): back to My work.
  if (!board && selection.boardId !== WORK_LOCAL_BOARD && /work board .* not found/.test(state.error ?? "")) {
    setSelection({ boardId: WORK_LOCAL_BOARD });
  }
  const summary = board?.board;
  const imported = Boolean(summary?.provider);
  const supportsImport = Boolean(board?.boards);
  const view = board?.view;
  const readOnly = view?.readOnly === true;
  const sprints = view?.sprints ?? [];
  const activeSprint = sprints.find((s) => s.state === "active") ?? null;
  const closedSprints = sprints.filter((s) => s.state === "closed");
  const visibleTickets = useMemo(
    () =>
      (board?.tickets ?? []).filter(
        (t) => (!project || t.projectId === project) && matchesSearch(t, query) && matchesFilter(t, filter),
      ),
    [board, project, query, filter],
  );

  const syncHandlers: WorkSyncHandlers = {
    onPush: async (ticket) => {
      if (!bridge) return;
      const result = await state.run(() => bridge.ticketPush({ ticketId: ticket.id }));
      if (!result.ok) notice(result.error, "error");
      else if (result.value.pushed) notice(`${ticketDisplayKey(ticket)} pushed to ${providerLabel(ticket.provider)}`);
      else if (result.value.error) notice(`${providerLabel(ticket.provider)} refused: ${result.value.error}`, "error");
    },
    onResolve: async (ticket, keep) => {
      if (!bridge) return;
      const result = await state.run(() => bridge.ticketResolve({ ticketId: ticket.id, keep }));
      if (!result.ok) notice(result.error, "error");
      else if (keep === "ours" && result.value.sync === "error") notice(result.value.pushError ?? "Push refused", "error");
      else notice(keep === "theirs" ? `Kept ${providerLabel(ticket.provider)}'s status` : "Pushed your move");
    },
    onMapStatus: async (ticket, column) => {
      if (!bridge || !ticket.externalStatus) return;
      const ids = (column.statuses ?? []).map((s) => s.id).concat(ticket.externalStatus.id);
      const result = await state.run(() => bridge.columnUpdate({ columnId: column.id, statusIds: ids }));
      if (!result.ok) notice(result.error, "error");
      else notice(`'${ticket.externalStatus.name}' now maps to ${column.name}`);
    },
  };

  /** The source of the board shown (for Import more issues). */
  const summarySource = (): WorkSource | undefined =>
    summary?.provider ? sourcesState.sources.find((s) => s.id === summary.provider) : undefined;
  const importMore = () => {
    const source = summarySource();
    if (source && summary) setImporting({ source, board: { externalId: summary.externalId ?? "", projectId: summary.projectId } });
    else if (summary?.provider) notice(`${providerLabel(summary.provider)} is turned off; turn it on in Sources`, "error");
  };
  const [savingLocation, setSavingLocation] = useState(false);
  const boardWorkspaces = workspaces.filter((w) => !summary?.projectId || w.projectId === summary.projectId);
  const setBoardWorkspace = async (workspaceId: string | null) => {
    if (!bridge || !summary?.provider || savingLocation) return;
    setSavingLocation(true);
    try {
      const result = await state.run(() => bridge.boardUpdate({ boardId: summary.id, workspaceId }));
      if (!result.ok) notice(result.error, "error");
      else notice(workspaceId ? `New sessions use ${workspaces.find((w) => w.id === workspaceId)?.name ?? "the selected workspace"}` : "New sessions use the repository default");
    } finally {
      setSavingLocation(false);
    }
  };
  const setBoardProject = async (projectId: string | null) => {
    if (!bridge || !summary?.provider || savingLocation) return;
    setSavingLocation(true);
    const result = await state.run(() => bridge.boardUpdate({ boardId: summary.id, projectId }));
    setSavingLocation(false);
    if (!result.ok) notice(result.error, "error");
    else {
      const name = board?.projects.find((p) => p.id === projectId)?.name;
      notice(name ? `Sessions for ${summary.name} start in ${name}` : `${summary.name} has no project for sessions`);
    }
  };
  /** Folds the columns with no card on this view, or unfolds them all. */
  const foldColumns = async (which: "empty" | "all") => {
    if (!bridge || !board) return;
    const targets = board.columns.filter((c) =>
      which === "all" ? c.collapsed === true : !c.collapsed && !board.tickets.some((t) => t.columnId === c.id),
    );
    for (const column of targets) {
      const result = await bridge.columnUpdate({ columnId: column.id, collapsed: which === "empty" });
      if (!result.ok) {
        notice(result.error.message, "error");
        break;
      }
    }
    await state.reload();
  };
  const term = sprintTerm(summary?.provider);
  const Term = capitalize(term);

  const syncNow = async () => {
    if (!bridge || !summary?.provider) return;
    setSyncing(true);
    try {
      const result = await state.run(() => bridge.boardSync({ boardId: summary.id }));
      if (!result.ok) notice(result.error, "error");
      else {
        const r = result.value;
        const parts = [
          r.imported ? `${r.imported} new assigned to you` : null,
          r.moved ? `${r.moved} moved by ${providerLabel(summary.provider)}` : null,
          r.conflicts ? `${r.conflicts} conflict${r.conflicts === 1 ? "" : "s"}` : null,
          r.removed ? `${r.removed} gone from ${providerLabel(summary.provider)}` : null,
        ].filter(Boolean);
        notice(`Synced ${summary.name}${parts.length ? `: ${parts.join(", ")}` : ""}`);
      }
    } finally {
      setSyncing(false);
    }
  };

  const pushAll = async () => {
    if (!bridge || !summary?.provider) return;
    const result = await state.run(() => bridge.boardPush({ boardId: summary.id }));
    if (!result.ok) notice(result.error, "error");
    else if (result.value.failed) notice(`Pushed ${result.value.pushed}; ${result.value.failed} refused (see the cards)`, "error");
    else notice(`Pushed ${result.value.pushed} move${result.value.pushed === 1 ? "" : "s"}`);
  };

  const moveSprint = async (ticket: WorkTicket, to: string) => {
    if (!bridge) return;
    const result = await state.run(() => bridge.ticketSprint({ ticketId: ticket.id, to }));
    if (!result.ok) notice(result.error, "error");
    else
      notice(
        `${ticketDisplayKey(ticket)} ${to === "backlog" ? "sent to the backlog" : `moved to ${result.value.sprintName ?? "the sprint"}`}; push to sync`,
      );
  };

  const openTicket = (ticket: WorkTicket) => {
    // A ticket from a closed sprint opens where it lives now.
    if (readOnly && ticket.sprintId && ticket.sprintId !== view?.sprint?.id) {
      setSelection({ boardId: selection.boardId, sprintId: ticket.sprintId === activeSprint?.id ? undefined : ticket.sprintId });
    }
    setPanel({ kind: "ticket", id: ticket.id });
  };

  const openSession = async (session: WorkSession, ticket: WorkTicket) => {
    if (!bridge) return;
    if (isLiveSession(session) && session.workspaceId) {
      onOpenSession({ workspaceId: session.workspaceId, sessionId: session.id });
      return;
    }
    const result = await state.run(() => bridge.sessionOpen({ ticketId: ticket.id, sessionId: session.id }));
    if (!result.ok) {
      notice(result.error, "error");
      return;
    }
    const opened = result.value;
    if (opened.action === "resumed") notice(`Resumed ${ticket.key}'s session`);
    else if (opened.action === "started") notice(`Nothing to resume: started a new session for ${ticket.key}`);
    const workspaceId = (opened.session.workspaceId as string | undefined) ?? session.workspaceId;
    if (workspaceId) onOpenSession({ workspaceId, sessionId: opened.session.id });
  };

  const move = async (ticketId: string, columnId: string, index?: number) => {
    if (!bridge || readOnly) return;
    const sprintId = view?.sprint?.id;
    const result = await state.run(() =>
      bridge.ticketMove({ ticketId, columnId, index, ...(sprintId ? { sprintId } : {}) }),
    );
    if (!result.ok) notice(result.error, "error");
    else if (result.value.delivery)
      notice(`${ticketDisplayKey(result.value)}: ${deliverySummary(result.value.delivery.results)}`);
  };

  const panelColumn = panel?.kind === "column" ? board?.columns.find((c) => c.id === panel.id) : undefined;
  const panelTicket = panel?.kind === "ticket" ? board?.tickets.find((t) => t.id === panel.id) : undefined;
  const closedSprint = readOnly ? (view?.sprint ?? null) : null;
  const showSummary = Boolean(closedSprint && selection.summary && view?.outcome);
  const emptyStart =
    supportsImport && !imported && (board?.tickets.length ?? 0) === 0 && (board?.boards?.length ?? 0) <= 1;

  const selectSprint = (sprintId?: string, summaryView = false) =>
    setSelection({ boardId: selection.boardId, sprintId, summary: summaryView || undefined });

  return (
    <main className="flex h-full min-h-0 w-full flex-col bg-background" aria-label="Work">
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="shrink-0 px-6 pt-5">
            <div className="flex items-center gap-3">
              {onClose ? (
                <Button variant="ghost" size="icon-xs" aria-label="Close work" onClick={onClose}>
                  <X />
                </Button>
              ) : null}
              <h1 className="flex-1 text-2xl font-semibold tracking-tight text-foreground">Work</h1>
              {imported && summary ? (
                <div className="flex items-center">
                  <Button
                    variant="outline"
                    className="rounded-r-none"
                    onClick={() => void syncNow()}
                    disabled={syncing}
                    aria-label={`Sync ${summary.name}`}
                  >
                    {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />} Sync
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" className="rounded-l-none border-l-0 px-2" aria-label="Sync options">
                        <ChevronDown />
                        {summary.pendingCount > 0 ? (
                          <span className="rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white" data-testid="work-pending-count">
                            {summary.pendingCount}
                          </span>
                        ) : null}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem disabled={summary.pendingCount === 0} onSelect={() => void pushAll()}>
                        Push all pending moves ({summary.pendingCount}) to {providerLabel(summary.provider)}
                      </DropdownMenuItem>
                      <DropdownMenuCheckboxItem
                        checked={summary.autoImportMine === true}
                        onSelect={async () => {
                          if (!bridge) return;
                          const on = summary.autoImportMine !== true;
                          const result = await state.run(() => bridge.boardUpdate({ boardId: summary.id, autoImportMine: on }));
                          if (!result.ok) notice(result.error, "error");
                          else notice(on ? "New issues assigned to you come in on every sync" : "Only the issues you import");
                        }}
                      >
                        Import new issues assigned to me
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>Agents work in</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuRadioGroup
                            value={summary.projectId ?? ""}
                            onValueChange={(value) => void setBoardProject(value || null)}
                          >
                            {(board?.projects ?? []).map((p) => (
                              <DropdownMenuRadioItem key={p.id} value={p.id}>
                                {p.name}
                              </DropdownMenuRadioItem>
                            ))}
                            <DropdownMenuRadioItem value="">No project</DropdownMenuRadioItem>
                          </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger disabled={savingLocation}>Agent workspace</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuRadioGroup value={summary.workspaceId ?? ""} onValueChange={(value) => void setBoardWorkspace(value || null)}>
                            <DropdownMenuRadioItem value="">Repository default</DropdownMenuRadioItem>
                            {boardWorkspaces.map((w) => (
                              <DropdownMenuRadioItem key={w.id} value={w.id}>{w.name}</DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      <DropdownMenuItem
                        onSelect={importMore}
                      >
                        Import more issues…
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive"
                        onSelect={async () => {
                          if (!bridge) return;
                          const result = await state.run(() => bridge.boardDelete({ boardId: summary.id }));
                          if (!result.ok) notice(result.error, "error");
                          else {
                            notice(`Removed ${summary.name} from the board; ${providerLabel(summary.provider)} is untouched`);
                            setSelection({ boardId: WORK_LOCAL_BOARD });
                          }
                        }}
                      >
                        Remove board
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ) : supportsImport && bridge && allowed.length ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" aria-label="Import board">
                      <Import /> Import board <ChevronDown className="opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {allowed.map((s) => (
                      <DropdownMenuItem key={s.id} onSelect={() => setImporting({ source: s })}>
                        <ProviderMark provider={s.id} className="size-4" /> {importLabel(s)}…
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setTab("sources")}>Manage sources…</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              <Button
                onClick={() => setNewTicketColumn(board?.columns[0]?.id ?? "")}
                disabled={!board || readOnly}
              >
                <Plus /> New ticket
              </Button>
            </div>
            <div className="mt-3 flex gap-5 border-b border-border" role="tablist" aria-label="Work views">
              {(["board", "list", "sources"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  className={`-mb-px border-b-2 px-1 pb-2 text-sm font-medium capitalize transition-colors ${
                    tab === t
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 py-3">
              {board?.boards ? (
                <BoardPicker
                  boards={board.boards}
                  current={summary ?? null}
                  onSelect={(b) => {
                    setPanel(null);
                    setSelection({ boardId: b.id });
                  }}
                  sources={allowed}
                  onImport={(source) => setImporting({ source })}
                />
              ) : null}
              {imported && summary?.kind === "scrum" ? (
                <>
                  <SprintPicker
                    sprints={sprints}
                    view={view?.kind === "backlog" ? "backlog" : (view?.sprint ?? null)}
                    term={Term}
                    onSelect={(sprint) =>
                      selectSprint(sprint === "backlog" ? "backlog" : sprint.id)
                    }
                  />
                  {readOnly || view?.kind === "backlog" ? (
                    <BackToActive term={term} onClick={() => selectSprint(undefined)} />
                  ) : (
                    <>
                      <Button variant="link" size="sm" className="h-auto px-1 text-muted-foreground underline" onClick={() => selectSprint("backlog")}>
                        Backlog
                      </Button>
                      {closedSprints.length ? (
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto px-1 text-blue-500 underline"
                          onClick={() => selectSprint(closedSprints[closedSprints.length - 1]!.id, true)}
                        >
                          Past {term}s
                        </Button>
                      ) : null}
                    </>
                  )}
                </>
              ) : null}
              {!imported ? (
                <select
                  aria-label="Project filter"
                  className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                  value={project}
                  onChange={(event) => setProject(event.target.value)}
                >
                  <option value="">All projects</option>
                  {(board?.projects ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <div className="relative w-full max-w-xs">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Search work"
                  className="h-9 pl-8"
                  placeholder="Search work…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div className="flex-1" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" aria-label="Filter">
                    <Filter /> {filter === "all" ? "Filter" : WORK_FILTER_LABELS[filter]}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuRadioGroup value={filter} onValueChange={(v) => setFilter(v as WorkFilter)}>
                    {(Object.keys(WORK_FILTER_LABELS) as WorkFilter[])
                      .filter((f) => imported || f !== "unsynced")
                      .map((f) => (
                        <DropdownMenuRadioItem key={f} value={f}>
                          {WORK_FILTER_LABELS[f]}
                        </DropdownMenuRadioItem>
                      ))}
                  </DropdownMenuRadioGroup>
                  {board && !readOnly ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => void foldColumns("empty")}>Collapse empty columns</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void foldColumns("all")}>Expand all columns</DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {imported && summary ? (
              <section
                className={`mb-2 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs ${!summary.projectId ? "border-amber-500/40 bg-amber-500/8 text-amber-700 dark:text-amber-300" : "border-border text-muted-foreground"}`}
                aria-label="Agent location"
                data-testid={!summary.projectId ? "work-board-no-project" : "work-board-location"}
              >
                {!summary.projectId ? <span>Agents on this board need an Orca project to work in.</span> : null}
                <label className="flex min-w-0 items-center gap-2">
                  Repository
                  <select
                    aria-label="Agents work in"
                    className="h-8 min-w-0 max-w-64 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                    value={summary.projectId ?? ""}
                    disabled={savingLocation}
                    onChange={(event) => void setBoardProject(event.target.value || null)}
                  >
                    <option value="">Choose a project…</option>
                    {(board?.projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <label className="flex min-w-0 items-center gap-2">
                  Workspace
                  <select
                    aria-label="Board workspace"
                    className="h-8 min-w-0 max-w-80 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                    value={summary.workspaceId ?? ""}
                    disabled={savingLocation}
                    onChange={(event) => void setBoardWorkspace(event.target.value || null)}
                  >
                    <option value="">Repository default</option>
                    {summary.workspaceId && !boardWorkspaces.some((w) => w.id === summary.workspaceId) ? <option value={summary.workspaceId} disabled>Selected workspace unavailable</option> : null}
                    {boardWorkspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                  </select>
                </label>
                <span className="basis-full">Used for new sessions. Ticket-specific workspaces and existing sessions stay where they are.</span>
                {boardWorkspaces.length === 0 ? <span>No active workspaces found. Open a worktree in Orca to use it here.</span> : null}
              </section>
            ) : null}
            {summary?.lastSyncError ? (
              <p className="mb-2 text-xs text-destructive" role="alert">
                Last sync with {providerLabel(summary.provider)} failed: {summary.lastSyncError}
              </p>
            ) : null}
          </header>

          {state.error && !board ? (
            <p className="px-6 text-sm text-destructive" role="alert">
              {state.error}
            </p>
          ) : !board ? (
            <p className="px-6 text-sm text-muted-foreground">Loading work…</p>
          ) : showSummary && closedSprint && view?.outcome ? (
            <SprintSummary
              sprint={closedSprint}
              activeSprint={activeSprint}
              outcome={view.outcome}
              tickets={board.tickets}
              onOpenTicket={openTicket}
              onCarry={(t) => void moveSprint(t, "active")}
              onBacklog={(t) => void moveSprint(t, "backlog")}
            />
          ) : tab === "board" ? (
            <>
              {closedSprint ? <ClosedSprintBanner sprint={closedSprint} term={term} onSummary={() => selectSprint(closedSprint.id, true)} /> : null}
              {view?.kind === "backlog" ? (
                <p className="mx-6 mb-3 text-xs text-muted-foreground" role="status">
                  Backlog · prompts fire only in the active {term}
                </p>
              ) : null}
              <div className="relative flex min-h-0 flex-1">
                <BoardView
                  board={board}
                  tickets={visibleTickets}
                  selected={panel}
                  readOnly={readOnly}
                  closedSprint={closedSprint}
                  syncHandlers={syncHandlers}
                  onMove={move}
                  onSprint={(ticket, to) => void moveSprint(ticket, to)}
                  onOpenColumn={(id) => setPanel({ kind: "column", id })}
                  onOpenTicket={(id) => setPanel({ kind: "ticket", id })}
                  onNewTicket={(columnId) => setNewTicketColumn(columnId)}
                  onNewColumn={() => setNewColumnOpen(true)}
                  onColumnAction={async (column, action) => {
                    if (!bridge) return;
                    if (action === "delete") {
                      const target = board.columns.find((c) => c.id !== column.id);
                      const result = await state.run(() =>
                        bridge.columnDelete({
                          columnId: column.id,
                          moveTicketsTo: column.ticketCount > 0 ? target?.id : undefined,
                        }),
                      );
                      if (!result.ok) notice(result.error, "error");
                      else if (panel?.kind === "column" && panel.id === column.id) setPanel(null);
                      return;
                    }
                    const index = action === "left" ? column.position - 1 : column.position + 1;
                    const result = await state.run(() => bridge.columnUpdate({ columnId: column.id, index: Math.max(0, index) }));
                    if (!result.ok) notice(result.error, "error");
                  }}
                  onRenameColumn={async (column, name) => {
                    if (!bridge) return;
                    const result = await state.run(() => bridge.columnUpdate({ columnId: column.id, name }));
                    if (!result.ok) notice(result.error, "error");
                  }}
                  onIconColumn={async (column, icon) => {
                    if (!bridge) return;
                    const result = await state.run(() => bridge.columnUpdate({ columnId: column.id, icon }));
                    if (!result.ok) notice(result.error, "error");
                  }}
                  onReorderColumn={async (columnId, index) => {
                    if (!bridge) return;
                    const result = await state.run(() => bridge.columnUpdate({ columnId, index }));
                    if (!result.ok) notice(result.error, "error");
                  }}
                  onCollapseColumn={async (column, collapsed) => {
                    if (!bridge) return;
                    const result = await state.run(() => bridge.columnUpdate({ columnId: column.id, collapsed }));
                    if (!result.ok) notice(result.error, "error");
                  }}
                  onDeleteTicket={async (ticket) => {
                    if (!bridge) return;
                    const result = await state.run(() => bridge.ticketDelete({ ticketId: ticket.id }));
                    if (!result.ok) notice(result.error, "error");
                  }}
                />
                {emptyStart && !cardDismissed && allowed.length ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <SyncSourcesCard
                      sources={allowed}
                      onImport={(source) => setImporting({ source })}
                      onDismiss={dismissCard}
                      onManage={() => setTab("sources")}
                    />
                  </div>
                ) : null}
              </div>
            </>
          ) : tab === "list" ? (
            <ListView board={board} tickets={visibleTickets} onOpenTicket={(id) => setPanel({ kind: "ticket", id })} />
          ) : (
            <SourcesView
              tickets={visibleTickets}
              onOpenTicket={(id) => setPanel({ kind: "ticket", id })}
              onOpenExternal={onOpenExternal}
              manage={
                bridge ? (
                  <WorkSourcesPanel
                    state={sourcesState}
                    bridge={bridge}
                    onOpenExternal={onOpenExternal}
                    onOpenTasks={onOpenTasks ? () => openTasksToConnect(tasksConnectSourceId) : undefined}
                    onNotice={notice}
                  />
                ) : null
              }
              cardDismissed={cardDismissed && allowed.length > 0}
              onRestoreCard={restoreCard}
            />
          )}
        </div>
        {bridge && board && panelColumn ? (
          <WorkColumnPanel
            column={panelColumn}
            board={board}
            state={state}
            bridge={bridge}
            onClose={() => setPanel(null)}
            onNotice={notice}
          />
        ) : null}
        {bridge && board && panelTicket ? (
          <WorkTicketPanel
            ticket={panelTicket}
            board={board}
            state={state}
            bridge={bridge}
            workspaces={workspaces}
            listLinkCandidates={listCandidates}
            readOnly={readOnly}
            syncHandlers={syncHandlers}
            onOpenSession={(session, ticket) => void openSession(session, ticket)}
            onOpenExternal={onOpenExternal}
            onClose={() => setPanel(null)}
            onNotice={notice}
          />
        ) : null}
        {board && !panelColumn && !panelTicket && closedSprint && view?.outcome && !showSummary && tab === "board" ? (
          <SprintOutcomePanel outcome={view.outcome} tickets={board.tickets} term={term} onOpenTicket={openTicket} />
        ) : null}
      </div>
      {bridge && board && summary && imported ? (
        <WorkCreateIssueDialog
          open={newTicketColumn !== null}
          bridge={bridge}
          board={board}
          summary={summary}
          initialColumn={newTicketColumn ?? ""}
          onClose={() => setNewTicketColumn(null)}
          onCreate={async (input) => {
            const result = await state.run(() => bridge.ticketCreate(input));
            if (!result.ok) return result.error;
            setNewTicketColumn(null);
            setPanel({ kind: "ticket", id: result.value.id });
            const warnings = result.value.warnings ?? [];
            if (warnings.length) notice(`Created ${result.value.externalKey ?? result.value.key}. ${warnings.join(" ")}`, "error");
            else notice(`Created ${result.value.externalKey ?? result.value.key} in ${providerLabel(summary.provider)}`);
            return null;
          }}
        />
      ) : null}
      {bridge && board && !imported ? (
        <NewTicketDialog
          open={newTicketColumn !== null}
          board={board}
          workspaces={workspaces}
          initialColumn={newTicketColumn ?? ""}
          initialProject={project}
          onClose={() => setNewTicketColumn(null)}
          onCreate={async (input) => {
            const result = await state.run(() => bridge.ticketCreate(input));
            if (!result.ok) return result.error;
            setNewTicketColumn(null);
            setPanel({ kind: "ticket", id: result.value.id });
            notice(`Created ${result.value.key}`);
            return null;
          }}
        />
      ) : null}
      {bridge ? (
        <NewColumnDialog
          open={newColumnOpen}
          onClose={() => setNewColumnOpen(false)}
          onCreate={async (name, icon) => {
            const boardId = imported ? summary?.id : undefined;
            const result = await state.run(() => bridge.columnCreate({ name, icon, ...(boardId ? { boardId } : {}) }));
            if (!result.ok) return result.error;
            setNewColumnOpen(false);
            setPanel({ kind: "column", id: result.value.id });
            return null;
          }}
        />
      ) : null}
      {bridge && importing ? (
        <WorkImportDialog
          open
          bridge={bridge}
          source={importing.source}
          projects={board?.projects ?? []}
          initialBoard={importing.board ?? null}
          onClose={() => setImporting(null)}
          onOpenExternal={onOpenExternal}
          onOpenTasks={onOpenTasks ? () => openTasksToConnect(importing.source.id) : undefined}
          onSourceChanged={() => void sourcesState.reload()}
          onImported={(imported, count) => {
            setImporting(null);
            setPanel(null);
            setSelection({ boardId: imported.id });
            notice(`Imported ${count} ${count === 1 ? "issue" : "issues"} into ${imported.name}`);
            void state.reload();
            void sourcesState.reload();
          }}
        />
      ) : null}
    </main>
  );
}

function defaultSessionsOf(workspaceId: string): Promise<SessionsReply | undefined> {
  const drogon = (window as unknown as { drogon?: { sessions?: (w?: string) => Promise<SessionsReply> } }).drogon;
  return drogon?.sessions?.(workspaceId) ?? Promise.resolve(undefined);
}

// ----------------------------------------------------------------- board --

function BoardView({
  board,
  tickets,
  selected,
  readOnly,
  closedSprint,
  syncHandlers,
  onMove,
  onSprint,
  onOpenColumn,
  onOpenTicket,
  onNewTicket,
  onNewColumn,
  onColumnAction,
  onRenameColumn,
  onIconColumn,
  onCollapseColumn,
  onDeleteTicket,
  onReorderColumn,
}: {
  onReorderColumn: (columnId: string, index: number) => void;
  board: WorkBoard;
  tickets: WorkTicket[];
  selected: Panel;
  readOnly: boolean;
  closedSprint: WorkSprint | null;
  syncHandlers: WorkSyncHandlers;
  onMove: (ticketId: string, columnId: string, index?: number) => void;
  onSprint: (ticket: WorkTicket, to: string) => void;
  onOpenColumn: (id: string) => void;
  onOpenTicket: (id: string) => void;
  onNewTicket: (columnId: string) => void;
  onNewColumn: () => void;
  onColumnAction: (column: WorkColumn, action: "left" | "right" | "delete") => void;
  onRenameColumn: (column: WorkColumn, name: string) => void;
  onIconColumn: (column: WorkColumn, icon: string) => void;
  onCollapseColumn: (column: WorkColumn, collapsed: boolean) => void;
  onDeleteTicket: (ticket: WorkTicket) => void;
}) {
  const boardRef = useRef<HTMLDivElement>(null);
  useDragAutoScroll(boardRef, "x", BOARD_DRAG_TYPES);
  return (
    <div ref={boardRef} className="flex min-h-0 flex-1 gap-0 overflow-x-auto px-3 pb-4" data-testid="work-board">
      {board.columns.map((column, index) => (
        <BoardColumn
          key={column.id}
          board={board}
          column={column}
          first={index === 0}
          last={index === board.columns.length - 1}
          tickets={tickets
            .filter((t) => t.columnId === column.id)
            .sort((a, b) => a.position - b.position)}
          configuring={selected?.kind === "column" && selected.id === column.id}
          selectedTicket={selected?.kind === "ticket" ? selected.id : null}
          readOnly={readOnly}
          closedSprint={closedSprint}
          syncHandlers={syncHandlers}
          onMove={onMove}
          onSprint={onSprint}
          onOpenColumn={onOpenColumn}
          onOpenTicket={onOpenTicket}
          onNewTicket={onNewTicket}
          onColumnAction={onColumnAction}
          onRenameColumn={onRenameColumn}
          onIconColumn={onIconColumn}
          onCollapseColumn={onCollapseColumn}
          onReorderColumn={onReorderColumn}
          onDeleteTicket={onDeleteTicket}
        />
      ))}
      {readOnly ? null : (
        <div className="w-12 shrink-0 pt-3">
          <Button variant="ghost" size="icon-sm" aria-label="New column" onClick={onNewColumn}>
            <Plus />
          </Button>
        </div>
      )}
    </div>
  );
}

function BoardColumn({
  board,
  column,
  first,
  last,
  tickets,
  configuring,
  selectedTicket,
  readOnly,
  closedSprint,
  syncHandlers,
  onMove,
  onSprint,
  onOpenColumn,
  onOpenTicket,
  onNewTicket,
  onColumnAction,
  onRenameColumn,
  onIconColumn,
  onCollapseColumn,
  onDeleteTicket,
  onReorderColumn,
}: {
  board: WorkBoard;
  column: WorkColumn;
  first: boolean;
  last: boolean;
  tickets: WorkTicket[];
  configuring: boolean;
  selectedTicket: string | null;
  readOnly: boolean;
  closedSprint: WorkSprint | null;
  syncHandlers: WorkSyncHandlers;
  onMove: (ticketId: string, columnId: string, index?: number) => void;
  onSprint: (ticket: WorkTicket, to: string) => void;
  onOpenColumn: (id: string) => void;
  onOpenTicket: (id: string) => void;
  onNewTicket: (columnId: string) => void;
  onColumnAction: (column: WorkColumn, action: "left" | "right" | "delete") => void;
  onRenameColumn: (column: WorkColumn, name: string) => void;
  onIconColumn: (column: WorkColumn, icon: string) => void;
  onCollapseColumn: (column: WorkColumn, collapsed: boolean) => void;
  onDeleteTicket: (ticket: WorkTicket) => void;
  onReorderColumn: (columnId: string, index: number) => void;
}) {
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // A column dragged over this one lands on this side of it.
  const [columnSide, setColumnSide] = useState<"before" | "after" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  useDragAutoScroll(listRef, "y", BOARD_DRAG_TYPES);
  const trigger = columnTriggerLabel(column);

  const indexAt = (clientY: number): number => {
    const cards = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-work-ticket]") ?? [])];
    const at = cards.findIndex((card) => {
      const rect = card.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    });
    return at === -1 ? cards.length : at;
  };

  const sideAt = (event: React.DragEvent<HTMLElement>): "before" | "after" => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? "before" : "after";
  };

  const dropHandlers = {
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (!readOnly && event.dataTransfer.types.includes(COLUMN_MIME)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setColumnSide(sideAt(event));
        return;
      }
      if (readOnly || !event.dataTransfer.types.includes(TICKET_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropIndex(indexAt(event.clientY));
    },
    onDragLeave: (event: React.DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setDropIndex(null);
        setColumnSide(null);
      }
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      const draggedColumn = event.dataTransfer.getData(COLUMN_MIME);
      if (draggedColumn) {
        event.preventDefault();
        setColumnSide(null);
        const from = board.columns.find((c) => c.id === draggedColumn);
        const index = from ? columnDropIndex(from.position, column.position, sideAt(event)) : null;
        if (index !== null) onReorderColumn(draggedColumn, index);
        return;
      }
      const ticketId = event.dataTransfer.getData(TICKET_MIME);
      const index = indexAt(event.clientY);
      setDropIndex(null);
      if (!ticketId) return;
      event.preventDefault();
      const ticket = board.tickets.find((t) => t.id === ticketId);
      // Dropping below itself in the same column shifts the index by one.
      const own = ticket?.columnId === column.id ? tickets.findIndex((t) => t.id === ticketId) : -1;
      onMove(ticketId, column.id, own !== -1 && own < index ? index - 1 : index);
    },
  };

  // A collapsed column is a narrow strip: its name, its count, and still a
  // place to drop a card.
  if (column.collapsed) {
    return (
      <section
        className={`flex w-11 shrink-0 flex-col items-center gap-2 border-r border-border/60 pt-3 last:border-r-0 ${dropIndex !== null ? "bg-accent/30" : ""} ${columnDropClass(columnSide)}`}
        aria-label={`${column.name} column`}
        data-work-column={column.id}
        data-collapsed="true"
        {...dropHandlers}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Expand ${column.name} column`}
          title={`Expand ${column.name}`}
          onClick={() => onCollapseColumn(column, false)}
        >
          <WorkColumnIcon icon={column.icon} className="size-4" />
        </Button>
        <span className="rounded-md bg-muted px-1.5 text-xs text-muted-foreground" aria-label={`${tickets.length} tickets`}>
          {tickets.length}
        </span>
        <span className="text-xs font-medium text-muted-foreground [writing-mode:vertical-rl]">{column.name}</span>
      </section>
    );
  }

  return (
    <section
      className={`flex w-[272px] shrink-0 flex-col border-r border-border/60 px-2 last:border-r-0 ${dropIndex !== null ? "bg-accent/30" : ""} ${columnDropClass(columnSide)}`}
      aria-label={`${column.name} column`}
      data-work-column={column.id}
      {...dropHandlers}
    >
      <div
        className={`flex items-start gap-2 px-1 pt-3 pb-2 ${readOnly || renaming ? "" : "cursor-grab active:cursor-grabbing"}`}
        data-testid="work-column-header"
        draggable={!readOnly && !renaming}
        onDragStart={(event) => {
          event.dataTransfer.setData(COLUMN_MIME, column.id);
          event.dataTransfer.effectAllowed = "move";
        }}
      >
        <WorkColumnIcon icon={column.icon} className="mt-0.5 size-5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            {renaming ? (
              <input
                aria-label="Column name"
                autoFocus
                defaultValue={column.name}
                className="w-full rounded-sm bg-transparent text-sm font-semibold outline-none ring-1 ring-ring"
                onBlur={(event) => {
                  setRenaming(false);
                  const name = event.target.value.trim();
                  if (name && name !== column.name) onRenameColumn(column, name);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                  if (event.key === "Escape") setRenaming(false);
                }}
              />
            ) : (
              <h2 className="min-w-0 break-words text-sm font-semibold text-foreground">{column.name}</h2>
            )}
            <span className="rounded-md bg-muted px-1.5 text-xs text-muted-foreground" aria-label={`${tickets.length} tickets`}>
              {tickets.length}
            </span>
          </div>
          {trigger && !readOnly ? <p className="truncate text-xs text-muted-foreground">{trigger}</p> : null}
        </div>
        {readOnly ? null : (
          <Button variant="ghost" size="icon-xs" aria-label={`New ticket in ${column.name}`} onClick={() => onNewTicket(column.id)}>
            <Plus />
          </Button>
        )}
        {readOnly ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`${column.name} column actions`}
              className={configuring ? "ring-1 ring-ring" : undefined}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onOpenColumn(column.id)}>Configure prompt…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onCollapseColumn(column, true)}>Collapse</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Icon</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {WORK_COLUMN_ICONS.map((icon) => (
                  <DropdownMenuItem key={icon} onSelect={() => onIconColumn(column, icon)}>
                    <WorkColumnIcon icon={icon} className="size-4" /> {workColumnIconLabel(icon)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem disabled={first} onSelect={() => onColumnAction(column, "left")}>
              Move left
            </DropdownMenuItem>
            <DropdownMenuItem disabled={last} onSelect={() => onColumnAction(column, "right")}>
              Move right
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" onSelect={() => onColumnAction(column, "delete")}>
              Delete column
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        )}
      </div>
      <div ref={listRef} className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto pb-2">
        {tickets.map((ticket, index) => (
          <div key={ticket.id}>
            {dropIndex === index ? <DropLine /> : null}
            <TicketCard
              ticket={ticket}
              board={board}
              selected={selectedTicket === ticket.id}
              readOnly={readOnly}
              closedSprint={closedSprint}
              syncHandlers={syncHandlers}
              onOpen={() => onOpenTicket(ticket.id)}
              onMove={(columnId) => onMove(ticket.id, columnId)}
              onSprint={(to) => onSprint(ticket, to)}
              onDelete={() => onDeleteTicket(ticket)}
            />
          </div>
        ))}
        {dropIndex === tickets.length ? <DropLine /> : null}
        {tickets.length === 0 && board.board?.provider ? (
          <div className="flex flex-col items-center gap-1 px-3 pt-16 text-center text-xs text-muted-foreground" data-testid="work-column-empty">
            <CircleCheck className="mb-1 size-7 opacity-50" aria-hidden="true" />
            <p className="text-sm">{readOnly ? "No tickets" : "No tickets yet"}</p>
            <p>
              {board.board?.kind !== "scrum"
                ? "Drop a ticket here to move it."
                : readOnly
                  ? `Nothing ended this ${sprintTerm(board.board?.provider)} here.`
                  : `Tickets moved here will stay in this ${sprintTerm(board.board?.provider)}.`}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function DropLine() {
  return <div className="my-0.5 h-0.5 rounded-full bg-ring" data-testid="work-drop-indicator" />;
}

function TicketCard({
  ticket,
  board,
  selected,
  readOnly,
  closedSprint,
  syncHandlers,
  onOpen,
  onMove,
  onSprint,
  onDelete,
}: {
  ticket: WorkTicket;
  board: WorkBoard;
  selected: boolean;
  readOnly: boolean;
  closedSprint: WorkSprint | null;
  syncHandlers: WorkSyncHandlers;
  onOpen: () => void;
  onMove: (columnId: string) => void;
  onSprint: (to: string) => void;
  onDelete: () => void;
}) {
  const working = ticketIsWorking(ticket);
  const imported = Boolean(ticket.externalKey);
  const key = ticketDisplayKey(ticket);
  const scrum = board.board?.kind === "scrum";
  const view = board.view;
  const activeSprint = view?.sprints.find((s) => s.state === "active");
  // In a closed sprint, a ticket that moved on shows where it went.
  const carriedTo = closedSprint && ticket.sprintId && ticket.sprintId !== closedSprint.id ? ticket.sprintName : null;
  const finished = ticket.externalStatus?.category === "done";
  const sessions = ticket.sessions.length;
  return (
    <article
      className={`group rounded-lg border bg-card px-3 py-2.5 text-sm shadow-xs transition-colors ${
        selected ? "border-blue-500 ring-1 ring-blue-500/60" : "border-border hover:border-foreground/20"
      } ${ticket.removed ? "opacity-70" : ""}`}
      draggable={!readOnly}
      data-work-ticket={ticket.id}
      data-sync={ticket.sync}
      aria-label={`${key} ${ticket.title}`}
      onDragStart={(event) => {
        event.dataTransfer.setData(TICKET_MIME, ticket.id);
        event.dataTransfer.effectAllowed = "move";
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <ProviderMark provider={ticket.provider} />
          <span className={`truncate text-xs ${imported ? "font-medium text-muted-foreground" : "font-mono text-muted-foreground"}`}>
            {key}
          </span>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={`${key} actions`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onOpen}>Open</DropdownMenuItem>
            {readOnly ? null : (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {board.columns
                    .filter((c) => c.id !== ticket.columnId)
                    .map((c) => (
                      <DropdownMenuItem key={c.id} onSelect={() => onMove(c.id)}>
                        <WorkColumnIcon icon={c.icon} className="size-4" /> {c.name}
                      </DropdownMenuItem>
                    ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {imported && scrum && !finished ? (
              <>
                {activeSprint && ticket.sprintId !== activeSprint.id ? (
                  <DropdownMenuItem onSelect={() => onSprint("active")}>
                    {closedSprint ? `Carry over to active ${sprintTerm(ticket.provider)}` : `Move to ${activeSprint.name}`}
                  </DropdownMenuItem>
                ) : null}
                {ticket.sprintId ? (
                  <DropdownMenuItem onSelect={() => onSprint("backlog")}>Send to backlog</DropdownMenuItem>
                ) : null}
              </>
            ) : null}
            {imported && ticket.externalUrl ? (
              <DropdownMenuItem
                onSelect={() =>
                  void (window as unknown as { drogon?: { shell?: { openExternal?: (u: string) => unknown } } }).drogon?.shell?.openExternal?.(
                    ticket.externalUrl!,
                  )
                }
              >
                Open in {providerLabel(ticket.provider)}
              </DropdownMenuItem>
            ) : null}
            {readOnly ? null : (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onSelect={onDelete}>
                  {imported ? "Remove from the board" : "Delete"}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <button
        type="button"
        className="mt-0.5 flex w-full items-start gap-2 text-left"
        aria-label={`Open ${key}: ${ticket.title}`}
        onClick={onOpen}
      >
        {working ? (
          <span className="mt-1.5 size-2.5 shrink-0 rounded-full bg-yellow-500" aria-label="Agent working" role="img" />
        ) : null}
        <span className="font-semibold leading-snug text-foreground">{ticket.title}</span>
      </button>
      {imported ? (
        <>
          {carriedTo || ticket.carriedFrom ? (
            <div className="mt-2">
              <CarriedPill from={carriedTo ? null : ticket.carriedFrom} to={carriedTo} />
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <IssueTypeBadge type={ticket.issueType} />
            <PriorityBadge priority={ticket.priority} />
          </div>
          <div className="mt-2.5 flex items-center gap-2 text-xs text-muted-foreground">
            <Avatar name={ticket.assignee} />
            <span className="flex items-center gap-1" data-testid="work-card-sessions">
              {sessions > 0 ? <FileText className="size-3.5" aria-hidden="true" /> : null}
              {sessions === 0 ? "No sessions" : sessionCountLabel(ticket)}
              {ticket.prNumber ? <span className="text-blue-500"> · PR #{ticket.prNumber}</span> : null}
            </span>
          </div>
          <WorkSyncActions ticket={ticket} columns={board.columns} readOnly={readOnly} handlers={syncHandlers} />
        </>
      ) : (
        <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
          {ticket.projectName ? (
            <li className="flex items-center gap-2">
              <Folder className="size-3.5" aria-hidden="true" /> {ticket.projectName}
            </li>
          ) : null}
          {ticket.prNumber || ticket.prUrl ? (
            <li className="flex items-center gap-2">
              <GitPullRequest className="size-3.5" aria-hidden="true" />
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-foreground">
                {ticket.prNumber ? `PR #${ticket.prNumber}` : "PR"}
              </span>
            </li>
          ) : null}
          <li className="flex items-center gap-2">
            {ticket.sessions.length > 1 ? (
              <Link2 className="size-3.5" aria-hidden="true" />
            ) : (
              <MessageSquare className="size-3.5" aria-hidden="true" />
            )}
            {ticket.sessions.length > 1 ? `${ticket.sessions.length} linked sessions` : sessionCountLabel(ticket)}
          </li>
          {ticket.nextStep ? (
            <li className="flex items-center gap-2">
              <ListTree className="size-3.5" aria-hidden="true" /> Next: {ticket.nextStep}
            </li>
          ) : null}
          {ticket.sessions.length > 0 ? (
            <li className="flex items-center gap-2">
              <Clock3 className="size-3.5" aria-hidden="true" /> Updated {formatClock(ticket.updatedAt)}
            </li>
          ) : null}
        </ul>
      )}
    </article>
  );
}

// ------------------------------------------------------------- pickers --

function BoardPicker({
  boards,
  current,
  sources,
  onSelect,
  onImport,
}: {
  boards: WorkBoardSummary[];
  current: WorkBoardSummary | null;
  /** The allowed sources: one "Import a … " entry each. */
  sources: WorkSource[];
  onSelect: (board: WorkBoardSummary) => void;
  onImport: (source: WorkSource) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-9 gap-2" aria-label="Board">
          {current?.provider ? <ProviderMark provider={current.provider} className="size-4" /> : <LayoutList />}
          <span className="max-w-[220px] truncate">{current ? boardLabel(current) : "My work"}</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[240px]">
        {boards.map((b) => (
          <DropdownMenuItem key={b.id} onSelect={() => onSelect(b)} aria-label={boardLabel(b)}>
            {b.provider ? <ProviderMark provider={b.provider} className="size-4" /> : <LayoutList className="size-4" />}
            <span className="flex-1 truncate">{boardLabel(b)}</span>
            {b.pendingCount > 0 ? <span className="text-[11px] text-amber-500">{b.pendingCount} unsynced</span> : null}
            {current?.id === b.id ? <Check className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
        {sources.length ? <DropdownMenuSeparator /> : null}
        {sources.map((s) => (
          <DropdownMenuItem key={s.id} onSelect={() => onImport(s)}>
            <ProviderMark provider={s.id} className="size-4" /> {importLabel(s)}…
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SprintPicker({
  sprints,
  view,
  term,
  onSelect,
}: {
  sprints: WorkSprint[];
  view: WorkSprint | "backlog" | null;
  /** What the source calls a sprint, capitalized (Sprint, Cycle, Iteration). */
  term: string;
  onSelect: (sprint: WorkSprint | "backlog") => void;
}) {
  const ordered = [
    ...sprints.filter((s) => s.state === "active"),
    ...sprints.filter((s) => s.state === "future"),
    ...sprints.filter((s) => s.state === "closed").reverse(),
  ];
  const label = view === "backlog" ? "Backlog" : view ? sprintLabel(view) : `No active ${term.toLowerCase()}`;
  const currentId = view === "backlog" ? "backlog" : view?.id;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="h-9 gap-2" aria-label={term}>
          {view && view !== "backlog" ? (
            <span className={`size-2 rounded-full ${sprintStateDot(view.state)}`} aria-hidden="true" />
          ) : (
            <FileText />
          )}
          {label}
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        {ordered.map((sprint) => (
          <DropdownMenuItem key={sprint.id} onSelect={() => onSelect(sprint)} aria-label={sprintLabel(sprint)}>
            <span className={`size-2 rounded-full ${sprintStateDot(sprint.state)}`} aria-hidden="true" />
            <span className="flex-1">{sprintLabel(sprint)}</span>
            {currentId === sprint.id ? <Check className="size-4" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onSelect("backlog")} aria-label="Backlog">
          <FileText className="size-4" />
          <span className="flex-1">Backlog</span>
          {currentId === "backlog" ? <Check className="size-4" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ------------------------------------------------------------ list/sources --

function ListView({
  board,
  tickets,
  onOpenTicket,
}: {
  board: WorkBoard;
  tickets: WorkTicket[];
  onOpenTicket: (id: string) => void;
}) {
  const columnName = new Map(board.columns.map((c) => [c.id, c.name]));
  const order = new Map(board.columns.map((c) => [c.id, c.position]));
  const rows = [...tickets].sort(
    (a, b) => (order.get(a.columnId) ?? 0) - (order.get(b.columnId) ?? 0) || a.position - b.position,
  );
  if (rows.length === 0) return <p className="px-6 text-sm text-muted-foreground">No tickets.</p>;
  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 pb-4">
      <table className="w-full text-sm" aria-label="Tickets">
        <thead className="text-left text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th className="py-2 font-medium">Key</th>
            <th className="py-2 font-medium">Title</th>
            <th className="py-2 font-medium">Column</th>
            <th className="py-2 font-medium">Project</th>
            <th className="py-2 font-medium">PR</th>
            <th className="py-2 font-medium">Sessions</th>
            <th className="py-2 font-medium">Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr
              key={t.id}
              className="cursor-pointer border-b border-border/60 hover:bg-accent/40"
              onClick={() => onOpenTicket(t.id)}
            >
              <td className="py-2 font-mono text-xs text-muted-foreground">{ticketDisplayKey(t)}</td>
              <td className="py-2">
                <button type="button" className="text-left font-medium" onClick={() => onOpenTicket(t.id)}>
                  {t.title}
                </button>
              </td>
              <td className="py-2">{columnName.get(t.columnId)}</td>
              <td className="py-2 text-muted-foreground">{t.projectName ?? "—"}</td>
              <td className="py-2 text-muted-foreground">{t.prNumber ? `#${t.prNumber}` : "—"}</td>
              <td className="py-2 text-muted-foreground">{t.sessions.length}</td>
              <td className="py-2 text-muted-foreground">{formatClock(t.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SourcesView({
  tickets,
  onOpenTicket,
  onOpenExternal,
  manage,
  cardDismissed,
  onRestoreCard,
}: {
  tickets: WorkTicket[];
  onOpenTicket: (id: string) => void;
  onOpenExternal: (url: string) => void;
  /** The sync sources panel (allow, connect). */
  manage?: ReactNode;
  cardDismissed?: boolean;
  onRestoreCard?: () => void;
}) {
  const linked = tickets.filter((t) => t.sourceUrl);
  const groups = new Map<string, WorkTicket[]>();
  for (const t of linked) {
    const kind = t.provider ? providerLabel(t.provider) : sourceKind(t.sourceUrl);
    groups.set(kind, [...(groups.get(kind) ?? []), t]);
  }
  const unlinked = tickets.length - linked.length;
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-auto px-6 pb-4" data-testid="work-sources">
      {manage}
      {cardDismissed && onRestoreCard ? (
        <button type="button" className="text-xs text-muted-foreground underline" onClick={onRestoreCard}>
          Show the "Sync a board" card on an empty My work again
        </button>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Tickets are board records; each can link the ticket it tracks in another system.
        {unlinked > 0 ? ` ${unlinked} ticket${unlinked === 1 ? " has" : "s have"} no source link.` : ""}
      </p>
      {[...groups.entries()].map(([kind, rows]) => (
        <section key={kind} aria-label={`${kind} sources`}>
          <h2 className="mb-2 text-sm font-semibold text-foreground">
            {kind} <span className="font-normal text-muted-foreground">{rows.length}</span>
          </h2>
          <ul className="divide-y divide-border/60 rounded-lg border border-border">
            {rows.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <button type="button" className="font-mono text-xs text-muted-foreground" onClick={() => onOpenTicket(t.id)}>
                  {ticketDisplayKey(t)}
                </button>
                <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onOpenTicket(t.id)}>
                  {t.title}
                </button>
                <Button variant="ghost" size="xs" onClick={() => onOpenExternal(t.sourceUrl!)}>
                  <ExternalLink aria-hidden="true" />
                  <span className="max-w-[320px] truncate">{t.sourceUrl}</span>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- dialogs --

function NewTicketDialog({
  open,
  board,
  workspaces,
  initialColumn,
  initialProject,
  onClose,
  onCreate,
}: {
  open: boolean;
  board: WorkBoard;
  workspaces: WorkWorkspace[];
  initialColumn: string;
  initialProject: string;
  onClose: () => void;
  onCreate: (input: {
    title: string;
    columnId?: string;
    projectId?: string;
    workspaceId?: string;
    prUrl?: string;
    sourceUrl?: string;
    description?: string;
  }) => Promise<string | null>;
}) {
  const [title, setTitle] = useState("");
  const [columnId, setColumnId] = useState(initialColumn);
  const [projectId, setProjectId] = useState(initialProject);
  const [workspaceId, setWorkspaceId] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastOpen, setLastOpen] = useState(false);
  if (open && !lastOpen) {
    setLastOpen(true);
    setTitle("");
    setColumnId(initialColumn || board.columns[0]?.id || "");
    setProjectId(initialProject);
    setWorkspaceId("");
    setPrUrl("");
    setSourceUrl("");
    setDescription("");
    setError(null);
  } else if (!open && lastOpen) {
    setLastOpen(false);
  }
  const column = board.columns.find((c) => c.id === columnId);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>
            A board ticket with its own key. Link the issue it tracks elsewhere and the sessions
            working on it; its column's prompt reaches them.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          aria-label="New ticket"
          onSubmit={async (event) => {
            event.preventDefault();
            const failure = await onCreate({
              title: title.trim(),
              columnId: columnId || undefined,
              projectId: projectId || undefined,
              workspaceId: workspaceId || undefined,
              prUrl: prUrl.trim() || undefined,
              sourceUrl: sourceUrl.trim() || undefined,
              description: description || undefined,
            });
            setError(failure);
          }}
        >
          <Input aria-label="Title" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          <div className="grid grid-cols-2 gap-3">
            <select aria-label="Column" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" value={columnId} onChange={(e) => setColumnId(e.target.value)}>
              {board.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select aria-label="Project" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">No project</option>
              {board.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <select aria-label="Workspace" className="h-9 rounded-md border border-input bg-transparent px-2 text-sm" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            <option value="">Sessions start in the project's workspace</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <Input aria-label="Pull request" placeholder="Pull request (URL or #number)" value={prUrl} onChange={(e) => setPrUrl(e.target.value)} />
          <Input aria-label="Source link" placeholder="Source link (GitHub, Jira, Linear…)" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
          <Textarea aria-label="Description" placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
          {column?.sendOnEnter && column.message.trim() ? (
            <p className="text-xs text-muted-foreground">
              {column.name} sends its prompt when a ticket enters it: creating this ticket there sends it now.
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim()}>
              Create ticket
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewColumnDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, icon: string) => Promise<string | null>;
}) {
  const [name, setName] = useState("");
  // The icon follows the name until you pick one yourself.
  const [picked, setPicked] = useState<string | null>(null);
  const icon = picked ?? iconForColumnName(name);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setName("");
    setPicked(null);
    setError(null);
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New column</DialogTitle>
          <DialogDescription>Columns can type a prompt into their tickets' sessions.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          aria-label="New column"
          onSubmit={async (event) => {
            event.preventDefault();
            const failure = await onCreate(name.trim(), icon);
            setError(failure);
            if (!failure) {
              setName("");
              setPicked(null);
            }
          }}
        >
          <Input aria-label="Column name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <ColumnIconPicker value={icon} onChange={setPicked} />
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Add column
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The column icons as the board draws them, one radio each (arrow keys
 *  move and choose, like any radio group); the name is the tooltip. */
function ColumnIconPicker({ value, onChange }: { value: string; onChange: (icon: string) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const choose = (index: number) => {
    const next = (index + WORK_COLUMN_ICONS.length) % WORK_COLUMN_ICONS.length;
    onChange(WORK_COLUMN_ICONS[next]!);
    refs.current[next]?.focus();
  };
  return (
    <div className="flex items-center gap-3">
      <span id="work-new-column-icon" className="text-sm text-muted-foreground">
        Icon
      </span>
      <div role="radiogroup" aria-labelledby="work-new-column-icon" className="flex flex-wrap gap-1">
        {WORK_COLUMN_ICONS.map((icon, index) => {
          const selected = icon === value;
          const label = workColumnIconLabel(icon);
          return (
            <Tooltip key={icon}>
              <TooltipTrigger asChild>
                <button
                  ref={(el) => {
                    refs.current[index] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={label}
                  tabIndex={selected ? 0 : -1}
                  className={`flex size-8 items-center justify-center rounded-md border ${
                    selected ? "border-ring bg-accent" : "border-transparent hover:bg-accent/60"
                  }`}
                  onClick={() => onChange(icon)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                      event.preventDefault();
                      choose(index + 1);
                    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                      event.preventDefault();
                      choose(index - 1);
                    }
                  }}
                >
                  <WorkColumnIcon icon={icon} />
                </button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
