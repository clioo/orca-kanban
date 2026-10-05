// Offers to bring a Drogon Work board over once: shown while a Drogon board
// exists and this board has not taken one yet; dismissible for good.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "../components/ui/button";
import type { Rpc } from "./board-rpc";

type Status = {
  drogonDataDir: string | null;
  drogonTickets: number;
  drogonBoards: number;
  migrated: { tickets: number; unmappedProjects: string[] } | null;
};

export const MIGRATION_DISMISSED_KEY = "work-board:drogon-migration-dismissed";

export function DrogonMigrationBanner({ rpc, onMigrated }: { rpc: Rpc; onMigrated: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(MIGRATION_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    void rpc("board.migration_status").then((reply) => {
      if (reply.ok) setStatus(reply.result as Status);
    });
  }, [rpc]);

  if (dismissed || !status || !status.drogonDataDir || status.migrated || status.drogonTickets === 0) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(MIGRATION_DISMISSED_KEY, "1");
    } catch {
      // Hidden for this session only.
    }
  };

  const bring = async (replace: boolean) => {
    setBusy(true);
    const reply = await rpc("board.migrate_from_drogon", replace ? { replace: true } : {});
    setBusy(false);
    if (!reply.ok) {
      if (!replace && /already has/.test(reply.error.message)) {
        if (window.confirm(`${reply.error.message}\n\nReplace this board's tickets with Drogon's?`)) void bring(true);
        return;
      }
      toast.error(reply.error.message);
      return;
    }
    const done = reply.result as { tickets: number; boards: number; unmappedProjects: string[] };
    const missing = done.unmappedProjects.length
      ? ` Add these folders to Orca to work in them again: ${done.unmappedProjects.join(", ")}.`
      : "";
    toast.success(`Brought ${done.tickets} tickets and ${done.boards} imported boards from Drogon.${missing}`);
    setStatus({ ...status, migrated: { tickets: done.tickets, unmappedProjects: done.unmappedProjects } });
    onMigrated();
  };

  return (
    <div
      role="region"
      aria-label="Bring your Drogon board"
      className="flex items-center gap-3 border-b border-border bg-muted/40 px-4 py-2 text-sm"
    >
      <p className="min-w-0 flex-1 text-muted-foreground">
        Drogon has a Work board with {status.drogonTickets} tickets
        {status.drogonBoards ? ` and ${status.drogonBoards} imported boards` : ""}. Bring it here: columns, prompts,
        tickets, imported boards and their connections.
      </p>
      <Button size="sm" disabled={busy} onClick={() => void bring(false)}>
        {busy ? <Loader2 className="animate-spin" /> : null} Bring my Drogon board
      </Button>
      <Button size="sm" variant="ghost" onClick={dismiss}>
        Not now
      </Button>
    </div>
  );
}
