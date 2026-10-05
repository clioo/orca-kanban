// Props-only contract mirrors of the admitted native Bot storage records for
// the exported-but-unmounted Bots panel. Shapes follow the serde camelCase JSON
// projections of `crates/drogon-core/src/bots/records.rs` and
// `crates/drogon-core/src/automations/records.rs` at the admitted state
// (docs/migration/native-bot-state-contract.md). This is the panel's own
// display contract, not a second authority for storage semantics; history
// joins are nullable because orphaned evidence is retained, never invented.

import type { Result } from "./session-contract";

export type BotScope = { hostId: string; workspaceId: string };
export type BotSnapshotInput = BotScope & { locale: string };

// R2-S additive types: create (persona/harness policy), a chat turn over
// bot.run (prompt in place of a responsibility invocation) and history.
// Native remains the only authority on preset/harness/text policy; these
// are transport shapes, mirroring `crates/drogon-core/src/bot_run_rpc.rs`
// and `crates/drogon-core/src/bot_mutation_rpc.rs`'s admitted wire shapes.

export type BotCreateInput = BotScope & {
  requestId: string;
  botId?: string | null;
  locale?: string | null;
  body: {
    characterPreset: string;
    displayIdentity: {
      displayName: string;
      handle: string | null;
      title: string | null;
    };
    harnessPolicy: { defaultHarness: string; explicitModel: string | null };
    instructions: string;
    memories: string[];
  };
};

export type BotRunHarnessOverrides = {
  harnessId: string;
  model?: string | null;
  effort?: string | null;
  provider?: string | null;
  permissionMode?: string | null;
};

/** Fresh harness source for a `bot.run` call, resolved from the bot's own
 *  stored policy at call time (R16-S): `explicitModel` is the single
 *  `provider/model` string the create form collects (the fork's shape),
 *  split into `provider`/`model` overrides where the call is built. */
export type BotRunHarnessSource = {
  harnessId: string;
  explicitModel: string | null;
};

/** A `bot.run` call is one of a responsibility invocation, a chat turn
 *  carrying its own `prompt` (headless by default, or visible in the
 *  harness TUI with `interactive: true`), or a promptless open-session
 *  dispatch. `requestId` is caller-chosen so a genuine same-params retry
 *  after an ambiguous transport failure reuses the same ledger key. */
export type BotRunTurnInput = BotScope & {
  requestId: string;
  botId: string;
  harness?: BotRunHarnessOverrides | null;
  locale?: string | null;
} & (
    | {
        responsibilityId: string;
        reason: "scheduledDue" | "manual" | "reactiveEvent";
        eventIdentity: string;
        prompt?: never;
        interactive?: never;
      }
    | {
        prompt: string;
        /** Show this daemon-dispatched turn in the Bot's normal TUI. */
        interactive?: true;
        resume?: never;
        responsibilityId?: never;
        reason?: never;
        eventIdentity?: never;
      }
    | {
        /** Open-session request (bug-bot-a836b4ebf8be65505, refined by the
         *  Carlos directive on task_e7c183ebc637): native runs the harness's
         *  own interactive entrypoint (no `-p`/`--print`) with NO prompt at
         *  all -- no model turn is dispatched, so the session opens live and
         *  IDLE, ready for the user's first real message. The model is never
         *  asked to confirm liveness or narrate the environment: those are
         *  daemon facts surfaced by the status pill and the Bot session
         *  inspector. A prompt alongside interactive is a separate visible
         *  chat-turn shape; this promptless shape never spends a turn.
         *
         *  `resume` (Defect 2): reopen the harness's own most recent
         *  conversation in the Bot's home (`--continue`, `codex resume
         *  --last`) instead of starting blank. Native only accepts it on
         *  this dispatch, and a harness that cannot resume is reported
         *  honestly by the caller rather than faked. */
        interactive: true;
        resume?: boolean;
        prompt?: never;
        responsibilityId?: never;
        reason?: never;
        eventIdentity?: never;
      }
  );

