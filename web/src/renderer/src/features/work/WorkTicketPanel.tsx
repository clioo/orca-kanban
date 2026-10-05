// The ticket panel: the ticket's key, title, badges and description, then
// Details / Sessions / Links / Activity. An imported ticket (Jira) adds its
// sync state, its sprint continuity and a Jira details block; its title and
// description belong to Jira and read only here. Each linked session opens
// in one click (one that is no longer running is resumed first), goes by the
// name given on this ticket, and New session starts one in the ticket's
// workspace, linked.
import { useEffect, useMemo, useState } from "react";
import {
  Copy,
  ExternalLink,
  GitPullRequest,
  Info,
  Link2,
  MoreHorizontal,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import type { Session } from "../../../../shared/session-contract";
import {
  WORK_HARNESSES,
  type WorkActivity,
  type WorkBoard,
  type WorkBridge,
  type WorkSend,
  type WorkSession,
  type WorkTicket,
  type WorkTicketUpdate,
} from "../../../../shared/work-contract";
import type { WorkBoardState } from "./use-work-board";
import { JiraMarkdown } from "../tasks/jira/jira-markdown";
import { deliverySummary, formatClock } from "./work-format";
import { WorkColumnIcon, WorkSessionGlyph, WorkSessionState, workSessionLabel } from "./work-icons";
import {
  Avatar,
  CarriedPill,
  IssueTypeBadge,
  PriorityBadge,
  ProviderMark,
  providerLabel,
  capitalize,
  sprintDates,
  sprintTerm,
  ticketDisplayKey,
} from "./work-sources";
import { WorkSyncActions, type WorkSyncHandlers } from "./WorkSyncActions";
import { ProjectOptions } from "./work-projects";
import { type LinkCandidates, unreadableNotice } from "./work-session-candidates";

export type WorkWorkspace = { id: string; name: string; projectId?: string | null; path?: string };

type PanelTab = "details" | "sessions" | "links" | "activity";

const HARNESS_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  antigravity: "Antigravity",
};

/** The name a linked session goes by: this ticket's, else its own. */
export function workSessionName(session: WorkSession): string {
  if (typeof session.label === "string" && session.label) return session.label;
  return workSessionLabel(session);
}

function sessionMeta(session: WorkSession, now = Date.now()): string {
  const created = typeof session.createdAt === "string" ? Date.parse(session.createdAt) : NaN;
  const date = Number.isNaN(created)
    ? ""
    : new Date(created).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  if (session.verdict === "live" && !Number.isNaN(created)) {
    const minutes = Math.max(0, Math.round((now - created) / 60_000));
    const span = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
    return [date, span].filter(Boolean).join(" · ");
  }
  return date;
}

