// Imported-ticket vocabulary for the Work board, per source (Jira, Linear,
// GitHub): each source's mark, name and words for a board and a sprint, the
// issue type and priority badges, the assignee avatar, and the words a card
// uses for its sync state. Pure presentation; no bridge calls. A new source
// adds one entry to SOURCE_UI.
import { ArrowRight, BookOpen, Bug, CheckSquare, Lightbulb, Sparkles, Wrench } from "lucide-react";
import { JiraIcon } from "../../components/icons/JiraIcon";
import { LinearIcon } from "../../components/icons/LinearIcon";
import { GithubIcon } from "../tasks/github-icon";
import type { WorkBoardSummary, WorkSprint, WorkTicket } from "../../../../shared/work-contract";

type SourceUi = {
  name: string;
  Icon: (props: { className?: string }) => React.JSX.Element;
  tone: string;
  /** What a board and a sprint are called there. */
  board: string;
  sprint: string;
};

export const SOURCE_UI: Record<string, SourceUi> = {
  jira: { name: "Jira", Icon: JiraIcon, tone: "text-blue-500", board: "board", sprint: "sprint" },
  linear: { name: "Linear", Icon: LinearIcon, tone: "text-indigo-500 dark:text-indigo-400", board: "team", sprint: "cycle" },
  github: { name: "GitHub", Icon: GithubIcon, tone: "text-foreground", board: "project or repository", sprint: "iteration" },
};

export function ProviderMark({ provider, className = "size-3.5" }: { provider?: string | null; className?: string }) {
  const ui = provider ? SOURCE_UI[provider] : undefined;
  if (!ui) return null;
  const { Icon } = ui;
  return <Icon className={`${className} shrink-0 ${ui.tone}`} />;
}

export function providerLabel(provider?: string | null): string {
  return (provider && SOURCE_UI[provider]?.name) || provider || "Work board";
}

/** What the source calls a sprint (`sprint`, `cycle`, `iteration`). */
export function sprintTerm(provider?: string | null): string {
  return (provider && SOURCE_UI[provider]?.sprint) || "sprint";
}

export function capitalize(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : word;
}

/** The key a person sees: the source's (APP-128, ENG-12, drogon#12) when
 *  imported; a GitHub key drops its owner on cards. */
export function ticketDisplayKey(ticket: WorkTicket): string {
  const key = ticket.externalKey ?? ticket.key;
  return ticket.provider === "github" ? key.replace(/^[^/]+\//, "") : key;
}

const TYPE_STYLES: { match: RegExp; Icon: typeof Bug; tone: string }[] = [
  { match: /bug|defect|incident/i, Icon: Bug, tone: "bg-rose-500/12 text-rose-600 dark:text-rose-400" },
  { match: /feature|story/i, Icon: Sparkles, tone: "bg-sky-500/12 text-sky-600 dark:text-sky-400" },
  { match: /doc/i, Icon: BookOpen, tone: "bg-violet-500/12 text-violet-600 dark:text-violet-400" },
  { match: /improve|enhance/i, Icon: Lightbulb, tone: "bg-teal-500/12 text-teal-600 dark:text-teal-400" },
  { match: /chore|maint|tech/i, Icon: Wrench, tone: "bg-muted text-muted-foreground" },
];

export function IssueTypeBadge({ type }: { type?: string | null }) {
  if (!type) return null;
  const style = TYPE_STYLES.find((s) => s.match.test(type)) ?? {
    Icon: CheckSquare,
    tone: "bg-blue-500/12 text-blue-600 dark:text-blue-400",
  };
  const { Icon } = style;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${style.tone}`}
      data-testid="work-issue-type"
    >
      <Icon className="size-3" aria-hidden="true" />
      {type}
    </span>
  );
}

/** Priority as the bars glyph the Tasks page uses: more bars, more urgent. */
export function priorityLevel(priority?: string | null): number {
  if (!priority) return 0;
  const p = priority.toLowerCase();
  if (/highest|blocker|critical|urgent/.test(p)) return 4;
  if (/high|major/.test(p)) return 3;
  if (/medium|normal/.test(p)) return 2;
  return 1;
}

export function PriorityBadge({ priority }: { priority?: string | null }) {
  if (!priority) return null;
  const level = priorityLevel(priority);
  const tone =
    level >= 3 ? "text-rose-500" : level === 2 ? "text-amber-500" : "text-emerald-500";
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground" data-testid="work-priority">
      <svg viewBox="0 0 12 12" className={`size-3 ${tone}`} aria-hidden="true">
        {[0, 1, 2].map((bar) => (
          <rect
            key={bar}
            x={1 + bar * 4}
            y={8 - bar * 3}
            width="2.4"
            height={4 + bar * 3}
            rx="0.6"
            fill="currentColor"
            opacity={bar < Math.min(level, 3) ? 1 : 0.25}
          />
        ))}
      </svg>
      {priority}
    </span>
  );
}

export function initials(name?: string | null): string {
  if (!name) return "";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0]![0]! + parts[parts.length - 1]![0]! : (parts[0] ?? "").slice(0, 2);
  return letters.toUpperCase();
}

export function Avatar({ name, className = "size-6 text-[10px]" }: { name?: string | null; className?: string }) {
  if (!name) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-semibold text-muted-foreground ${className}`}
      title={name}
      aria-label={name}
      role="img"
    >
      {initials(name)}
    </span>
  );
}

export function CarriedPill({ from, to }: { from?: string | null; to?: string | null }) {
  if (!from && !to) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400"
      data-testid="work-carried"
    >
      {from ? (
        `Carried from ${from}`
      ) : (
        <>
          Carried to {to} <ArrowRight className="size-3" aria-hidden="true" />
        </>
      )}
    </span>
  );
}

/** One line for a card's sync state; null when there is nothing to say. */
export function syncHeadline(ticket: WorkTicket): string | null {
  const provider = providerLabel(ticket.provider);
  switch (ticket.sync) {
    case "pending":
      return ticket.pendingStatus
        ? `Not synced to ${provider}`
        : `Not synced to ${provider}: ${ticket.sprintName ? `moved to ${ticket.sprintName}` : "sent to the backlog"}`;
    case "conflict":
      return `${provider}: ${ticket.externalStatus?.name ?? "changed"}`;
    case "error":
      return `${provider} refused the push`;
    case "unmapped":
      return `Status '${ticket.externalStatus?.name ?? "?"}' not mapped`;
    case "removed":
      return `Not in ${provider} anymore`;
    default:
      return null;
  }
}

export function sprintLabel(sprint: WorkSprint): string {
  const state = sprint.state === "active" ? "Active" : sprint.state === "closed" ? "Closed" : "Upcoming";
  return `${sprint.name} · ${state}`;
}

export function boardLabel(board: WorkBoardSummary): string {
  return board.provider ? `${board.name} · ${providerLabel(board.provider)}` : board.name;
}

/** `Sep 1 – Sep 14, 2026` from ISO dates (either may be missing). */
export function sprintDates(sprint: { start: string | null; end: string | null }): string {
  const fmt = (iso: string | null, year: boolean) => {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) });
  };
  const start = fmt(sprint.start, false);
  const end = fmt(sprint.end, true);
  if (start && end) return `${start} – ${end}`;
  return start ?? end ?? "";
}

export function sprintStateDot(state: string): string {
  return state === "active" ? "bg-green-500" : state === "closed" ? "bg-muted-foreground/60" : "bg-blue-500";
}
