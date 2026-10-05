// Import a source's board (a Jira board, a Linear team, a GitHub project or
// repository): pick the board that frames the import, then choose which of
// its issues come in. A board usually spans several projects and people, so
// the picker opens on the issues assigned to you (all chosen), and filters
// by person, project, status and words let you add any other; what you
// chose stays chosen across filters. "Keep importing new issues assigned to
// me" makes every sync bring in the ones assigned to you later. The first
// import creates the board's columns from the source's (mapped to its
// statuses); later ones add issues. A source that is allowed but not
// connected yet shows its connect form first.
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, Search } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import type {
  WorkBoardSummary,
  WorkBridge,
  WorkImportFilter,
  WorkImportPreview,
  WorkProviderIssue,
  WorkSource,
} from "../../../../shared/work-contract";
import {
  RECOMMENDED_LIMIT,
  assignedLabel,
  filterBoards,
  groupBoards,
  visibleRecommendations,
  type PickerBoard,
} from "./work-board-picker";
import { IssueTypeBadge, ProviderMark, capitalize } from "./work-sources";
import { boardsTerm, WorkSourceConnectForm } from "./WorkSources";

type Group = { id: string; label: string; issues: WorkProviderIssue[] };

/** What the picker chooses when a board's issues first load: the active
 *  sprint's (what you are working on now), or every listed issue when the
 *  board has no active sprint with anything to import. Issues already on
 *  the board are never chosen again. */
export function defaultChosen(preview: WorkImportPreview): Set<string> {
  const importable = (issues: WorkProviderIssue[]) => issues.filter((i) => !i.importedTicketId).map((i) => i.key);
  const active = new Set(preview.sprints.filter((s) => s.state === "active").map((s) => s.id));
  const inActive = importable(preview.issues.filter((i) => i.sprint && active.has(i.sprint.id)));
  return new Set(inActive.length > 0 ? inActive : importable(preview.issues));
}

/** Issues grouped the way a scrum board reads: active sprint, upcoming
 *  sprints, backlog, then what already finished in a past sprint. */
export function groupIssues(preview: WorkImportPreview, sprintTerm = "sprint"): Group[] {
  if (preview.board.kind !== "scrum") {
    return [{ id: "all", label: "Issues", issues: preview.issues }];
  }
  const groups: Group[] = [];
  const open = preview.sprints.filter((s) => s.state === "active").concat(preview.sprints.filter((s) => s.state === "future"));
  for (const sprint of open) {
    const issues = preview.issues.filter((i) => i.sprint?.id === sprint.id);
    if (issues.length) {
      groups.push({
        id: `sprint:${sprint.id}`,
        label: `${sprint.name} · ${sprint.state === "active" ? "Active" : "Upcoming"}`,
        issues,
      });
    }
  }
  const unsprinted = preview.issues.filter((i) => !i.sprint || !open.some((s) => s.id === i.sprint?.id));
  const finished = unsprinted.filter((i) => i.status.category === "done" && i.closedSprints.length > 0);
  const backlog = unsprinted.filter((i) => !finished.includes(i));
  if (backlog.length) groups.push({ id: "backlog", label: "Backlog", issues: backlog });
  if (finished.length) groups.push({ id: "finished", label: `Finished in past ${sprintTerm}s`, issues: finished });
  return groups;
}

const SELECT = "h-8 min-w-0 rounded-md border border-input bg-transparent px-2 text-xs";