export type BotRunReceipt = {
  requestId: string;
  hostId: string;
  workspaceId: string;
  automationRunId: string | null;
  responsibilityRunId: string | null;
  messageId: string | null;
  session: { sessionId: string; incarnation: string } | null;
  outcome: "dispatched" | "refused" | "unsupported";
  refusal: unknown;
  reason: unknown;
  error: string | null;
  observedAt: number | null;
  recordedAt: number;
  /** Honest recovery notice (the adversarial report: a missing Bot home
   *  was a permanent dead end): set by the daemon when an open-session
   *  dispatch found the Bot's pinned home directory MISSING and recreated
   *  it -- the previous files in it are gone, and the UI must say so
   *  instead of silently pretending nothing was lost. Null otherwise. */
  homeNotice: string | null;
};

export type BotHistoryInput = BotScope & { botId: string; limit?: number };

/** One chat turn, as returned by `bot.history`. `sessionId`/`incarnation`
 *  let a conversation view read the actual reply via the existing
 *  `session.read` path; this never carries the reply text itself. */
export type BotMessage = {
  id: string;
  botId: string;
  requestId: string;
  prompt: string;
  sessionId: string | null;
  incarnation: string | null;
  hostObservation: BotsPanelHostObservation | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
};

export type BotHistoryResult = BotScope & {
  botId: string;
  messages: BotMessage[];
};

export interface BotBridge {
  botSnapshot(
    input: BotSnapshotInput,
  ): Promise<Result<BotScope & BotsPanelSnapshot>>;
  // Optional (rather than required, like botSnapshot above): additive so the
  // coordinator-owned preload/index.ts object literal (which this repo's
  // convention keeps satisfying `DesktopBridge` directly, unlike the `git`
  // namespace's separate untyped merge) never needs editing beyond the
  // granted runtime merge in preload/bot.ts.
  botCreate?(input: BotCreateInput): Promise<Result<BotsPanelBot>>;
  botRun?(input: BotRunTurnInput): Promise<Result<BotRunReceipt>>;
  botHistory?(input: BotHistoryInput): Promise<Result<BotHistoryResult>>;
  // R7-E: scheduled-responsibility create/delete. `requestId` is
  // caller-chosen so a same-params retry after an ambiguous transport
  // failure reuses the same ledger key, same as `botCreate`/`botRun`.
  // Results are lean ids; callers re-read the full Bot via `botSnapshot`.
  botResponsibilityCreate?(
    input: BotResponsibilityCreateInput,
  ): Promise<Result<BotResponsibilityCreateResult>>;
  botResponsibilityDelete?(
    input: BotResponsibilityDeleteInput,
  ): Promise<Result<BotResponsibilityDeleteResult>>;
  botDelete?(input: BotDeleteInput): Promise<Result<BotDeleteResult>>;
  /** Bots-page monitor read (this task): optional like every other
   *  additive method so older callers keep compiling. */
  botMonitorList?(input: BotMonitorListInput): Promise<Result<BotMonitorListResult>>;
  /** Bots-page parked-watch approval: arms the monitor's CURRENT rule
   *  text through the daemon's hash-bound `bot.monitor_approve` — the
   *  same approval the CLI sends, never a second path. */
  botMonitorApprove?(
    input: BotMonitorApproveInput,
  ): Promise<Result<BotMonitorApproveResult>>;
  /** Create one of the Bot's own file watches. OPTIONAL: a build whose
   *  preload predates the channel reports the watch surface as unavailable
   *  instead of throwing. */
  botMonitorCreate?(
    input: BotMonitorCreateInput,
  ): Promise<Result<BotMonitorCreateResult>>;
}

