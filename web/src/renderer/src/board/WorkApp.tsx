// The Work board as an Orca plugin page: Drogon's Work page over the
// service's RPC, with Orca's worktrees as workspaces and Orca terminals as
// sessions. Opening a session brings its terminal to the front in Orca.
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { Session } from "../../../shared/session-contract";
import { TooltipProvider } from "../components/ui/tooltip";
import { Toaster } from "../components/ui/sonner";
import { WorkPage, type WorkSessionTarget } from "../features/work/WorkPage";
import type { WorkWorkspace } from "../features/work/WorkTicketPanel";
import { httpRpc, workBridgeOver, type Rpc } from "./board-rpc";
import { DrogonMigrationBanner } from "./DrogonMigrationBanner";

export function WorkApp({ rpc = httpRpc }: { rpc?: Rpc }) {
  const bridge = useMemo(() => workBridgeOver(rpc), [rpc]);
  const [workspaces, setWorkspaces] = useState<WorkWorkspace[]>([]);
  const [boardKey, setBoardKey] = useState(0);

  const loadWorkspaces = useCallback(async () => {
    const reply = await rpc("orca.workspaces");
    if (reply.ok) setWorkspaces((reply.result as { workspaces: WorkWorkspace[] }).workspaces);
  }, [rpc]);

  useEffect(() => {
    void loadWorkspaces();
    // Worktrees come and go in Orca; the pickers follow.
    const timer = setInterval(() => void loadWorkspaces(), 10_000);
    const onFocus = () => void loadWorkspaces();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadWorkspaces]);

  const listSessions = useCallback(async (): Promise<Session[]> => {
    const reply = await rpc("orca.sessions");
    if (!reply.ok) throw new Error(reply.error.message);
    return (reply.result as { sessions: Session[] }).sessions;
  }, [rpc]);

  const openSession = useCallback(
    (target: WorkSessionTarget) => {
      void rpc("orca.session_focus", { sessionId: target.sessionId }).then((reply) => {
        if (!reply.ok) toast.error(reply.error.message);
      });
    },
    [rpc],
  );

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <DrogonMigrationBanner rpc={rpc} onMigrated={() => setBoardKey((k) => k + 1)} />
        <div className="min-h-0 flex-1">
          <WorkPage
            key={boardKey}
            bridge={bridge}
            workspaces={workspaces}
            listSessions={listSessions}
            onOpenSession={openSession}
            onOpenExternal={(url) => window.open(url, "_blank", "noopener")}
          />
        </div>
      </div>
      <Toaster closeButton toastOptions={{ className: "font-sans text-sm" }} />
    </TooltipProvider>
  );
}
