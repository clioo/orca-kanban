// A closed sprint, two ways: the board with its outcome beside it (what was
// completed and what was carried over), and the summary page split into
// Completed / Carried forward / Returned to backlog. Both are read-only
// records; the only actions are carrying an unfinished ticket over to the
// active sprint or sending it to the backlog (unsynced until pushed).
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  CircleCheck,
  ExternalLink,
  Info,
  Link2,
  Lock,
  RefreshCw,
  Undo2,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import type { WorkSprint, WorkTicket, WorkView } from "../../../../shared/work-contract";
import { ProviderMark, capitalize, providerLabel, sprintDates, sprintTerm, ticketDisplayKey } from "./work-sources";

export function ClosedSprintBanner({
  sprint,
  term = "sprint",
  onSummary,
}: {
  sprint: WorkSprint;
  term?: string;
  onSummary: () => void;
}) {
  return (
    <div
      className="mx-6 mb-3 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5"
      role="status"
      data-testid="work-closed-banner"
    >
      <Info className="size-5 shrink-0 text-blue-500" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-foreground">
          {sprint.name} · closed <span className="font-normal text-muted-foreground">{sprintDates({ start: null, end: sprint.end })}</span>
        </p>
        <p className="text-xs text-muted-foreground">Historical snapshot · prompts paused</p>
      </div>
      <Button variant="outline" size="sm" onClick={onSummary}>
        {capitalize(term)} summary
      </Button>
    </div>
  );
}

type Outcome = NonNullable<WorkView["outcome"]>;

function find(tickets: WorkTicket[], id: string): WorkTicket | undefined {
  return tickets.find((t) => t.id === id);
}

export function SprintOutcomePanel({
  outcome,
  tickets,
  term = "sprint",
  onOpenTicket,
}: {
  outcome: Outcome;
  tickets: WorkTicket[];
  term?: string;
  onOpenTicket: (ticket: WorkTicket) => void;
}) {
  const carried = outcome.carried.map((c) => ({ ...c, ticket: find(tickets, c.ticketId) })).filter((c) => c.ticket);
  const first = carried[0]?.ticket;
  return (
    <aside
      className="flex w-[300px] shrink-0 flex-col gap-5 border-l border-border px-5 py-4 text-sm"
      aria-label={`${capitalize(term)} outcome`}
      data-testid="work-sprint-outcome"
    >
      <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
        <BarChart3 className="size-4" aria-hidden="true" /> {capitalize(term)} outcome
      </h2>
      <ul className="space-y-2">
        <li className="flex items-center gap-2">
          <CircleCheck className="size-5 text-green-500" aria-hidden="true" />
          {outcome.completed.length} completed
        </li>
        <li className="flex items-center gap-2">
          <RefreshCw className="size-5 text-amber-500" aria-hidden="true" />
          {outcome.carried.length} carried over
        </li>
        <li className="flex items-center gap-2">
          <Undo2 className="size-5 text-muted-foreground" aria-hidden="true" />
          {outcome.backlog.length} returned to backlog
        </li>
      </ul>
      {carried.length ? (
        <section className="space-y-2" aria-label={`Carried over to next ${term}`}>
          <h3 className="font-semibold text-foreground">Carried over to next {term}</h3>
          {carried.map((c) => (
            <button
              key={c.ticketId}
              type="button"
              className="flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-left hover:bg-accent"
              onClick={() => onOpenTicket(c.ticket!)}
            >
              <ProviderMark provider={c.ticket!.provider} />
              <span className="font-mono text-xs">{ticketDisplayKey(c.ticket!)}</span>
              <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="flex-1 truncate">{c.toSprintName ?? `next ${term}`}</span>
              {c.pending ? <span className="text-[11px] text-amber-500">unsynced</span> : null}
            </button>
          ))}
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Sessions and notes remain on {carried.map((c) => ticketDisplayKey(c.ticket!)).join(", ")}.
          </p>
          {first ? (
            <Button variant="link" className="h-auto px-0 text-blue-500" onClick={() => onOpenTicket(first)}>
              <ExternalLink /> Open current ticket
            </Button>
          ) : null}
        </section>
      ) : null}
    </aside>
  );
}