// R7-E additive types: a scheduled responsibility is an automation owned by
// the bot. `schedule` is the 5-field UTC cron the daemon scheduler fires;
// `prompt` becomes both the automation prompt and the responsibility
// instructions. Transport shapes only; native owns validation.
export type BotResponsibilityCreateInput = BotScope & {
  requestId: string;
  botId: string;
  name: string;
  schedule: string;
  prompt: string;
  /** Carried for scope-triple uniformity with botSnapshot/botRun; the
   *  bridge strips it before the native call (native has no use for it). */
  locale?: string | null;
};

export type BotResponsibilityCreateResult = BotScope & {
  botId: string;
  responsibilityId: string;
  automationId: string;
};

export type BotResponsibilityDeleteInput = BotScope & {
  requestId: string;
  botId: string;
  responsibilityId: string;
  /** Carried for scope-triple uniformity with botSnapshot/botRun; the
   *  bridge strips it before the native call (native has no use for it). */
  locale?: string | null;
};

export type BotResponsibilityDeleteResult = BotScope & {
  botId: string;
  responsibilityId: string;
  removed: boolean;
  automationId: string | null;
};

// R9-C additive types: bot-level delete removes the bot, its
// responsibilities and their still-Bot-owned automations atomically;
// responsibility-run and chat-message rows stay as orphaned evidence.
// Transport shapes only; native owns validation. Results are lean ids;
// callers re-read the full list via `botSnapshot`.
export type BotDeleteInput = BotScope & {
  requestId: string;
  botId: string;
  /** Carried for scope-triple uniformity with botSnapshot/botRun; the
   *  bridge strips it before the native call (native has no use for it). */
  locale?: string | null;
};

export type BotDeleteResult = BotScope & {
  botId: string;
  removed: boolean;
  automationIds: string[];
};

// Bots-page monitor read (`bot.monitor_list`): the REAL durable state
// behind the MONITORS column — daemon-computed health, the durable check
// evidence (last check time/outcome, incident count) and the real failure
// threshold constant. One wire view per monitor; rule-kind summary fields
// (resource/maxBytes/scriptPath/…) are flattened in by native and stay
// open-ended here so an unknown kind stays visible instead of hidden.
export type BotMonitorHealth =
  | "healthy"
  | "degraded"
  | "failing"
  | "needs_approval"
  | "disabled"
  | "unsupported";

export type BotMonitorView = {
  monitorId: string;
  version: number;
  ruleKind: string;
  projectId: string;
  enabled: boolean;
  approved: boolean;
  responsibilityId: string | null;
  cursor: string | null;
  lastEventId: string | null;
  health: BotMonitorHealth;
  trigger: { kind: "manual" } | { kind: "scheduled"; cron: string };
  consecutiveErrors: number;
  lastError: string | null;
  /** An informational note about the newest committed check — the
   *  baseline seed, for example. NOT an error: the daemon stores the
   *  first-observation note here so no consumer paints it red. */
  lastNotice: string | null;
  failureThreshold: number;
  lastCheckAtMs: number | null;
  lastCheckOutcome: "no_change" | "changed" | "error" | null;
  incidentCount: number;
  delegationsToday: { used: number; max: number };
  /** The monitor's own firing history: what its last change event did
   *  through the delegation chain (null = never released an action). */
  firing: BotMonitorFiringView | null;
  /** Rule-kind summary fields (resource, maxBytes, scriptPath, repo,
   *  filter, login, urlHash, …) — display-only, keyed by what native's
   *  `summary_json` flattened in. */
  [summaryField: string]: unknown;
};

/** The delegation verdicts this build knows how to label. It must stay
 *  in lockstep with the daemon's own producing set
 *  (`FIRING_OUTCOMES` in `crates/drogon-core/src/bots/delegation.rs`).
 *
 *  `dispatch_failed` is here because leaving it out broke the whole
 *  Monitors column: the daemon has always been able to write it (a
 *  refused `harness.start`), the monitor read was validated against this
 *  union, and one such firing made `bot.monitor_list` fail for that bot —
 *  which the page then reported as "the daemon bridge does not expose the
 *  monitor read". `lastOutcome` is deliberately widened to `string` below
 *  so a FUTURE verdict degrades to one unlabelled cell instead of erasing
 *  every monitor the bot has. */
