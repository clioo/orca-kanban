// Ticket sources on the Work page: which sources a board can sync with
// (Jira, Linear, GitHub), whether the owner allows each, and how each
// connects. The Sources tab manages them; the dismissible "Sync a board"
// card on an empty My work lists the allowed ones; the import dialog shows
// the connect form for a source that is allowed but not connected yet.
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import type { WorkBridge, WorkSource } from "../../../../shared/work-contract";
import { ProviderMark, capitalize } from "./work-sources";

export const SYNC_CARD_DISMISSED_KEY = "drogon:work:sync-card-dismissed";

/** The allowed sources in registry order, for import menus and the card. */
export function allowedSources(sources: WorkSource[]): WorkSource[] {
  return sources.filter((s) => s.enabled);
}

/** "Import a Jira board", "Import a Linear team", "Import a GitHub project
 *  or repository". */
export function importLabel(source: WorkSource): string {
  return `Import a ${source.name} ${source.boardTerm}`;
}

/** "boards", "teams", "projects and repositories". */
export function boardsTerm(source: WorkSource): string {
  return source.boardsTerm ?? `${source.boardTerm}s`;
}

export type WorkSourcesState = {
  sources: WorkSource[];
  /** False against a daemon without sources (Jira-only fallback). */
  supported: boolean;
  error: string | null;
  reload: () => Promise<void>;
};

const JIRA_ONLY: WorkSource = {
  id: "jira",
  name: "Jira",
  enabled: true,
  connected: false,
  account: null,
  via: null,
  apiUrl: null,
  error: null,
  boardTerm: "board",
  sprintTerm: "sprint",
  connect: "tasks",
  helpUrl: null,
  boards: 0,
};