export function WorkTicketPanel({
  ticket,
  board,
  state,
  bridge,
  workspaces,
  readOnly = false,
  syncHandlers,
  onOpenSession,
  onOpenExternal,
  onClose,
  onNotice,
  listLinkCandidates,
}: {
  /** Linkable sessions; with `unreadable`, how many workspaces could not be listed. */
  listLinkCandidates: () => Promise<LinkCandidates>;
  ticket: WorkTicket;
  board: WorkBoard;
  state: WorkBoardState;
  bridge: WorkBridge;
  workspaces: WorkWorkspace[];
  /** A closed sprint's view: no moves, no sends. */
  readOnly?: boolean;
  syncHandlers: WorkSyncHandlers;
  onOpenSession: (session: WorkSession, ticket: WorkTicket) => void;
  onOpenExternal: (url: string) => void;
  onClose: () => void;
  onNotice: (message: string, kind?: "error" | "success") => void;
}) {
  const imported = Boolean(ticket.externalKey);
  const [tab, setTab] = useState<PanelTab>("details");
  const [title, setTitle] = useState(ticket.title);
  // The board carries a description excerpt; the whole text comes with
  // ticketShow. Until it does, a truncated description is shown, not edited.
  const [loaded, setLoaded] = useState<{ id: string; description: string; sprints: WorkTicket["sprints"] } | null>(null);
  const fullDescription =
    loaded?.id === ticket.id ? loaded.description : ticket.descriptionTruncated ? null : ticket.description;
  const [description, setDescription] = useState(fullDescription ?? ticket.description);
  const [expanded, setExpanded] = useState(false);
  const [pr, setPr] = useState(ticket.prUrl ?? (ticket.prNumber ? `#${ticket.prNumber}` : ""));
  const [source, setSource] = useState(ticket.sourceUrl ?? "");
  const [next, setNext] = useState(ticket.nextStep);
  const [sends, setSends] = useState<WorkSend[]>([]);
  const [activity, setActivity] = useState<WorkActivity[]>([]);
  const [candidates, setCandidates] = useState<Session[] | null>(null);
  // Said beside the picker: some workspaces' sessions are missing from it.
  const [candidatesNote, setCandidatesNote] = useState<string | null>(null);
  const [linkChoice, setLinkChoice] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    setTitle(ticket.title);
    setDescription(fullDescription ?? ticket.description);
    setPr(ticket.prUrl ?? (ticket.prNumber ? `#${ticket.prNumber}` : ""));
    setSource(ticket.sourceUrl ?? "");
    setNext(ticket.nextStep);
  }, [ticket.id, ticket.title, ticket.description, fullDescription, ticket.prUrl, ticket.prNumber, ticket.sourceUrl, ticket.nextStep]);

  useEffect(() => {
    let cancelled = false;
    void bridge.ticketShow({ ticketId: ticket.id }).then((result) => {
      if (cancelled || !result.ok) return;
      setLoaded({ id: ticket.id, description: result.result.description, sprints: result.result.sprints });
      setSends(result.result.sends ?? []);
      setActivity(result.result.activity ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, ticket.id, ticket.updatedAt, ticket.sync, ticket.sessions.length, board]);

  const workspaceName = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces]);
  const column = board.columns.find((c) => c.id === ticket.columnId);
  const provider = providerLabel(ticket.provider);
  const Term = capitalize(sprintTerm(ticket.provider));

  const update = async (patch: Omit<WorkTicketUpdate, "ticketId">) => {
    const result = await state.run(() => bridge.ticketUpdate({ ticketId: ticket.id, ...patch }));
    if (!result.ok) onNotice(result.error, "error");
  };
  const saveIfChanged = (value: string, current: string, patch: Omit<WorkTicketUpdate, "ticketId">) => {
    if (value !== current) void update(patch);
  };
  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => onNotice(`Copied ${what}`, "success"),
      () => onNotice(`Could not copy ${what}`, "error"),
    );
  };
  const newSession = async (harnessId?: string) => {
    const result = await state.run(() => bridge.ticketSessionStart({ ticketId: ticket.id, harnessId }));
    if (!result.ok) {
      onNotice(result.error, "error");
      return;
    }
    onNotice(`Started a session for ${ticketDisplayKey(ticket)}`, "success");
    onOpenSession(result.value.session, result.value);
  };
  const rename = async (session: WorkSession, name: string) => {
    setRenaming(null);
    if (name === (session.label ?? "")) return;
    const result = await state.run(() =>
      bridge.ticketSessionRename({ ticketId: ticket.id, sessionId: session.id, title: name }),
    );
    if (!result.ok) onNotice(result.error, "error");
  };
  const loadCandidates = async () => {
    try {
      const reply = await listLinkCandidates();
      const all = Array.isArray(reply) ? reply : reply.sessions;
      const unreadable = Array.isArray(reply) ? 0 : reply.unreadable;
      const linked = new Set(ticket.sessions.map((s) => s.id));
      setCandidatesNote(unreadable > 0 ? unreadableNotice(unreadable) : null);
      setCandidates(all.filter((s) => !linked.has(s.id)));
    } catch (err) {
      onNotice(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const sessionList = (
    <ul className="divide-y divide-border/60 rounded-lg border border-border" aria-label="Linked sessions">
      {ticket.sessions.length === 0 ? (
        <li className="px-3 py-3 text-xs text-muted-foreground">
          No linked sessions. New session starts one here; a column prompt starts one when it has to.
        </li>
      ) : (
        ticket.sessions.map((session) => (
          <li key={session.id} className="group flex items-center gap-2 px-2 py-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border">
              <WorkSessionGlyph session={session} />
            </span>
            {renaming === session.id ? (
              <input
                aria-label="Session name"
                // Focus once the menu that opened it has closed and let go.
                ref={(el) => {
                  if (el) setTimeout(() => el.focus(), 0);
                }}
                defaultValue={typeof session.label === "string" ? session.label : ""}
                placeholder={workSessionName({ ...session, label: undefined })}
                className="h-7 min-w-0 flex-1 rounded-sm bg-transparent px-1 text-sm outline-none ring-1 ring-ring"
                onBlur={(event) => void rename(session, event.target.value.trim())}
                onKeyDown={(event) => {
                  if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                  if (event.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <button
                type="button"
                className="min-w-0 flex-1 rounded-md px-1 text-left hover:bg-accent disabled:opacity-60"
                aria-label={`Open ${workSessionName(session)} session ${session.id.slice(0, 8)}`}
                disabled={session.missing === true}
                onClick={() => onOpenSession(session, ticket)}
                onDoubleClick={() => setRenaming(session.id)}
                data-work-session={session.id}
              >
                <span className="block truncate text-sm font-medium text-foreground">{workSessionName(session)}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[sessionMeta(session), session.workspaceId ? workspaceName.get(session.workspaceId) : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            )}
            <WorkSessionState session={session} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={`Session ${session.id.slice(0, 8)} actions`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              {/* Rename puts focus in the name field: the menu must not take it back. */}
              <DropdownMenuContent align="end" onCloseAutoFocus={(event) => event.preventDefault()}>
                <DropdownMenuItem disabled={session.missing === true} onSelect={() => onOpenSession(session, ticket)}>
                  Open
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setRenaming(session.id)}>Rename</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onSelect={async () => {
                    const result = await state.run(() =>
                      bridge.unlinkSession({ ticketId: ticket.id, sessionId: session.id }),
                    );
                    if (!result.ok) onNotice(result.error, "error");
                  }}
                >
                  Unlink from ticket
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))
      )}
    </ul>
  );

  const newSessionButton = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label="New session">
          <Plus /> New session
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void newSession(undefined)}>Default agent</DropdownMenuItem>
        <DropdownMenuSeparator />
        {WORK_HARNESSES.map((h) => (
          <DropdownMenuItem key={h} onSelect={() => void newSession(h)}>
            {HARNESS_NAMES[h] ?? h}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // The board listing leaves the sprint timeline to the full ticket.
  const timeline = (loaded?.id === ticket.id ? loaded.sprints : undefined) ?? ticket.sprints ?? [];
  const history = [
    ...activity.map((a) => ({ at: a.at, key: `a${a.id}`, text: a.text, detail: null as string | null })),
    ...sends.map((s) => ({
      at: s.at,
      key: `s${s.id}`,
      text: `${board.columns.find((c) => c.id === s.columnId)?.name ?? "Column"} sent (${s.trigger}): ${deliverySummary(s.results)}`,
      detail: s.message,
    })),
  ].sort((a, b) => b.at - a.at);

  return (
    <aside
      className="flex w-[400px] shrink-0 flex-col border-l border-border bg-background"
      aria-label={`Ticket ${ticketDisplayKey(ticket)}`}
      data-testid="work-ticket-panel"
    >
      <header className="space-y-3 px-5 pt-4">
        <div className="flex items-center gap-2">
          <ProviderMark provider={ticket.provider} className="size-4" />
          <span className="font-mono text-sm font-medium text-foreground" data-testid="work-panel-key">
            {ticketDisplayKey(ticket)}
          </span>
          {imported ? (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Copy Board key ${ticket.key}`}
              title={`Board key ${ticket.key}`}
              onClick={() => copy(ticket.key, `Board key ${ticket.key}`)}
            >
              <Copy />
            </Button>
          ) : null}
          <div className="flex-1" />
          <Button variant="ghost" size="icon-xs" aria-label="Close ticket panel" onClick={onClose}>
            <X />
          </Button>
        </div>
        {imported ? (
          <h2 className="text-lg font-semibold leading-snug text-foreground" data-testid="work-panel-title">
            {ticket.title}
          </h2>
        ) : (
          <input
            aria-label="Ticket title"
            className="w-full rounded-sm bg-transparent text-lg font-semibold text-foreground outline-none focus:ring-1 focus:ring-ring"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => title.trim() && saveIfChanged(title, ticket.title, { title })}
          />
        )}
        {imported ? (
          <div className="flex flex-wrap items-center gap-2">
            <IssueTypeBadge type={ticket.issueType} />
            <PriorityBadge priority={ticket.priority} />
            <CarriedPill from={ticket.carriedFrom} />
          </div>
        ) : null}
        {imported ? (
          ticket.description ? (
            <div className="text-sm text-muted-foreground">
              {/* The source's markdown (Linear, GitHub; Jira's ADF comes as
                  markdown too), rendered as elements, never raw HTML. */}
              {/* Expanded, it scrolls on its own: the header does not, so an
                  unbounded description pushed the tabs off screen. */}
              <div
                data-testid="work-panel-description"
                className={expanded ? "max-h-[45vh] overflow-y-auto pr-1" : "max-h-32 overflow-hidden"}
              >
                <JiraMarkdown content={fullDescription ?? ticket.description} className="text-sm" />
              </div>
              {(fullDescription ?? ticket.description).length > 280 ||
              (fullDescription ?? ticket.description).split("\n").length > 6 ? (
                <button type="button" className="mt-1 text-xs underline" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? "Show less" : "Show all"}
                </button>
              ) : null}
            </div>
          ) : null
        ) : (
          <Textarea
            aria-label="Description"
            className="min-h-[72px]"
            placeholder="Description"
            value={description}
            disabled={fullDescription === null}
            onChange={(event) => setDescription(event.target.value)}
            onBlur={() => fullDescription !== null && saveIfChanged(description, fullDescription, { description })}
          />
        )}
        {imported ? (
          <WorkSyncActions ticket={ticket} columns={board.columns} readOnly={readOnly} detailed handlers={syncHandlers} />
        ) : null}
        <div className="flex gap-5 border-b border-border" role="tablist" aria-label="Ticket sections">
          {(["details", "sessions", "links", "activity"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`-mb-px border-b-2 px-1 pb-2 text-sm font-medium capitalize transition-colors ${
                tab === t ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-4 text-sm" role="tabpanel" aria-label={tab}>
        {tab === "details" ? (
          <>
            {imported && timeline.length ? (
              <section className="space-y-2" aria-label={`${Term} continuity`}>
                <h3 className="flex items-center gap-1.5 text-base font-semibold text-foreground">
                  {Term} continuity <Info className="size-3.5 text-muted-foreground" aria-hidden="true" />
                </h3>
                <p className="text-muted-foreground">One ticket, continuous notes and sessions.</p>
                <ol className="relative ml-1.5 space-y-4 border-l border-border pl-5 pt-1">
                  {timeline.map((step) => (
                    <li key={step.id} className="relative" data-work-sprint-step={step.id}>
                      <span
                        className={`absolute -left-[27px] top-1 size-3 rounded-full border-2 bg-background ${
                          step.state === "active" ? "border-green-500" : "border-muted-foreground"
                        }`}
                        aria-hidden="true"
                      />
                      <p className="font-medium text-foreground">
                        {step.name}
                        {step.status ? <span className="text-amber-500"> · {step.status}</span> : null}
                        <span className={step.outcome === "active" ? "text-green-500" : "text-muted-foreground"}>
                          {" "}
                          · {step.outcome}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">{sprintDates(step)}</p>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            {!imported ? (
              <section className="grid grid-cols-[88px_1fr] items-center gap-x-3 gap-y-2" aria-label="Details">
                <span className="text-xs text-muted-foreground">Column</span>
                <label className="flex items-center gap-2">
                  {column ? <WorkColumnIcon icon={column.icon} className="size-3.5" /> : null}
                  <select
                    aria-label="Column"
                    className="h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
                    value={ticket.columnId}
                    onChange={async (event) => {
                      const result = await state.run(() =>
                        bridge.ticketMove({ ticketId: ticket.id, columnId: event.target.value }),
                      );
                      if (!result.ok) onNotice(result.error, "error");
                      else if (result.value.delivery)
                        onNotice(`Sent to ${ticket.key}: ${deliverySummary(result.value.delivery.results)}`, "success");
                    }}
                  >
                    {board.columns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="text-xs text-muted-foreground">Next step</span>
                <Input
                  aria-label="Next step"
                  className="h-8"
                  value={next}
                  onChange={(event) => setNext(event.target.value)}
                  onBlur={() => saveIfChanged(next, ticket.nextStep, { nextStep: next })}
                />
              </section>
            ) : null}

            <section className="space-y-2" aria-label="Sessions summary">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-foreground">Sessions ({ticket.sessions.length})</h3>
                {readOnly ? null : newSessionButton}
              </div>
              {sessionList}
            </section>

            {imported ? (
              <section className="space-y-2" aria-label={`${provider} details`}>
                <h3 className="text-base font-semibold text-foreground">{provider} details</h3>
                <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-2.5">
                  <dt className="text-muted-foreground">{ticket.provider === "linear" ? "Team" : ticket.provider === "github" ? "Project" : "Board"}</dt>
                  <dd className="flex items-center gap-1.5">
                    <ProviderMark provider={ticket.provider} /> {board.board?.projectName ?? board.board?.name}
                  </dd>
                  {ticket.issueType ? (
                    <>
                      <dt className="text-muted-foreground">Issue type</dt>
                      <dd>
                        <IssueTypeBadge type={ticket.issueType} />
                      </dd>
                    </>
                  ) : null}
                  {ticket.priority ? (
                    <>
                      <dt className="text-muted-foreground">Priority</dt>
                      <dd>
                        <PriorityBadge priority={ticket.priority} />
                      </dd>
                    </>
                  ) : null}
                  <dt className="text-muted-foreground">Assignee</dt>
                  <dd className="flex items-center gap-2">
                    <Avatar name={ticket.assignee} className="size-5 text-[9px]" /> {ticket.assignee ?? "Unassigned"}
                  </dd>
                  <dt className="text-muted-foreground">Status</dt>
                  <dd>{ticket.externalStatus?.name ?? "—"}</dd>
                  {board.board?.kind === "scrum" ? (
                    <>
                      <dt className="text-muted-foreground">{Term}</dt>
                      <dd>{ticket.sprintName ?? "Backlog"}</dd>
                    </>
                  ) : null}
                  <dt className="text-muted-foreground">Issue</dt>
                  <dd>
                    {ticket.externalUrl ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-blue-500 hover:underline"
                        onClick={() => onOpenExternal(ticket.externalUrl!)}
                      >
                        {ticket.externalKey} <ExternalLink className="size-3" aria-hidden="true" />
                      </button>
                    ) : (
                      ticket.externalKey
                    )}
                  </dd>
                  <dt className="text-muted-foreground">Board key</dt>
                  <dd>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => copy(ticket.key, `Board key ${ticket.key}`)}
                    >
                      {ticket.key} <Copy className="size-3" aria-hidden="true" />
                    </button>
                  </dd>
                </dl>
              </section>
            ) : null}
          </>
        ) : null}

        {tab === "sessions" ? (
          <section className="space-y-3" aria-label="Sessions">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-foreground">Sessions ({ticket.sessions.length})</h3>
              {readOnly ? null : newSessionButton}
            </div>
            {sessionList}
            <p className="text-xs text-muted-foreground">Double-click a session to rename it on this ticket.</p>
            {candidates === null ? (
              <Button variant="outline" size="sm" onClick={() => void loadCandidates()}>
                <Link2 /> Link a session
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <select
                  aria-label="Session to link"
                  className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
                  value={linkChoice}
                  onChange={(event) => setLinkChoice(event.target.value)}
                >
                  <option value="">Choose a session…</option>
                  {candidates.map((s) => (
                    <option key={s.id} value={s.id}>
                      {workSessionLabel(s as unknown as WorkSession)} · {workspaceName.get(s.workspaceId) ?? "workspace"} · {s.verdict}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  disabled={!linkChoice}
                  onClick={async () => {
                    const result = await state.run(() =>
                      bridge.linkSession({ ticketId: ticket.id, sessionId: linkChoice }),
                    );
                    if (!result.ok) onNotice(result.error, "error");
                    setCandidates(null);
                    setLinkChoice("");
                  }}
                >
                  Link
                </Button>
              </div>
            )}
            {candidates !== null && candidatesNote ? (
              <p className="text-xs text-amber-700 dark:text-amber-300" role="status">
                {candidatesNote}
              </p>
            ) : null}
          </section>
        ) : null}

        {tab === "links" ? (
          <section className="grid grid-cols-[96px_1fr] items-center gap-x-3 gap-y-2.5" aria-label="Links">
            {imported ? (
              <>
                <span className="text-xs text-muted-foreground">{provider}</span>
                <button
                  type="button"
                  className="inline-flex min-w-0 items-center gap-1 truncate text-left text-blue-500 hover:underline"
                  onClick={() => ticket.externalUrl && onOpenExternal(ticket.externalUrl)}
                >
                  <ProviderMark provider={ticket.provider} /> {ticket.externalUrl}
                </button>
              </>
            ) : (
              <>
                <span className="text-xs text-muted-foreground">Source</span>
                <div className="flex items-center gap-1">
                  <Input
                    aria-label="Source link"
                    className="h-8"
                    placeholder="https://… (GitHub, Jira, Linear)"
                    value={source}
                    onChange={(event) => setSource(event.target.value)}
                    onBlur={() => saveIfChanged(source, ticket.sourceUrl ?? "", { sourceUrl: source.trim() || null })}
                  />
                  {ticket.sourceUrl ? (
                    <Button variant="ghost" size="icon-xs" aria-label="Open source link" onClick={() => onOpenExternal(ticket.sourceUrl!)}>
                      <ExternalLink />
                    </Button>
                  ) : null}
                </div>
              </>
            )}
            <span className="text-xs text-muted-foreground">Pull request</span>
            <div className="flex items-center gap-1">
              <Input
                aria-label="Pull request"
                className="h-8"
                placeholder="URL or #number"
                value={pr}
                onChange={(event) => setPr(event.target.value)}
                onBlur={() =>
                  saveIfChanged(pr, ticket.prUrl ?? (ticket.prNumber ? `#${ticket.prNumber}` : ""), {
                    prUrl: pr.trim() || null,
                  })
                }
              />
              {ticket.prUrl ? (
                <Button variant="ghost" size="icon-xs" aria-label="Open pull request" onClick={() => onOpenExternal(ticket.prUrl!)}>
                  <GitPullRequest />
                </Button>
              ) : null}
            </div>
            <span className="text-xs text-muted-foreground">Project</span>
            <select
              aria-label="Project"
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              value={ticket.projectId ?? ""}
              onChange={(event) => void update({ projectId: event.target.value || null })}
            >
              <option value="">No project</option>
              <ProjectOptions projects={board.projects} />
            </select>
            <span className="text-xs text-muted-foreground">Workspace</span>
            <select
              aria-label="Workspace"
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              value={ticket.workspaceId ?? ""}
              onChange={(event) => void update({ workspaceId: event.target.value || null })}
            >
              <option value="">The project's</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            {imported ? (
              <>
                <span className="text-xs text-muted-foreground">Next step</span>
                <Input
                  aria-label="Next step"
                  className="h-8"
                  value={next}
                  onChange={(event) => setNext(event.target.value)}
                  onBlur={() => saveIfChanged(next, ticket.nextStep, { nextStep: next })}
                />
              </>
            ) : null}
          </section>
        ) : null}

        {tab === "activity" ? (
          <section className="space-y-2" aria-label="Activity">
            {history.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing has happened to this ticket yet.</p>
            ) : (
              <ol className="space-y-2">
                {history.map((entry) => (
                  <li key={entry.key} className="rounded-md border border-border p-2 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-foreground">{entry.text}</span>
                      <span className="shrink-0 text-muted-foreground">{formatClock(entry.at)}</span>
                    </div>
                    {entry.detail ? <p className="mt-1 line-clamp-2 text-muted-foreground">{entry.detail}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        ) : null}
      </div>
      <footer className="border-t border-border px-5 py-3">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={async () => {
            const result = await state.run(() => bridge.ticketDelete({ ticketId: ticket.id }));
            if (result.ok) {
              onNotice(`Deleted ${ticketDisplayKey(ticket)}${imported ? ` from the board (${provider} is untouched)` : ""}`, "success");
              onClose();
            } else onNotice(result.error, "error");
          }}
        >
          <Trash2 /> {imported ? "Remove from the board" : "Delete ticket"}
        </Button>
      </footer>
    </aside>
  );
}