export const BOT_MONITOR_FIRING_OUTCOMES = [
  "dispatched",
  "dispatch_failed",
  "joined_existing",
  "refused",
  "orphaned",
  "cap_exceeded",
  "stale_skipped",
] as const;

export type BotMonitorFiringOutcome =
  (typeof BOT_MONITOR_FIRING_OUTCOMES)[number];

/** One settled delegation verdict for a monitor: dispatched = the bound
 *  responsibility ran (runId names the run row, also visible in the
 *  bot's history as a "Monitor event"); the other outcomes are honest
 *  refusals with their reason. Metadata only, never watched bytes. */
export type BotMonitorFiringView = {
  lastEventId: string;
  /** A known verdict, or an unrecognized token from a newer daemon —
   *  shown as itself rather than dropped. */
  lastOutcome: BotMonitorFiringOutcome | (string & {});
  lastRunId: string | null;
  lastDetail: string | null;
  /** The released case's own resource (`pull/42` for a pull-request
   *  watch, the watched path for a file watch) — WHAT the firing
   *  released. Null on evidence rows written before the daemon's
   *  delegation schema version 3. */
  lastResource: string | null;
  lastAtMs: number;
  countToday: number;
};

export type BotMonitorListInput = BotScope & { botId: string };

export type BotMonitorListResult = {
  hostId: string;
  /** The RESOLVED owning workspace id — an app-global "" request is
   *  resolved daemon-side, so this is never the "" sentinel. */
  workspaceId: string;
  botId: string;
  monitors: BotMonitorView[];
};

// Parked-watch approval (the product path a `bot watch-pr` monitor
// needs): arms the monitor's CURRENT rule text — the daemon re-derives
// the approval hash from the stored rule, so this approves exactly what
// the parked card disclosed, nothing else. Result is lean; callers
// re-read the full monitor via `botMonitorList`.
export type BotMonitorApproveInput = BotScope & {
  botId: string;
  monitorId: string;
};

// A Bot's own file watch: the daemon digests `resource` inside the Bot's
// owning workspace on the `cron` cadence, and a change releases the reactive
// responsibility `responsibilityName` mints. Created unapproved on purpose —
// the caller approves the exact rule hash through `botMonitorApprove`, the
// same single consent point the CLI uses.
export type BotMonitorCreateInput = BotScope & {
  botId: string;
  /** Workspace-relative path, e.g. `specs/dog-tinder.md`. */
  resource: string;
  /** 5-field UTC cron; the daemon defaults to every minute. */
  cron?: string;
  responsibilityName?: string;
  instructions?: string;
};

export type BotMonitorCreateResult = {
  monitorId: string;
  botId: string;
  ruleKind: string;
  approvalHash: string;
  approved: boolean;
  trigger?: unknown;
  responsibilityId?: string | null;
};

export type BotMonitorApproveResult = BotScope & {
  botId: string;
  monitorId: string;
  approved: boolean;
  approvalHash: string;
};

export type BotsPanelHostObservation = "live" | "unverifiable" | "exited";

/** A Bot's recorded session that the HOST has confirmed live right now.
 *  Returned by `BotsPanelProps.resolveBotSession`: the daemon verdict —
 *  never a hook-derived guess — already said the session is not exited, so
 *  "Open session" must FOCUS this real session instead of spawning a
 *  second one. `harnessId` is the session's own admitted harness (the
 *  live `Session` projection), which can differ from the Bot's current
 *  stored policy if the policy changed after the session opened. */
export type BotLiveSession = {
  sessionId: string;
  incarnation: string;
  workspaceId: string;
  hostId: string;
  harnessId: string | null;
};

