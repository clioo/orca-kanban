// The column's prompt panel ("Review · Prompt"): when the column sends, what
// it types into the sessions linked to its tickets, who receives it, and the
// Preview / Send now controls. Toggles save immediately; the message saves
// on blur and before any preview or send, so what is sent is what is shown.
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Textarea } from "../../components/ui/textarea";
import {
  WORK_HARNESSES,
  type WorkBoard,
  type WorkBridge,
  type WorkColumn,
  type WorkColumnUpdate,
  type WorkPreview,
} from "../../../../shared/work-contract";
import type { WorkBoardState } from "./use-work-board";
import { deliverySummary, formatClock, scheduleLabel, WORK_SCHEDULES } from "./work-format";
import { templatesFor } from "./work-prompt-templates";
import { providerLabel, sprintTerm } from "./work-sources";

const PLACEHOLDERS =
  "{ticket.id} {ticket.title} {ticket.description} {ticket.pr} {ticket.url} {ticket.next} {ticket.project} {ticket.status} {column.next} {board.cli}";

export function WorkColumnPanel({
  column,
  board,
  state,
  bridge,
  onClose,
  onNotice,
}: {
  column: WorkColumn;
  board: WorkBoard;
  state: WorkBoardState;
  bridge: WorkBridge;
  onClose: () => void;
  onNotice: (message: string, kind?: "error" | "success") => void;
}) {
  const [message, setMessage] = useState(column.message);
  const [preview, setPreview] = useState<WorkPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [customCron, setCustomCron] = useState(
    column.cron && !WORK_SCHEDULES.some((s) => s.value === column.cron) ? column.cron : "",
  );
  const lastSaved = useRef(column.message);
  // Switching columns starts from that column's saved state.
  useEffect(() => {
    setMessage(column.message);
    setPreview(null);
    lastSaved.current = column.message;
  }, [column.id]);
  // A message changed elsewhere (the CLI, another window) replaces the draft
  // only while the draft still equals what was last saved: never an edit in
  // progress, and never the preview it produced.
  useEffect(() => {
    if (column.message === lastSaved.current) return;
    setMessage((draft) => (draft === lastSaved.current ? column.message : draft));
    lastSaved.current = column.message;
  }, [column.message]);

  const tickets = board.tickets.filter((t) => t.columnId === column.id);
  const imported = Boolean(column.boardId);
  const provider = providerLabel(board.board?.provider);
  const [editingStatuses, setEditingStatuses] = useState(false);
  const statuses = board.board?.statuses ?? [];
  const mapped = new Set((column.statuses ?? []).map((s) => s.id));
  const ownerOf = (statusId: string) =>
    board.columns.find((c) => c.id !== column.id && (c.statuses ?? []).some((s) => s.id === statusId));
  const linkedSessions = tickets.reduce((n, t) => n + t.sessions.length, 0);

  const save = async (update: Omit<WorkColumnUpdate, "columnId">): Promise<boolean> => {
    const result = await state.run(() => bridge.columnUpdate({ columnId: column.id, ...update }));
    if (!result.ok) onNotice(result.error, "error");
    return result.ok;
  };
  const saveMessage = async (): Promise<boolean> => {
    if (message === lastSaved.current) return true;
    const saved = await save({ message });
    if (saved) lastSaved.current = message;
    return saved;
  };

  const scheduleValue = column.cron
    ? WORK_SCHEDULES.some((s) => s.value === column.cron)
      ? column.cron
      : "custom"
    : "";

  return (
    <aside
      className="flex w-[380px] shrink-0 flex-col border-l border-border bg-background"
      aria-label={`${column.name} prompt`}
      data-testid="work-column-panel"
    >
      <header className="flex items-start gap-2 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-foreground">
            {column.name} · Prompt
          </h2>
          <p className="text-xs text-muted-foreground">
            For sessions linked to tickets in this column
          </p>
        </div>
        <Button variant="ghost" size="icon-xs" aria-label="Close prompt panel" onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        <section className="shrink-0 space-y-3" aria-label="Send when">
          <h3 className="text-sm font-semibold text-foreground">Send when</h3>
          <label className="flex items-center gap-2.5 text-sm">
            <Checkbox
              checked={column.sendOnEnter}
              aria-label={`Ticket enters ${column.name}`}
              onCheckedChange={(checked) => void save({ sendOnEnter: checked === true })}
            />
            Ticket enters {column.name}
          </label>
          <label className="flex items-center gap-2.5 text-sm">
            <Checkbox
              checked={column.prWatch}
              aria-label="Pull request changes"
              onCheckedChange={(checked) => void save({ prWatch: checked === true })}
            />
            Pull request changes
          </label>
          <div className="flex items-center gap-2.5 text-sm">
            <Checkbox
              checked={column.cron !== null}
              aria-label="On a schedule"
              onCheckedChange={(checked) =>
                void save({ cron: checked === true ? (column.cron ?? "*/15 * * * *") : null })
              }
            />
            <span>On a schedule</span>
            <select
              aria-label="Schedule"
              className="ml-auto h-7 rounded-md border border-input bg-transparent px-2 text-xs"
              value={scheduleValue}
              disabled={column.cron === null}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "custom") {
                  setCustomCron(column.cron ?? "*/10 * * * *");
                  return;
                }
                void save({ cron: value || null });
              }}
            >
              {column.cron === null ? <option value="">off</option> : null}
              {WORK_SCHEDULES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
              <option value="custom">custom cron…</option>
            </select>
          </div>
          {scheduleValue === "custom" || customCron ? (
            <input
              aria-label="Custom cron (UTC)"
              className="h-7 w-full rounded-md border border-input bg-transparent px-2 font-mono text-xs"
              value={customCron}
              placeholder="*/10 * * * *"
              onChange={(event) => setCustomCron(event.target.value)}
              onBlur={() => {
                if (customCron.trim() && customCron !== column.cron) void save({ cron: customCron.trim() });
              }}
            />
          ) : null}
          {column.cron && column.nextRunAt ? (
            <p className="text-xs text-muted-foreground">
              Next scheduled send {formatClock(column.nextRunAt)} ({scheduleLabel(column.cron)}, UTC)
            </p>
          ) : null}
        </section>

        {imported ? (
          <section className="shrink-0 space-y-2" aria-label={`${provider} statuses`}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">{provider} statuses</h3>
              <Button variant="ghost" size="xs" onClick={() => setEditingStatuses((v) => !v)}>
                {editingStatuses ? "Done" : "Change"}
              </Button>
            </div>
            {!editingStatuses ? (
              <p className="flex flex-wrap gap-1.5 text-xs" data-testid="work-column-mapped">
                {(column.statuses ?? []).length ? (
                  (column.statuses ?? []).map((s) => (
                    <span key={s.id} className="rounded-md border border-border px-1.5 py-0.5 text-foreground">
                      {s.name}
                    </span>
                  ))
                ) : (
                  <span className="text-muted-foreground">None: a board-only column.</span>
                )}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                A card dropped here asks {provider} for the first status (after you push). A card whose{" "}
                {provider} status is mapped here moves here on sync. None mapped: a board-only column.
              </p>
            )}
            {editingStatuses ? (
            <ul className="space-y-1.5" data-testid="work-column-statuses">
              {statuses.map((status) => {
                const owner = ownerOf(status.id);
                return (
                  <li key={status.id}>
                    <label className="flex items-center gap-2.5 text-sm">
                      <Checkbox
                        checked={mapped.has(status.id)}
                        aria-label={`Map ${status.name} to ${column.name}`}
                        onCheckedChange={(checked) => {
                          const ids = (column.statuses ?? []).map((s) => s.id).filter((id) => id !== status.id);
                          void save({ statusIds: checked === true ? [...ids, status.id] : ids });
                        }}
                      />
                      <span className="flex-1">{status.name}</span>
                      {owner ? <span className="text-xs text-muted-foreground">in {owner.name}</span> : null}
                    </label>
                  </li>
                );
              })}
            </ul>
            ) : null}
          </section>
        ) : null}

        <section className="flex shrink-0 flex-col gap-2" aria-label="Message to sessions">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">Message to sessions</h3>
            <select
              aria-label="Use a template"
              className="h-7 rounded-md border border-input bg-transparent px-2 text-xs"
              value=""
              onChange={async (event) => {
                const template = templatesFor(column.icon).find((t) => t.id === event.target.value);
                if (!template) return;
                if (message.trim() && message !== template.text && !window.confirm("Replace the current prompt with this template?")) return;
                setMessage(template.text);
                const saved = await save({ message: template.text });
                if (saved) lastSaved.current = template.text;
              }}
            >
              <option value="">Use a template…</option>
              {templatesFor(column.icon).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <Textarea
            aria-label="Message to sessions"
            className="min-h-[200px] text-sm leading-6"
            value={message}
            placeholder={`What should the sessions do when a ticket is in ${column.name}?`}
            onChange={(event) => setMessage(event.target.value)}
            onBlur={() => void saveMessage()}
          />
          <p className="text-[11px] text-muted-foreground">Placeholders: {PLACEHOLDERS}</p>
        </section>

        <section className="shrink-0 space-y-2" aria-label="Recipients">
          <h3 className="text-sm font-semibold text-foreground">Recipients</h3>
          <select
            aria-label="Recipients"
            className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
            value={column.recipients}
            onChange={(event) => void save({ recipients: event.target.value as "all" | "primary" })}
          >
            <option value="all">All linked sessions ({linkedSessions})</option>
            <option value="primary">Primary session only</option>
          </select>
          <p className="text-xs text-muted-foreground">
            Live sessions are typed into right away; a session that is no longer running is
            resumed; a ticket with nothing to resume gets a new session.
            {board.board?.kind === "scrum" ? ` Prompts reach only tickets in the active ${sprintTerm(board.board?.provider)}.` : ""}
          </p>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            New sessions start with
            <select
              aria-label="Harness for new sessions"
              className="ml-auto h-7 rounded-md border border-input bg-transparent px-2 text-xs text-foreground"
              value={column.harnessId ?? ""}
              onChange={(event) => void save({ harnessId: event.target.value || null })}
            >
              <option value="">the default agent</option>
              {WORK_HARNESSES.map((h) => (
                <option key={h} value={h}>
                  {h === "claude" ? "Claude Code" : h === "opencode" ? "OpenCode" : h === "pi" ? "Pi" : h === "codex" ? "Codex" : "Antigravity"}
                </option>
              ))}
            </select>
          </label>
        </section>

        {preview ? (
          <section className="shrink-0 space-y-2" aria-label="Preview" data-testid="work-column-preview">
            <h3 className="text-sm font-semibold text-foreground">Preview</h3>
            {preview.previews.length === 0 ? (
              <p className="text-xs text-muted-foreground">No tickets in this column: a send does nothing.</p>
            ) : (
              preview.previews.map((p) => (
                <div key={p.ticketId} className="rounded-md border border-border p-2 text-xs">
                  <div className="mb-1 font-medium text-foreground">
                    {p.ticketKey} →{" "}
                    {p.recipients
                      .map((r) => `${r.action}${r.sessionId ? ` ${r.sessionId.slice(0, 8)}` : ""}`)
                      .join(", ")}
                  </div>
                  <pre className="whitespace-pre-wrap font-sans text-muted-foreground">{p.message}</pre>
                </div>
              ))
            )}
          </section>
        ) : null}
      </div>
      <footer className="space-y-2 border-t border-border px-5 py-4">
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                if (!(await saveMessage())) return;
                const result = await state.run(() => bridge.preview({ columnId: column.id }));
                if (result.ok) setPreview(result.value);
                else onNotice(result.error, "error");
              } finally {
                setBusy(false);
              }
            }}
          >
            Preview
          </Button>
          <Button
            disabled={busy || !message.trim() || tickets.length === 0 || board.view?.promptsPaused === true}
            onClick={async () => {
              setBusy(true);
              try {
                if (!(await saveMessage())) return;
                const result = await state.run(() => bridge.columnSend({ columnId: column.id }));
                if (result.ok) {
                  const all = result.value.sends.flatMap((s) => s.results);
                  onNotice(`Sent to ${column.name}: ${deliverySummary(all) || "nothing"}`, "success");
                } else {
                  onNotice(result.error, "error");
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            Send now
          </Button>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="work-column-last-sent">
          {column.lastSentAt
            ? `Last sent ${formatClock(column.lastSentAt)} · ${column.lastSentCount} ${column.lastSentCount === 1 ? "session" : "sessions"}`
            : "Not sent yet"}
        </p>
      </footer>
    </aside>
  );
}