export function SprintSummary({
  sprint,
  activeSprint,
  outcome,
  tickets,
  onOpenTicket,
  onCarry,
  onBacklog,
}: {
  sprint: WorkSprint;
  activeSprint: WorkSprint | null;
  outcome: Outcome;
  tickets: WorkTicket[];
  onOpenTicket: (ticket: WorkTicket) => void;
  onCarry: (ticket: WorkTicket) => void;
  onBacklog: (ticket: WorkTicket) => void;
}) {
  const term = sprintTerm(tickets[0]?.provider);
  const completed = outcome.completed.map((id) => find(tickets, id)).filter(Boolean) as WorkTicket[];
  const carried = outcome.carried.map((c) => ({ ...c, ticket: find(tickets, c.ticketId) })).filter((c) => c.ticket);
  const backlog = outcome.backlog.map((b) => ({ ...b, ticket: find(tickets, b.ticketId) })).filter((b) => b.ticket);
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="work-sprint-summary">
      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-6 pb-8">
        <header className="space-y-1">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">{sprint.name}</h2>
          <p className="flex flex-wrap items-center gap-3 text-muted-foreground">
            <span>
              {sprintDates(sprint)} · Closed
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-foreground">
              <Lock className="size-3.5" aria-hidden="true" /> Read-only · prompts paused
            </span>
          </p>
        </header>

        <SummarySection
          icon={<CircleCheck className="size-7 text-green-500" aria-hidden="true" />}
          title="Completed"
          count={completed.length}
          blurb={`Issues finished during this ${term}.`}
        >
          {completed.map((t) => (
            <SummaryRow key={t.id} ticket={t} glyph={<CircleCheck className="size-6 text-green-500" aria-hidden="true" />} onOpen={() => onOpenTicket(t)}>
              <ProviderTag ticket={t} />
            </SummaryRow>
          ))}
        </SummarySection>

        <SummarySection
          icon={<RefreshCw className="size-7 text-amber-500" aria-hidden="true" />}
          title="Carried forward"
          count={carried.length}
          blurb={`Not completed in this ${term}. Moved to a future ${term}.`}
        >
          {carried.map((c) => (
            <SummaryRow
              key={c.ticketId}
              ticket={c.ticket!}
              glyph={<RefreshCw className="size-6 text-amber-500" aria-hidden="true" />}
              onOpen={() => onOpenTicket(c.ticket!)}
              detail={
                <span className="inline-flex items-center gap-1.5">
                  <Link2 className="size-3.5" aria-hidden="true" />
                  {c.ticket!.sessions.length} linked {c.ticket!.sessions.length === 1 ? "session" : "sessions"} · notes kept
                </span>
              }
            >
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/60 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                <ArrowRight className="size-3.5" aria-hidden="true" /> {c.toSprintName ?? `Next ${term}`}
                {c.pending ? " · unsynced" : ""}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => onBacklog(c.ticket!)}>
                  Send to backlog
                </Button>
                <Button variant="outline" size="sm" onClick={() => onOpenTicket(c.ticket!)}>
                  <ExternalLink /> Open current ticket
                </Button>
              </div>
            </SummaryRow>
          ))}
        </SummarySection>

        <SummarySection
          icon={<Undo2 className="size-7 text-muted-foreground" aria-hidden="true" />}
          title="Returned to backlog"
          count={backlog.length}
          blurb={`Moved back to backlog during this ${term}.`}
        >
          {backlog.map((b) => (
            <SummaryRow key={b.ticketId} ticket={b.ticket!} glyph={<Undo2 className="size-6 text-muted-foreground" aria-hidden="true" />} onOpen={() => onOpenTicket(b.ticket!)}>
              <span className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs">
                <ArrowRight className="size-3.5" aria-hidden="true" /> Backlog{b.pending ? " · unsynced" : ""}
              </span>
              <div className="flex gap-2">
                {activeSprint ? (
                  <Button variant="outline" size="sm" onClick={() => onCarry(b.ticket!)}>
                    Carry over to {activeSprint.name}
                  </Button>
                ) : null}
                <ProviderTag ticket={b.ticket!} />
              </div>
            </SummaryRow>
          ))}
        </SummarySection>
      </div>
      <aside className="w-[300px] shrink-0 space-y-3 border-l border-border px-5 py-2 text-sm" aria-label={`${capitalize(term)} continuity`}>
        <h3 className="text-base font-semibold text-foreground">{capitalize(term)} continuity</h3>
        <p className="text-muted-foreground">
          Track how work moves between {term}s while keeping one set of sessions and notes.
        </p>
        <div className="flex items-center gap-3 rounded-lg border border-border p-3">
          <div className="flex-1 rounded-md bg-muted/50 px-3 py-2 text-center">
            <p className="font-medium text-foreground">{sprint.name}</p>
            <p className="text-xs text-muted-foreground">(closed)</p>
          </div>
          <ArrowRight className="size-5 text-muted-foreground" aria-hidden="true" />
          <div className="flex-1 rounded-md bg-green-500/10 px-3 py-2 text-center text-green-600 dark:text-green-400">
            <p className="font-medium">{activeSprint?.name ?? "Backlog"}</p>
            <p className="text-xs">{activeSprint ? "(active)" : ""}</p>
          </div>
        </div>
        {carried[0] ? (
          <p className="text-muted-foreground">
            {ticketDisplayKey(carried[0].ticket!)} is one {providerLabel(carried[0].ticket!.provider)} issue with one set of sessions and notes.
          </p>
        ) : null}
      </aside>
    </div>
  );
}

function SummarySection({
  icon,
  title,
  count,
  blurb,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3" aria-label={title}>
      <div className="flex items-start gap-3">
        {icon}
        <div>
          <h3 className="text-xl font-semibold text-foreground">
            {title} · {count}
          </h3>
          <p className="text-sm text-muted-foreground">{blurb}</p>
        </div>
      </div>
      <div className="space-y-2">{count === 0 ? <p className="pl-10 text-sm text-muted-foreground">None.</p> : children}</div>
    </section>
  );
}

function SummaryRow({
  ticket,
  glyph,
  detail,
  onOpen,
  children,
}: {
  ticket: WorkTicket;
  glyph: React.ReactNode;
  detail?: React.ReactNode;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3" data-work-summary-row={ticket.id}>
      {glyph}
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpen} aria-label={`Open ${ticketDisplayKey(ticket)}`}>
        <p className="font-mono text-xs text-muted-foreground">{ticketDisplayKey(ticket)}</p>
        <p className="truncate text-sm font-medium text-foreground">{ticket.title}</p>
        {detail ? <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p> : null}
      </button>
      <div className="flex shrink-0 flex-col items-end gap-2">{children}</div>
    </div>
  );
}

function ProviderTag({ ticket }: { ticket: WorkTicket }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <ProviderMark provider={ticket.provider} /> {providerLabel(ticket.provider)}
    </span>
  );
}

export function BackToActive({ term = "sprint", onClick }: { term?: string; onClick: () => void }) {
  return (
    <Button variant="link" size="sm" className="h-auto px-1 text-blue-500" onClick={onClick}>
      <ArrowLeft /> Back to active {term}
    </Button>
  );
}