/** What the host knows about a Bot's recorded session at the moment the user
 *  clicks Open (Defect 1). The old `null`-means-"open fresh" contract
 *  conflated "no recorded session" with "recorded but its liveness is not
 *  known yet", so the first click after launch silently opened a SECOND
 *  session. This union keeps the three cases apart:
 *
 *  - `focus`: the recorded session is live (or unverifiable-but-present);
 *    focus it and dispatch NOTHING.
 *  - `reopen`: the recorded session is known to have exited; open a new
 *    session with the harness's resume mechanism so the conversation
 *    continues.
 *  - `open`: there is no recorded session at all; a fresh session is the
 *    correct, honest behavior. The variant may carry a `notice`: the
 *    recorded link was a PHANTOM (`recordedSessionMissing`) -- the daemon
 *    positively holds no live child and no durable row for it -- so the
 *    fresh session is safe and the notice says the previous session is
 *    gone instead of refusing with advice that can never work.
 *  - `unknown`: a recorded session exists but its liveness cannot be
 *    established (daemon build without the projection). NEVER dispatch a
 *    new session here -- that is the duplicate-creating bug; the caller
 *    refuses honestly and names a control that actually works. */
export type BotSessionResolution =
  | { kind: "focus"; session: BotLiveSession }
  | {
      kind: "reopen";
      sessionId: string;
      harnessId: string | null;
      /**
       * Whether the reopen can name the harness's own prior conversation: the
       * Drogon session id to hand to `resumeSessionId` (`"session"`, the
       * recorded row — the daemon reads the provider id off it), or
       * `"bot-record"` (the record's latched locator, for a row that no longer
       * exists). `null` = no identity to resume by, so the reopen is a
       * continue/fresh launch and the caller must not claim a restore.
       */
      resumeByIdentity?: "session" | "bot-record" | null;
    }
  | {
      kind: "open";
      /** Set when the recorded link is a PHANTOM the daemon positively
       *  cannot resolve (it reports `recordedSessionMissing`: no live
       *  child and no durable session row). The open is fresh and safe --
       *  there is no live Drogon session to duplicate -- and the notice
       *  says what happened instead of refusing with advice that can
       *  never work. Absent for a plain first open. */
      notice?: string;
    }
  | {
      /** Recorded but liveness not established by a daemon that COULD have
       *  established it is refused: an old daemon build (no projection at
       *  all) may still hold a live session this renderer cannot see, so
       *  opening a second one could duplicate it. The refusal must name a
       *  control that actually works (the card's "New session" button),
       *  never a refresh that cannot change the answer. */
      kind: "unknown";
    };

export type BotsPanelTrigger =
  | { kind: "reactive"; event: string | null }
  | { kind: "scheduled"; automationId: string };

export type BotsPanelResponsibilityKind = "reactive" | "scheduled";

export type BotsPanelRecipeLink = {
  recipeRef: string;
  runId: string | null;
  evidencePath: string | null;
};

export type BotsPanelResponsibility = {
  id: string;
  name: string;
  instructions: string;
  kind: BotsPanelResponsibilityKind;
  trigger: BotsPanelTrigger;
  enabled: boolean;
  recipe: BotsPanelRecipeLink | null;
  createdAt: number;
  updatedAt: number;
};