export function WorkImportDialog({
  open,
  bridge,
  source,
  projects,
  initialBoard,
  onClose,
  onImported,
  onOpenExternal,
  onOpenTasks,
  onSourceChanged,
}: {
  open: boolean;
  bridge: WorkBridge;
  /** The source to import from. */
  source: WorkSource;
  projects: { id: string; name: string }[];
  /** Skip straight to the issue picker of this provider board. */
  initialBoard?: { externalId: string; projectId?: string | null } | null;
  onClose: () => void;
  onImported: (board: WorkBoardSummary, imported: number) => void;
  onOpenExternal: (url: string) => void;
  onOpenTasks?: () => void;
  /** A connection made from the dialog: the page reloads its sources. */
  onSourceChanged?: () => void;
}) {
  const provider = source.id;
  const [needsConnect, setNeedsConnect] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [boards, setBoards] = useState<PickerBoard[] | null>(null);
  const [boardQuery, setBoardQuery] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [external, setExternal] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorkImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<WorkImportFilter>({ assignee: "me", open: true });
  const [query, setQuery] = useState("");
  const [autoMine, setAutoMine] = useState(true);
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The first answer for a board preselects the issues assigned to you. */
  const seeded = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPreview(null);
    setChosen(new Set());
    setFilter({ assignee: "me", open: true });
    setQuery("");
    setBoardQuery("");
    seeded.current = null;
    setProjectId(initialBoard?.projectId ?? "");
    setExternal(initialBoard?.externalId ?? null);
    setNeedsConnect(false);
    if (initialBoard) return;
    setBoards(null);
    let cancelled = false;
    void bridge.providerBoards({ provider }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setBoards(result.result.boards);
        setWarnings(result.result.warnings ?? []);
      } else if (/_not_connected$/.test(result.error.code)) setNeedsConnect(true);
      else setError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, [open, bridge, initialBoard, provider, attempt]);

  // Words filter as you type, without a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setFilter((f) => ({ ...f, query: query.trim() || undefined })), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open || !external) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const input: Parameters<WorkBridge["importPreview"]>[0] = { externalBoardId: external, provider };
    for (const [key, value] of Object.entries(filter)) {
      if (value && value !== "any") (input as Record<string, unknown>)[key] = value;
    }
    void bridge.importPreview(input).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const answer = result.result;
      // Nothing assigned to you here: show everyone instead.
      if (seeded.current !== external && filter.assignee === "me" && (answer.facets?.mine ?? 0) === 0) {
        seeded.current = external;
        setFilter((f) => ({ ...f, assignee: "any" }));
        return;
      }
      setPreview(answer);
      if (seeded.current !== external) {
        seeded.current = external;
        setChosen(defaultChosen(answer));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, bridge, external, provider, filter]);

  const groups = useMemo(() => (preview ? groupIssues(preview, source.sprintTerm) : []), [preview, source.sprintTerm]);
  const facets = preview?.facets;
  const toggle = (keys: string[], on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });

  const importNow = async () => {
    if (!external || (chosen.size === 0 && !autoMine)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.boardImport({
        provider,
        externalBoardId: external,
        issueKeys: [...chosen],
        autoImportMine: autoMine,
        projectId: projectId || undefined,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      onImported(result.result.board, result.result.imported);
    } finally {
      setBusy(false);
    }
  };

  const setOne = (key: keyof WorkImportFilter) => (event: React.ChangeEvent<HTMLSelectElement>) =>
    setFilter((f) => ({ ...f, [key]: event.target.value || undefined }));

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-3xl" data-testid="work-import-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ProviderMark provider={provider} className="size-4" />
            {preview ? `Import from ${preview.board.name}` : `Import a ${source.name} ${source.boardTerm}`}
          </DialogTitle>
          <DialogDescription>
            {preview
              ? `Yours in the active ${source.sprintTerm} are chosen; pick more or filter to add others. Each keeps its ${source.name} key, and its column's prompts reach the sessions you link to it.`
              : needsConnect
                ? `Connect ${source.name} to see its ${boardsTerm(source)}.`
                : `Pick the ${source.name} ${source.boardTerm} that frames the import: its columns and ${source.sprintTerm}s come with it.`}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        {!external && warnings.length ? (
          <div className="space-y-1" data-testid="work-import-warnings">
            {warnings.map((w) => (
              <p key={w} className="rounded-md border border-amber-500/40 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300" role="status">
                {w}
              </p>
            ))}
          </div>
        ) : null}

        {needsConnect && !external ? (
          <WorkSourceConnectForm
            source={source}
            bridge={bridge}
            onOpenExternal={onOpenExternal}
            onOpenTasks={onOpenTasks}
            onConnected={() => {
              onSourceChanged?.();
              setNeedsConnect(false);
              setAttempt((n) => n + 1);
            }}
          />
        ) : !external ? (
          boards === null && !error ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading {source.name} {boardsTerm(source)}…
            </p>
          ) : (
            <BoardPicker
              boards={boards ?? []}
              query={boardQuery}
              onQuery={setBoardQuery}
              onChoose={setExternal}
              provider={provider}
              source={source}
            />
          )
        ) : !preview && !error ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Reading the {source.boardTerm}…
          </p>
        ) : preview ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground" data-testid="work-import-columns">
              Columns: {preview.columns.map((c) => c.name).join(" · ")}
            </p>
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
              <select aria-label="Assigned to" className={SELECT} value={filter.assignee ?? "any"} onChange={setOne("assignee")}>
                <option value="me">Assigned to me{facets ? ` (${facets.mine})` : ""}</option>
                <option value="any">Anyone</option>
                <option value="none">Unassigned{facets ? ` (${facets.unassigned})` : ""}</option>
                {(facets?.people ?? [])
                  .filter((p) => p.id !== preview.me)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.count})
                    </option>
                  ))}
              </select>
              {facets && (facets.projects.length > 0 || facets.noProject > 0) ? (
                <select aria-label="Project" className={SELECT} value={filter.project ?? ""} onChange={setOne("project")}>
                  <option value="">All projects</option>
                  {facets.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.count})
                    </option>
                  ))}
                  {facets.noProject ? <option value="none">No project ({facets.noProject})</option> : null}
                </select>
              ) : null}
              <select aria-label="Status" className={SELECT} value={filter.status ?? ""} onChange={setOne("status")}>
                <option value="">All statuses</option>
                {(facets?.statuses ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.count})
                  </option>
                ))}
              </select>
              <div className="relative min-w-[160px] flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Search issues"
                  className="h-8 pl-7 text-xs"
                  placeholder="Key or title…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox
                  checked={filter.open === true}
                  aria-label="Hide finished issues"
                  onCheckedChange={(checked) => setFilter((f) => ({ ...f, open: checked === true || undefined }))}
                />
                Hide finished{facets?.finished ? ` (${facets.finished})` : ""}
              </label>
              {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Filtering" /> : null}
            </div>
            {preview.truncated ? (
              <p className="text-xs text-amber-600 dark:text-amber-400" role="status">
                Showing {preview.issues.length} of {preview.total} matching issues. Narrow the filters to see the rest.
              </p>
            ) : null}
            <div className="max-h-[320px] space-y-4 overflow-y-auto pr-1" aria-label="Issues">
              {preview.issues.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No issues match these filters.</p>
              ) : null}
              {groups.filter((g) => g.issues.length > 0).map((group) => {
                const selectable = group.issues.filter((i) => !i.importedTicketId).map((i) => i.key);
                const all = selectable.length > 0 && selectable.every((k) => chosen.has(k));
                return (
                  <section key={group.id} aria-label={group.label}>
                    <label className="mb-1 flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                      <Checkbox
                        checked={all}
                        disabled={selectable.length === 0}
                        aria-label={`All of ${group.label}`}
                        onCheckedChange={(checked) => toggle(selectable, checked === true)}
                      />
                      {group.label} <span className="font-normal">{group.issues.length}</span>
                    </label>
                    <ul className="divide-y divide-border/60 rounded-md border border-border">
                      {group.issues.map((issue) => (
                        <li key={issue.key} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                          <Checkbox
                            checked={issue.importedTicketId ? true : chosen.has(issue.key)}
                            disabled={Boolean(issue.importedTicketId)}
                            aria-label={`Import ${issue.key}`}
                            onCheckedChange={(checked) => toggle([issue.key], checked === true)}
                          />
                          <span className="w-20 shrink-0 truncate font-mono text-xs text-muted-foreground">{issue.key}</span>
                          <span className="min-w-0 flex-1 truncate" title={issue.title}>
                            {issue.title}
                          </span>
                          <IssueTypeBadge type={issue.issueType} />
                          <span className="w-24 shrink-0 truncate text-right text-xs text-muted-foreground" title={issue.assignee ?? "Unassigned"}>
                            {issue.assigneeId && issue.assigneeId === preview.me ? "You" : (issue.assignee ?? "—")}
                          </span>
                          <span className="w-24 shrink-0 truncate text-right text-xs text-muted-foreground">
                            {issue.importedTicketId ? "On the board" : issue.status.name}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={autoMine}
                aria-label="Keep importing new issues assigned to me"
                onCheckedChange={(checked) => setAutoMine(checked === true)}
              />
              Keep importing new issues assigned to me on every sync
            </label>
            <div className="space-y-1">
              <label className="flex items-center gap-2 text-sm">
                <span className="shrink-0 text-muted-foreground">Agents work in</span>
                <select
                  aria-label="Agents work in"
                  aria-describedby="work-import-agents-work-in-hint"
                  className="h-8 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  <option value="">Choose per ticket later</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <p id="work-import-agents-work-in-hint" className="text-xs text-muted-foreground">
                When a ticket starts a session (a column&apos;s prompt or New session), it opens in this project&apos;s folder.
              </p>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          {external && !initialBoard ? (
            <Button variant="ghost" className="mr-auto" onClick={() => setExternal(null)}>
              <ArrowLeft /> {capitalize(boardsTerm(source))}
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {preview ? (
            <Button disabled={busy || (chosen.size === 0 && !autoMine)} onClick={() => void importNow()}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              Import {chosen.size} {chosen.size === 1 ? "issue" : "issues"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The board list: a filter by name or project, then the boards holding
 *  your open issues ("Recommended for you", most first) above the rest. */
function BoardPicker({
  boards,
  query,
  onQuery,
  onChoose,
  provider,
  source,
}: {
  boards: PickerBoard[];
  query: string;
  onQuery: (query: string) => void;
  onChoose: (externalId: string) => void;
  provider: string;
  source: WorkSource;
}) {
  const term = boardsTerm(source);
  const shown = filterBoards(boards, query);
  const { recommended, rest } = groupBoards(shown);
  const [expanded, setExpanded] = useState(false);
  const filtering = Boolean(query.trim());
  const visible = visibleRecommendations(recommended, { expanded, filtering });
  // Only a recommendation says how many of your issues it holds.
  const isRecommended = new Set(recommended);
  const row = (b: PickerBoard) => {
    const label = isRecommended.has(b) ? assignedLabel(b) : null;
    return (
    <li key={b.id}>
      <button
        type="button"
        className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent"
        onClick={() => onChoose(b.id)}
        aria-label={`Choose ${b.name}`}
      >
        <ProviderMark provider={provider} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-foreground">{b.name}</span>
          <span className="block text-xs text-muted-foreground">
            {b.kind === "scrum" ? `${capitalize(source.sprintTerm)}s` : "Kanban"}
            {b.projectKey ? ` · ${b.projectKey}` : ""}
            {b.projectName && b.projectName !== b.name ? ` · ${b.projectName}` : ""}
          </span>
        </span>
        {label ? <span className="shrink-0 text-xs text-muted-foreground">{label}</span> : null}
        {b.importedBoardId ? (
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">Imported</span>
        ) : null}
      </button>
    </li>
  );
  };
  if (boards.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {source.name} has no {term} this account can see.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label={`Filter ${term}`}
          className="h-8 pl-7 text-xs"
          placeholder="Name or project…"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            // Enter picks the board when the filter narrowed it to one.
            if (event.key === "Enter" && shown.length === 1) {
              event.preventDefault();
              onChoose(shown[0]!.id);
            }
          }}
        />
      </div>
      <div className="max-h-[360px] space-y-3 overflow-y-auto pr-1" aria-label={`${source.name} ${term}`}>
        {shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No {term} match “{query.trim()}”.
          </p>
        ) : null}
        {recommended.length > 0 ? (
          <section aria-label="Recommended for you">
            <p className="mb-1 text-xs font-semibold text-muted-foreground">
              Recommended for you <span className="font-normal">{recommended.length}</span>
            </p>
            <ul className="space-y-1">{visible.shown.map(row)}</ul>
            {recommended.length > RECOMMENDED_LIMIT && !filtering ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1 h-7 px-2 text-xs text-muted-foreground"
                onClick={() => setExpanded((open) => !open)}
              >
                {visible.hidden > 0 ? `Show all ${recommended.length}` : "Show fewer"}
              </Button>
            ) : null}
          </section>
        ) : null}
        {rest.length > 0 ? (
          <section aria-label={recommended.length > 0 ? `All ${term}` : undefined}>
            {recommended.length > 0 ? (
              <p className="mb-1 text-xs font-semibold text-muted-foreground">
                All {term} <span className="font-normal">{rest.length}</span>
              </p>
            ) : null}
            <ul className="space-y-1">{rest.map(row)}</ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
