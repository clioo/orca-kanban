// The sync state of an imported ticket and what the user can do about it:
// push an unsynced move, settle a conflict (Use Jira's / Push ours), retry a
// refused push, or map an unmapped status to a column. Shared by the card
// (compact) and the ticket panel (with the provider's full error).
import { AlertTriangle, CloudOff, CloudUpload, GitCompareArrows, MapPin, Unlink } from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import type { WorkColumn, WorkTicket } from "../../../../shared/work-contract";
import { providerLabel, syncHeadline } from "./work-sources";
import { WorkColumnIcon } from "./work-icons";

export type WorkSyncHandlers = {
  onPush: (ticket: WorkTicket) => void;
  onResolve: (ticket: WorkTicket, keep: "theirs" | "ours") => void;
  onMapStatus: (ticket: WorkTicket, column: WorkColumn) => void;
};

const TONES: Record<string, string> = {
  pending: "border-amber-500/40 bg-amber-500/8 text-amber-700 dark:text-amber-300",
  conflict: "border-orange-500/50 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  error: "border-destructive/50 bg-destructive/8 text-destructive",
  unmapped: "border-border bg-muted/60 text-muted-foreground",
  removed: "border-border bg-muted/60 text-muted-foreground",
};

const ICONS: Record<string, typeof CloudUpload> = {
  pending: CloudUpload,
  conflict: GitCompareArrows,
  error: AlertTriangle,
  unmapped: MapPin,
  removed: CloudOff,
};

export function WorkSyncActions({
  ticket,
  columns,
  readOnly = false,
  detailed = false,
  handlers,
}: {
  ticket: WorkTicket;
  columns: WorkColumn[];
  readOnly?: boolean;
  /** The panel shows the provider's full error and the pending target. */
  detailed?: boolean;
  handlers: WorkSyncHandlers;
}) {
  const headline = syncHeadline(ticket);
  if (!headline || !ticket.sync) return null;
  const provider = providerLabel(ticket.provider);
  const Icon = ICONS[ticket.sync] ?? Unlink;
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <div
      className={`mt-2 rounded-md border px-2 py-1.5 text-[11px] ${TONES[ticket.sync] ?? ""}`}
      data-testid="work-sync-state"
      data-sync={ticket.sync}
      onClick={stop}
      onKeyDown={stop}
      role="group"
      aria-label={headline}
    >
      <p className="flex items-center gap-1.5 font-medium">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">{headline}</span>
      </p>
      {detailed && ticket.sync === "pending" && ticket.pendingStatus ? (
        <p className="mt-0.5 opacity-80">
          Moved here on the board; {provider} still has {ticket.externalStatus?.name ?? "its status"}.
        </p>
      ) : null}
      {ticket.sync === "conflict" && ticket.pendingStatus ? (
        <p className="mt-0.5 opacity-80">Yours: {ticket.pendingStatus.name}</p>
      ) : null}
      {ticket.sync === "error" && ticket.pushError ? (
        <p className={`mt-0.5 opacity-90 ${detailed ? "" : "line-clamp-2"}`} title={ticket.pushError}>
          {ticket.pushError}
        </p>
      ) : null}
      {readOnly ? null : (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {ticket.sync === "pending" || ticket.sync === "error" ? (
            <Button size="xs" variant="outline" className="h-6 bg-background px-2 text-[11px]" onClick={() => handlers.onPush(ticket)}>
              {ticket.sync === "error" ? "Retry push" : `Push to ${provider}`}
            </Button>
          ) : null}
          {ticket.sync === "conflict" ? (
            <>
              <Button size="xs" variant="outline" className="h-6 bg-background px-2 text-[11px]" onClick={() => handlers.onResolve(ticket, "theirs")}>
                Use {provider}'s
              </Button>
              <Button size="xs" variant="outline" className="h-6 bg-background px-2 text-[11px]" onClick={() => handlers.onResolve(ticket, "ours")}>
                Push ours
              </Button>
            </>
          ) : null}
          {ticket.sync === "unmapped" ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="xs" variant="outline" className="h-6 bg-background px-2 text-[11px]">
                  Map to a column…
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel className="text-xs">
                  Map '{ticket.externalStatus?.name}' to
                </DropdownMenuLabel>
                {columns.map((c) => (
                  <DropdownMenuItem key={c.id} onSelect={() => handlers.onMapStatus(ticket, c)}>
                    <WorkColumnIcon icon={c.icon} className="size-4" /> {c.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      )}
    </div>
  );
}
