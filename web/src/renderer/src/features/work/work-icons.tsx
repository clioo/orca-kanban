// Column and session glyphs for the Work board, in the sidebar's vocabulary.
import {
  Ban,
  Bug,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDotDashed,
  Clock3,
} from "lucide-react";
import type { WorkSession } from "../../../../shared/work-contract";
import type { HarnessId, Session } from "../../../../shared/session-contract";
import { AgentStateIcon } from "../shell/AgentStateIcon";
import { sessionAgentState } from "../shell/agent-state";
import { HarnessMenuIcon } from "../shell/TabCreateMenuIcons";
import { formatSidebarProviderLabel } from "../shell/WorktreeAgentRow";

const ICONS = {
  backlog: { Icon: CircleDotDashed, tone: "text-muted-foreground" },
  todo: { Icon: Circle, tone: "text-muted-foreground" },
  in_progress: { Icon: CircleDashed, tone: "text-blue-500 dark:text-blue-400" },
  review: { Icon: Clock3, tone: "text-yellow-500 dark:text-yellow-400" },
  qa: { Icon: Bug, tone: "text-purple-500 dark:text-purple-400" },
  done: { Icon: CircleCheck, tone: "text-green-600 dark:text-green-400" },
  blocked: { Icon: Ban, tone: "text-rose-500" },
} as const;

/** "in_progress" → "In progress". */
export function workColumnIconLabel(icon: string): string {
  const words = icon.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The icon a column's name suggests, by the rules the daemon gives the
 *  columns it imports ("Code Review" → review, "QA" → qa, "Blocked" →
 *  blocked…); anything else reads as a to-do column. */
export function iconForColumnName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("backlog")) return "backlog";
  if (lower.includes("block")) return "blocked";
  if (lower.includes("review")) return "review";
  if (lower.includes("qa") || lower.includes("test") || lower.includes("verif")) return "qa";
  if (lower.includes("done") || lower.includes("closed")) return "done";
  if (lower.includes("progress") || lower.includes("doing")) return "in_progress";
  return "todo";
}

export function WorkColumnIcon({ icon, className = "size-4" }: { icon: string; className?: string }) {
  const entry = ICONS[icon as keyof typeof ICONS] ?? ICONS.todo;
  const { Icon } = entry;
  return <Icon className={`${className} shrink-0 ${entry.tone}`} aria-hidden="true" />;
}

export function workSessionLabel(session: WorkSession): string {
  if (session.missing) return "Closed session";
  const harness = (session.harnessId ?? null) as HarnessId | null;
  return harness ? formatSidebarProviderLabel(harness) : "Terminal";
}

/** What the session is doing, in the words the sidebar rows use. */
export function workSessionStateLabel(session: WorkSession): string {
  if (session.missing) return "Closed";
  if (session.verdict === "exited") return "Exited";
  if (session.verdict !== "live") return "Not running";
  switch (sessionAgentState(session as unknown as Session)) {
    case "working":
      return "Working";
    case "needs_input":
      return "Needs input";
    case "idle":
      return "Idle";
    default:
      return "Live";
  }
}

export function WorkSessionGlyph({ session }: { session: WorkSession }) {
  const harness = session.harnessId ?? null;
  return harness ? (
    <HarnessMenuIcon harnessId={harness as HarnessId} displayName={workSessionLabel(session)} size={14} />
  ) : (
    <span className="inline-block size-3.5 rounded-sm border border-muted-foreground/50" aria-hidden="true" />
  );
}

export function WorkSessionState({ session }: { session: WorkSession }) {
  const live = session.verdict === "live" && !session.missing;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      {live ? (
        <AgentStateIcon state={sessionAgentState(session as unknown as Session)} size={10} variant="row" />
      ) : (
        <span className="inline-block size-2 rounded-full bg-muted-foreground/40" aria-hidden="true" />
      )}
      {workSessionStateLabel(session)}
    </span>
  );
}
