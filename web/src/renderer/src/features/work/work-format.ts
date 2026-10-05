// Pure presentation helpers for the Work board.
import type { WorkColumn, WorkSession, WorkTicket } from "../../../../shared/work-contract";

/** The schedule choices the column panel offers; anything else is "custom". */
export const WORK_SCHEDULES: { value: string; label: string }[] = [
  { value: "*/5 * * * *", label: "every 5 min" },
  { value: "*/15 * * * *", label: "every 15 min" },
  { value: "*/30 * * * *", label: "every 30 min" },
  { value: "0 */1 * * *", label: "every hour" },
  { value: "0 */2 * * *", label: "every 2 hours" },
  { value: "0 0 * * *", label: "every day" },
];

export function scheduleLabel(cron: string | null): string | null {
  if (!cron) return null;
  return WORK_SCHEDULES.find((s) => s.value === cron)?.label ?? `cron ${cron}`;
}

/** The subtitle under a column name: what makes it send. */
export function columnTriggerLabel(column: WorkColumn): string | null {
  const parts: string[] = [];
  if (column.sendOnEnter) parts.push("On enter");
  if (column.prWatch) parts.push("PR watch");
  const schedule = scheduleLabel(column.cron);
  if (schedule) parts.push(schedule);
  if (parts.length === 0 || !column.message.trim()) return null;
  return parts.join(" · ");
}

export function isLiveSession(session: WorkSession): boolean {
  return session.verdict === "live";
}

export function ticketIsWorking(ticket: WorkTicket): boolean {
  return ticket.sessions.some(
    (s) => isLiveSession(s) && (s.agentState === "working" || s.agentState === "needs_input"),
  );
}

export function sessionCountLabel(ticket: WorkTicket): string {
  const n = ticket.sessions.length;
  return n === 1 ? "1 session" : `${n} sessions`;
}

export function formatClock(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "";
  const date = new Date(ms);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return sameDay ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function sourceHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** The system a source link points at, for grouping on the Sources tab. */
export function sourceKind(url: string | null): string {
  const host = sourceHost(url);
  if (!host) return "Other";
  if (host.includes("github")) return "GitHub";
  if (host.includes("atlassian") || host.includes("jira")) return "Jira";
  if (host.includes("linear")) return "Linear";
  if (host.includes("gitlab")) return "GitLab";
  return host;
}

export function matchesSearch(ticket: WorkTicket, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    ticket.key,
    ticket.externalKey ?? "",
    ticket.title,
    ticket.description,
    ticket.projectName ?? "",
    ticket.nextStep,
    ticket.assignee ?? "",
    ticket.issueType ?? "",
  ].some((field) => field.toLowerCase().includes(q));
}

export type WorkFilter = "all" | "with-pr" | "with-sessions" | "without-sessions" | "working" | "unsynced";

export function matchesFilter(ticket: WorkTicket, filter: WorkFilter): boolean {
  switch (filter) {
    case "with-pr":
      return ticket.prNumber !== null || ticket.prUrl !== null;
    case "with-sessions":
      return ticket.sessions.length > 0;
    case "without-sessions":
      return ticket.sessions.length === 0;
    case "working":
      return ticketIsWorking(ticket);
    case "unsynced":
      return ticket.sync !== undefined && ticket.sync !== "local" && ticket.sync !== "synced";
    default:
      return true;
  }
}

export const WORK_FILTER_LABELS: Record<WorkFilter, string> = {
  all: "All tickets",
  "with-pr": "With a pull request",
  "with-sessions": "With sessions",
  "without-sessions": "Without sessions",
  working: "Agent working",
  unsynced: "Needs attention (sync)",
};

export function deliverySummary(results: { action: string }[]): string {
  const counts = new Map<string, number>();
  for (const r of results) counts.set(r.action, (counts.get(r.action) ?? 0) + 1);
  return [...counts.entries()].map(([action, n]) => `${n} ${action}`).join(", ");
}
