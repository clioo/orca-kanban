// New issue on an imported board: "+" on a column (or New ticket) creates
// the issue in the board's source — Linear, Jira, GitHub — in that column's
// status, then it lands on the board like an imported one. The form asks
// only what the source needs: a Jira issue type, a GitHub Project's
// repository, the sprint on a sprint board.
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
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
import type {
  WorkBoard,
  WorkBoardSummary,
  WorkBridge,
  WorkCreateOptions,
  WorkTicketCreate,
} from "../../../../shared/work-contract";
import { ProviderMark, capitalize, providerLabel, sprintLabel, sprintTerm } from "./work-sources";

const SELECT = "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm";

/** The sprint a new issue goes into: the one being viewed when it takes
 *  issues, the backlog when that is viewed, else the active one. */
export function defaultSprint(board: WorkBoard): string {
  const view = board.view;
  if (!view || view.sprints.length === 0) return "";
  if (view.kind === "backlog") return "backlog";
  if (view.kind === "sprint" && view.sprint && view.sprint.state !== "closed") return view.sprint.id;
  return view.sprints.find((s) => s.state === "active")?.id ?? "backlog";
}

export function WorkCreateIssueDialog({
  open,
  bridge,
  board,
  summary,
  initialColumn,
  onClose,
  onCreate,
}: {
  open: boolean;
  bridge: WorkBridge;
  board: WorkBoard;
  /** The imported board shown. */
  summary: WorkBoardSummary;
  initialColumn: string;
  onClose: () => void;
  /** Resolves to an error message, or null once created. */
  onCreate: (input: WorkTicketCreate) => Promise<string | null>;
}) {
  const provider = summary.provider ?? "";
  const source = providerLabel(provider);
  const term = sprintTerm(provider);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [columnId, setColumnId] = useState(initialColumn);
  const [sprintId, setSprintId] = useState("");
  const [assignToMe, setAssignToMe] = useState(true);
  const [issueType, setIssueType] = useState("");
  const [repo, setRepo] = useState("");
  const [options, setOptions] = useState<WorkCreateOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOpen, setLastOpen] = useState(false);
  if (open && !lastOpen) {
    setLastOpen(true);
    setTitle("");
    setDescription("");
    setColumnId(initialColumn || board.columns[0]?.id || "");
    setSprintId(defaultSprint(board));
    setAssignToMe(true);
    setError(null);
    setBusy(false);
  } else if (!open && lastOpen) {
    setLastOpen(false);
  }

  // Jira issue types and a GitHub Project's repositories come from the
  // source; Linear needs nothing more than the team.
  const needsOptions = provider === "jira" || (provider === "github" && summary.externalId?.startsWith("project:"));
  useEffect(() => {
    if (!open || !needsOptions) return;
    let live = true;
    setOptions(null);
    setOptionsError(null);
    void bridge.createOptions({ boardId: summary.id }).then((result) => {
      if (!live) return;
      if (!result.ok) {
        setOptionsError(result.error.message);
        return;
      }
      setOptions(result.result);
      setIssueType(result.result.issueTypes[0]?.id ?? "");
      setRepo(result.result.repos[0] ?? "");
    });
    return () => {
      live = false;
    };
  }, [open, needsOptions, bridge, summary.id]);

  const column = board.columns.find((c) => c.id === columnId);
  const status = column?.statuses?.[0]?.name;
  const sprints = (board.view?.sprints ?? []).filter((s) => s.state !== "closed");
  const loading = needsOptions && !options && !optionsError;
  const missingRepo = provider === "github" && needsOptions && !!options && !repo;
  const canCreate = !!title.trim() && !busy && !loading && !optionsError && !missingRepo;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent data-testid="work-create-issue-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ProviderMark provider={provider} className="size-4" /> New {source} issue
          </DialogTitle>
          <DialogDescription>
            Created in {source} ({summary.name}) and added to this board. Its column's prompt reaches the sessions
            you link.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          aria-label={`New ${source} issue`}
          onSubmit={async (event) => {
            event.preventDefault();
            if (!canCreate) return;
            setBusy(true);
            const failure = await onCreate({
              boardId: summary.id,
              title: title.trim(),
              columnId: columnId || undefined,
              description: description.trim() || undefined,
              assignToMe,
              ...(board.view?.sprints.length ? { sprintId: sprintId || "backlog" } : {}),
              ...(issueType && provider === "jira" ? { issueType } : {}),
              ...(repo && provider === "github" ? { repo } : {}),
            });
            setBusy(false);
            setError(failure);
          }}
        >
          <Input aria-label="Title" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-xs text-muted-foreground">
              Column
              <select aria-label="Column" className={SELECT} value={columnId} onChange={(e) => setColumnId(e.target.value)}>
                {board.columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {board.view?.sprints.length ? (
              <label className="grid gap-1 text-xs text-muted-foreground">
                {capitalize(term)}
                <select aria-label={capitalize(term)} className={SELECT} value={sprintId} onChange={(e) => setSprintId(e.target.value)}>
                  <option value="backlog">Backlog</option>
                  {sprints.map((s) => (
                    <option key={s.id} value={s.id}>
                      {sprintLabel(s)}
                      {s.state === "active" ? " · active" : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {provider === "jira" ? (
              <label className="grid gap-1 text-xs text-muted-foreground">
                Issue type
                <select aria-label="Issue type" className={SELECT} value={issueType} disabled={!options} onChange={(e) => setIssueType(e.target.value)}>
                  {loading ? <option value="">Loading…</option> : null}
                  {options?.issueTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {provider === "github" && needsOptions ? (
              <label className="grid gap-1 text-xs text-muted-foreground">
                Repository
                <select aria-label="Repository" className={SELECT} value={repo} disabled={!options} onChange={(e) => setRepo(e.target.value)}>
                  {loading ? <option value="">Loading…</option> : null}
                  {options && options.repos.length === 0 ? <option value="">No repository in this project yet</option> : null}
                  {options?.repos.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground" data-testid="work-create-issue-status">
            {status
              ? `It starts in ${source} as ${status}.`
              : `${column?.name ?? "This column"} has no ${source} status: the issue takes ${source}'s default and the card stays here.`}
          </p>
          <Textarea
            aria-label="Description"
            placeholder="Description (Markdown)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="min-h-24"
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={assignToMe} aria-label="Assign to me" onCheckedChange={(checked) => setAssignToMe(checked === true)} />
            Assign to me
          </label>
          {column?.sendOnEnter && column.message.trim() ? (
            <p className="text-xs text-muted-foreground">
              {column.name} sends its prompt when a ticket enters it: creating this issue there sends it now.
            </p>
          ) : null}
          {optionsError ? (
            <p className="text-sm text-destructive" role="alert">
              {optionsError}
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canCreate}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              Create in {source}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