export type BotsPanelSession = {
  /** A daemon-run session is inspectable, never automatically resumed:
   *  a monitor's firing (`monitor`) or a `bot.run` chat turn (`chat`). */
  source?: "monitor" | "chat";
  sessionId: string;
  harness: string;
  model: string | null;
  startedAt: number;
  rotatedAt: number | null;
  /** Live OS pid of the session's PTY child, projected onto the snapshot
   *  from the daemon's own in-memory session registry (never persisted --
   *  a pid is only ever meaningful for a currently-live process). `null`
   *  when the session is no longer live/tracked by this service instance;
   *  absent on a daemon build that predates this projection. */
  processId?: number | null;
  /** Daemon-owned liveness facts for the recorded link (Defect 1/2): the
   *  workspace the session runs in, the incarnation needed to focus it, and
   *  the host's own verdict. Optional so an older daemon build still
   *  validates; absent means the caller must treat the liveness as UNKNOWN
   *  and must never dispatch a duplicate. */
  workspaceId?: string;
  incarnation?: string;
  verdict?: "live" | "unverifiable" | "exited";
  /** The daemon positively resolved the recorded link and found NOTHING:
   *  no live child in its registry and no durable session row. The link is
   *  a phantom (the tab was closed, or any wiped state), a refresh can
   *  never change this (the lookup already ran), and there is no live
   *  Drogon session a second open could duplicate. Absent = the daemon
   *  build predates this projection, so liveness stays genuinely unknown
   *  and the conservative refusal stands. */
  recordedSessionMissing?: boolean;
  /** The provider-native conversation this Bot session is, as the harness
   *  itself reported it (Claude/Codex `session_id`, ...), latched onto the
   *  record when the daemon learned it. This is what a reopen names, and it
   *  is the reason an unobserved record is resumable instead of a permanent
   *  dead end: the Drogon session row is deleted by an explicit close, but
   *  this latched locator survives. `null`/absent when the harness reported
   *  none (or on an older daemon build). */
  agentSessionId?: string | null;
  /** The transcript/rollout file that id names (`transcript_path`, Pi's
   *  `session_file`) — some CLIs resume by file rather than by id. */
  agentSessionTranscriptPath?: string | null;
};

export type BotsPanelBot = {
  id: string;
  characterPreset: string;
  displayIdentity: {
    displayName: string;
    handle: string | null;
    title: string | null;
  };
  harnessPolicy: { defaultHarness: string; explicitModel: string | null };
  instructions: string;
  memories: string[];
  responsibilities: BotsPanelResponsibility[];
  /** Provisioned home (daemon-projected `bot_homes` row): the real
   *  dedicated folder. `null` until first provision; `undefined` on
   *  snapshots from daemon builds predating the projection. */
  home?: { handle: string; path: string; homeWorkspaceId: string } | null;
  currentSession: BotsPanelSession | null;
  createdAt: number;
  updatedAt: number;
};

export type BotsPanelHistoryEntry = {
  run: {
    id: string;
    botId: string;
    responsibilityId: string;
    automationId: string | null;
    automationRunId: string | null;
    startedAt: number;
    endedAt: number | null;
    recipe: BotsPanelRecipeLink | null;
    hostObservation: BotsPanelHostObservation | null;
    /** How the run was invoked. `null` for rows written before native
     *  stamped it: every such row came through `bot.run`, so readers
     *  treat `null` as manual. `reactive` marks a run released by a
     *  monitor event through the delegation drain. */
    invocation: "scheduled" | "manual" | "reactive" | null;
  };
  responsibilityName: string | null;
  automationName: string | null;
  automationRunNumber: number | null;
  /** The linked automation run's status verdict (snake_case, e.g.
   *  "completed") — the fork's snapshot carries the full
   *  `automationRun` row and its history row renders `status · id`;
   *  `null` only for rows whose join predates the projection. */
  automationRunStatus: string | null;
};

export type BotsPanelSnapshot = {
  bots: BotsPanelBot[];
  history: BotsPanelHistoryEntry[];
};

/** Minimal structural shape of `session.read`'s result the conversation view
 *  needs (verdict + agent state + raw bytes): a subset of
 *  `shared/session-contract.ts`'s `ReadResult`, redeclared here rather than
 *  imported to avoid a circular import (`session-contract.ts` already
 *  imports `BotBridge` from this file). A real `ReadResult` is structurally
 *  assignable to this. */
export type BotSessionReadResult = {
  session: {
    verdict: BotsPanelHostObservation;
    agentState?: string;
  };
  dataBase64: string;
  startCursor: number;
  nextCursor: number;
  truncated: boolean;
};