export function useWorkSources(bridge: WorkBridge | null, active: boolean): WorkSourcesState {
  const [sources, setSources] = useState<WorkSource[]>([]);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!bridge?.sources) {
      setSupported(false);
      setSources([JIRA_ONLY]);
      return;
    }
    try {
      const result = await bridge.sources();
      if (result.ok) {
        setSources(result.result.sources);
        setSupported(true);
        setError(null);
      } else if (result.error.code === "unknown_method" || /unknown method/i.test(result.error.message)) {
        setSupported(false);
        setSources([JIRA_ONLY]);
      } else {
        setError(result.error.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [bridge]);
  useEffect(() => {
    if (active) void reload();
  }, [active, reload]);
  return { sources, supported, error, reload };
}

/** Connects Linear (API key) or GitHub (gh login or a token); for Jira it
 *  points at the Tasks page, whose connection Work uses. */
export function WorkSourceConnectForm({
  source,
  bridge,
  onConnected,
  onOpenExternal,
  onOpenTasks,
}: {
  source: WorkSource;
  bridge: WorkBridge;
  onConnected: (source: WorkSource) => void;
  onOpenExternal: (url: string) => void;
  onOpenTasks?: () => void;
}) {
  const [key, setKey] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [server, setServer] = useState(false);
  const [apiUrl, setApiUrl] = useState(source.apiUrl ?? "");
  const [advanced, setAdvanced] = useState(Boolean(source.apiUrl));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async (withKey: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.sourceConnect({
        provider: source.id,
        ...(withKey ? { apiKey: key.trim() } : {}),
        ...(apiUrl.trim() ? { apiUrl: apiUrl.trim() } : {}),
        ...(source.connect === "jira_token"
          ? { siteUrl: siteUrl.trim(), email: email.trim(), authType: server ? "server" : "cloud" }
          : {}),
      });
      if (result.ok) {
        setKey("");
        onConnected(result.result);
      } else setError(result.error.message);
    } finally {
      setBusy(false);
    }
  };

  if (source.connect === "tasks") {
    return (
      <div className="space-y-2 text-sm" data-testid={`work-connect-${source.id}`}>
        <p className="text-muted-foreground">
          Work uses the {source.name} connection from the Tasks page.
        </p>
        {onOpenTasks ? (
          <Button variant="outline" size="sm" onClick={onOpenTasks}>
            Connect {source.name} on the Tasks page
          </Button>
        ) : null}
      </div>
    );
  }

  if (source.connect === "jira_token") {
    const ready = siteUrl.trim() && key.trim() && (server || email.trim());
    return (
      <form
        className="space-y-2.5 text-sm"
        data-testid={`work-connect-${source.id}`}
        aria-label={`Connect ${source.name}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) void connect(true);
        }}
      >
        <p className="text-muted-foreground">
          {server
            ? "Jira Server or Data Center: your site and a personal access token."
            : "Jira Cloud: your site, the email you sign in with and an API token."}{" "}
          It is checked, then kept encrypted on this Mac.
        </p>
        <Input
          aria-label="Jira site URL"
          className="h-8"
          placeholder="https://your-team.atlassian.net"
          value={siteUrl}
          onChange={(event) => setSiteUrl(event.target.value)}
        />
        {server ? null : (
          <Input
            aria-label="Jira email"
            type="email"
            autoComplete="off"
            className="h-8"
            placeholder="you@company.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        )}
        <div className="flex items-center gap-2">
          {source.helpUrl && !server ? (
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenExternal(source.helpUrl!)}>
              <ExternalLink /> Get an API token
            </Button>
          ) : null}
          <Input
            aria-label={server ? "Jira personal access token" : "Jira API token"}
            type="password"
            autoComplete="off"
            className="h-8 flex-1"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={busy || !ready}>
            {busy ? <Loader2 className="animate-spin" /> : null} Connect
          </Button>
        </div>
        <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setServer(!server)}>
          {server ? "Jira Cloud?" : "Jira Server or Data Center?"}
        </button>
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    );
  }

  const github = source.connect === "gh_or_token";
  return (
    <form
      className="space-y-2.5 text-sm"
      data-testid={`work-connect-${source.id}`}
      aria-label={`Connect ${source.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (key.trim()) void connect(true);
      }}
    >
      {github ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => void connect(false)}>
            Use my gh login
          </Button>
          <span className="text-xs text-muted-foreground">or paste a token with repo and project access</span>
        </div>
      ) : (
        <p className="text-muted-foreground">
          Create a personal API key in {source.name}, then paste it here. It is checked, then kept encrypted on
          this Mac.
        </p>
      )}
      <div className="flex items-center gap-2">
        {source.helpUrl ? (
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenExternal(source.helpUrl!)}>
            <ExternalLink /> {github ? "Create a token" : `Get a ${source.name} API key`}
          </Button>
        ) : null}
        <Input
          aria-label={github ? "GitHub token" : `${source.name} API key`}
          type="password"
          autoComplete="off"
          className="h-8 flex-1"
          placeholder={github ? "ghp_…" : "lin_api_…"}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={busy || !key.trim()}>
          {busy ? <Loader2 className="animate-spin" /> : null} Connect
        </Button>
      </div>
      {github ? (
        advanced ? (
          <Input
            aria-label="GitHub Enterprise API URL"
            className="h-8"
            placeholder="https://github.example.com/api/v3"
            value={apiUrl}
            onChange={(event) => setApiUrl(event.target.value)}
          />
        ) : (
          <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setAdvanced(true)}>
            GitHub Enterprise?
          </button>
        )
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function statusLine(source: WorkSource): string {
  if (!source.enabled) return "Off: not imported, synced or pushed";
  if (source.connected) {
    const who = source.account ? `Connected as ${source.account}` : "Connected";
    return source.via === "gh" ? `${who} (gh login)` : who;
  }
  return "Not connected";
}

/** The Sources tab's list: allow or turn off each source, connect it,
 *  forget its key. */
export function WorkSourcesPanel({
  state,
  bridge,
  onOpenExternal,
  onOpenTasks,
  onNotice,
}: {
  state: WorkSourcesState;
  bridge: WorkBridge;
  onOpenExternal: (url: string) => void;
  onOpenTasks?: () => void;
  onNotice: (message: string, kind?: "error" | "success") => void;
}) {
  const [connecting, setConnecting] = useState<string | null>(null);
  if (!state.supported) return null;
  return (
    <section className="space-y-2" aria-label="Sync sources" data-testid="work-sync-sources">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Sync sources</h2>
        <p className="text-xs text-muted-foreground">
          Boards you can import and keep in sync. Turn off any you don't use.
        </p>
      </div>
      {state.error ? (
        <p className="text-xs text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}
      <ul className="divide-y divide-border/60 rounded-lg border border-border">
        {state.sources.map((source) => (
          <li key={source.id} className="px-3 py-2.5" aria-label={source.name} data-work-source={source.id}>
            <div className="flex items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border">
                <ProviderMark provider={source.id} className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {source.name}{" "}
                  <span className="font-normal text-muted-foreground">
                    · {capitalize(boardsTerm(source))}, {source.sprintTerm}s
                    {source.boards ? ` · ${source.boards} imported` : ""}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground" data-testid="work-source-status">
                  {statusLine(source)}
                </p>
                {source.error ? <p className="text-xs text-destructive">{source.error}</p> : null}
              </div>
              {source.enabled && source.connect !== "tasks" ? (
                source.connected && source.via === "token" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      const result = await bridge.sourceDisconnect({ provider: source.id });
                      if (!result.ok) onNotice(result.error.message, "error");
                      else onNotice(`Forgot the ${source.name} key`);
                      await state.reload();
                    }}
                  >
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConnecting(connecting === source.id ? null : source.id)}
                  >
                    {source.connected ? "Change" : "Connect"}
                  </Button>
                )
              ) : source.enabled && !source.connected && onOpenTasks ? (
                <Button variant="outline" size="sm" onClick={onOpenTasks}>
                  Connect
                </Button>
              ) : null}
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Allowed
                <Switch
                  checked={source.enabled}
                  aria-label={`Allow ${source.name}`}
                  onCheckedChange={async (checked) => {
                    const result = await bridge.sourceUpdate({ provider: source.id, enabled: checked });
                    if (!result.ok) onNotice(result.error.message, "error");
                    await state.reload();
                  }}
                />
              </label>
            </div>
            {connecting === source.id && source.enabled ? (
              <div className="mt-3 pl-11">
                <WorkSourceConnectForm
                  source={source}
                  bridge={bridge}
                  onOpenExternal={onOpenExternal}
                  onOpenTasks={onOpenTasks}
                  onConnected={async (connected) => {
                    setConnecting(null);
                    onNotice(`Connected ${connected.name}${connected.account ? ` as ${connected.account}` : ""}`);
                    await state.reload();
                  }}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(SYNC_CARD_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Whether the "Sync a board" card was dismissed, remembered per profile. */
export function useSyncCardDismissed(): [boolean, () => void, () => void] {
  const [dismissed, setDismissed] = useState(readDismissed);
  const dismiss = () => {
    try {
      localStorage.setItem(SYNC_CARD_DISMISSED_KEY, "1");
    } catch {
      // Private storage: dismissed for this session only.
    }
    setDismissed(true);
  };
  const restore = () => {
    try {
      localStorage.removeItem(SYNC_CARD_DISMISSED_KEY);
    } catch {
      // ignore
    }
    setDismissed(false);
  };
  return [dismissed, dismiss, restore];
}

/** The optional card on an empty My work: the boards the owner can sync. */
export function SyncSourcesCard({
  sources,
  onImport,
  onDismiss,
  onManage,
}: {
  sources: WorkSource[];
  onImport: (source: WorkSource) => void;
  onDismiss: () => void;
  onManage: () => void;
}) {
  return (
    <div
      className="pointer-events-auto relative w-[440px] rounded-xl border border-border bg-card px-7 py-6 shadow-sm"
      data-testid="work-sync-card"
      role="region"
      aria-label="Sync a board"
    >
      <Button
        variant="ghost"
        size="icon-xs"
        className="absolute top-3 right-3"
        aria-label="Dismiss"
        title="Dismiss (import stays in the Import board menu)"
        onClick={onDismiss}
      >
        <X />
      </Button>
      <div className="mb-3 flex justify-center gap-2">
        {sources.map((s) => (
          <ProviderMark key={s.id} provider={s.id} className="size-6" />
        ))}
      </div>
      <h2 className="text-center text-lg font-semibold text-foreground">Sync a board</h2>
      <p className="mt-1 text-center text-sm text-muted-foreground">
        Optional: bring sprints, issues and column prompts from the tools you already use.
      </p>
      <ul className="mt-4 space-y-1.5">
        {sources.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent"
              onClick={() => onImport(s)}
            >
              <ProviderMark provider={s.id} className="size-4" />
              <span className="flex-1 font-medium text-foreground">{importLabel(s)}</span>
              <span className="text-xs text-muted-foreground">
                {s.connected ? (s.account ?? "Connected") : "Connect first"}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="mt-3 w-full text-center text-xs text-muted-foreground underline" onClick={onManage}>
        Manage sources
      </button>
    </div>
  );
}