export type BotSessionReader = (input: {
  sessionId: string;
  incarnation: string;
  cursor: number;
}) => Promise<Result<BotSessionReadResult>>;

export type BotsPanelProps = {
  snapshot: BotsPanelSnapshot;
  /** R7-E: closes the page (the fork's header Back button). Rendered only
   *  when supplied, so callers without a close affordance keep the exact
   *  pre-R7-E header. */
  onClose?: () => void;
  onRunResponsibility?: (input: {
    botId: string;
    responsibilityId: string;
    /** Fresh harness source from the panel's live snapshot (R16-S): the
     *  mount must prefer this over its registration-time snapshot, which
     *  predates in-panel mutations. Optional so older callers keep
     *  compiling; absent means the mount falls back to its own lookup. */
    harness?: BotRunHarnessSource;
  }) => void | Promise<void>;
  /** Host-owned in-app presentation for an opened Bot session
   *  (Carlos directive on task_0436fdf3aa91): the panel calls this after a
   *  dispatched open-session turn with the REAL session native returned,
   *  so the host can open/focus the canonical Bot-linked tab in-app
   *  (in-app focus only, never OS activation). Optional like
   *  onRunResponsibility; absent means the session stays daemon-side
   *  (visible in the session list) with no host presentation. */
  onOpenSession?: (input: {
    botId: string;
    sessionId: string;
    incarnation: string;
    harness: BotRunHarnessSource;
    /** Owning workspace native resolved the turn into (receipt echo): now
     *  the Bot's OWN provisioned home workspace for an interactive open
     *  (bug-bot-a836b4ebf8be65505), never the folder its record happens to
     *  be stored under. The host selects it before focusing the tab. */
    workspaceId: string;
    hostId: string;
    /** Bot identity echoed from the panel's own live snapshot (the same
     *  `live.displayIdentity` the dispatch itself used), so the host can
     *  render bot-scoped chrome (breadcrumb, tab title, the Bot session
     *  inspector) without a second round trip. Never invented: these are
     *  the exact fields the dispatched turn read off the Bot record. */
    displayName: string;
    handle: string | null;
    title: string | null;
  }) => void | Promise<void>;
  /** Host-owned liveness lookup for the DEFAULT "Open session" click (Gap 2):
   *  given the Bot the panel is showing, return its recorded session ONLY
   *  when the host has positively observed it is not exited, else null.
   *  The controller then focuses that session through `onOpenSession`
   *  instead of dispatching a duplicate. Absent/returning null means
   *  "no resumable session", so the click dispatches a fresh one — the
   *  path used when the recorded session genuinely exited or never
   *  existed. */
  resolveBotSession?: (input: { bot: BotsPanelBot }) => BotSessionResolution;
  /** Caller-observed liveness verdicts (live | unverifiable | exited), one per
   *  bot, from a real observation source. The panel renders them verbatim and
   *  never derives a verdict from the persisted record: a stored session is a
   *  link, not proof of a live process. Bots without an entry render no
   *  liveness claim at all. */
  observedLivenessByBotId?: Record<string, BotsPanelHostObservation>;
  /** R2-S additions, all optional so every existing caller/test that never
   *  supplied them keeps compiling and keeps rendering the pre-R2-S
   *  read-only view. */
  /** The gated bridge itself: create/chat/history need their own request
   *  lifecycle (busy/error/local refresh) that a single fire-and-forget
   *  callback cannot express. */
  bridge?: BotBridge;
  /** Scope needed to call bridge methods; `snapshot` itself carries none. */
  scope?: BotScope & { locale: string };
  /** Reads a chat turn's actual reply bytes via the existing `session.read`
   *  path, keyed by the turn's stored `sessionId`/`incarnation`. Never
   *  wrapped by `bridge` (session reads have their own liveness/authorization
   *  model, distinct from the bot.snapshot.v1 capability gate). */
  sessionReader?: BotSessionReader;
};
