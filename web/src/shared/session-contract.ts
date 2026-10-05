import type { FileBridge } from "./file-contract";
import type { BotBridge } from "./bot-contract";

export type Verdict = "live" | "unverifiable" | "exited";
export type Workspace = {
  id: string;
  path: string;
  name: string;
  kind: "folder" | "git";
  hostId: string;
};
/** A git repository or a plain folder that owns Worktrees (journey J1). */
export type Project = {
  id: string;
  hostId: string;
  path: string;
  name: string;
  kind: "git" | "folder";
  defaultBaseRef: string | null;
  /** Project Settings → Setup script; absent on older daemon payloads. */
  setupScript?: string | null;
  /** Daemon-owned Quick Session scratch project marker. */
  quickSession?: boolean;
};
/**
 * A git worktree (or, for a folder Project, the implicit single worktree
 * that is the folder itself) that a Session attaches to as a Workspace.
 */
export type Worktree = {
  id: string;
  projectId: string;
  workspaceId: string;
  path: string;
  branch: string;
  head: string;
  baseRef: string | null;
  /**
   * Display title set by `worktree.rename` (Orca's inline rename renames
   * the card title only — never the branch, never the directory).
   * Nullish when never renamed; optional here only so this additive field
   * never breaks an existing renderer `Worktree` literal that predates it.
   */
  title?: string | null;
  /** Composer Advanced → Note. */
  note?: string | null;
  /** Composer Advanced → Parent worktree nesting edge. */
  parentWorktreeId?: string | null;
  createdAt: string;
  /**
   * Workspace Options metadata (Group by/Sort by/Pin/Archive/PR-link);
   * see `crates/drogon-protocol/src/worktree.rs`'s `Worktree` for the wire
   * contract each of these mirrors.
   */
  workspaceStatus?: string | null;
  isPinned?: boolean;
  isArchived?: boolean;
  sortOrder?: number;
  manualOrder?: number | null;
  lastActivityAt?: string | null;
  linkedPr?: number | null;
  creator?: "cli" | "automation" | null;
};
export type AgentState =
  "working" | "idle" | "needs_input" | "exited" | "unknown";
export type Session = {
  id: string;
  workspaceId: string;
  hostId: string;
  incarnation: string;
  command: string;
  args: string[];
  /** A listed harness session's long argv elements were cut (the record is
   *  whole; a harness session relaunches through harness.start). */
  argsTruncated?: boolean;
  cols: number;
  rows: number;
  /**
   * Additive (#605): the ring cursor at which `cols`x`rows` took effect.
   * A terminal emulator fed from the ring must change its own grid at this
   * exact byte — anywhere else and it re-wraps the frame the agent is in the
   * middle of drawing, the agent's cursor-relative erase lands on the wrong
   * rows, and the superseded frame is stranded on screen. Absent on a daemon
   * predating the field; absent reads as 0 ("always been this grid").
   */
  gridCursor?: number;
  verdict: Verdict;
  exitCode: number | null;
  createdAt: string;
  /**
   * Always present on the wire (`session.list`/`session.read`/CLI output);
   * optional here only so this additive field never breaks an existing
   * renderer `Session` literal that predates it.
   */
  agentState?: AgentState;
  agentStateAt?: string | null;
  /**
   * Turn proof behind `agentState` (activity authority, additive): `hook`
   * means the harness's own hook lifecycle reported the turn (an open turn
   * behind `working`, a turn-end behind `idle`, a hook wait behind
   * `needs_input`) — the only thing that proves a turn. `activity` means
   * the `idle` derives only from the PTY clock going quiet. Absent/null
   * means no proof is claimed (`unknown`, `exited`, or a daemon predating
   * the field) and must never render as `working`/`idle`. Optional so an
   * older daemon's rows still validate; older clients ignore it.
   */
  agentStateAuthority?: "hook" | "activity" | null;
  /** Bounded first-known prompt preview, in memory only; used for stable tab names. */
  agentPromptPreview?: string | null;
  /** Claude Stop hook timestamp; never inferred from loss of contact. */
  cacheIdleAt?: string | null;
  /**
   * Additive (R12-E terminal restart): which harness launched this session
   * (`harness.start`), so the exit overlay's Restart can re-launch the same
   * harness. `null`/absent for plain `session.start` shells, whose restart
   * re-uses `command`/`args` verbatim instead.
   */
  harnessId?: HarnessId | null;
  /**
   * Additive (#359, subagent nesting): the session whose PTY spawned this
   * one (a `drogon-cli` invoked inside a terminal reports its inherited
   * `DROGON_SESSION_ID` — the fork's env-inheritance lineage). The sidebar
   * nests the row under the parent session's row when both attach to the
   * same worktree, like the fork's `orchestration.parentPaneKey` tree.
   * `null`/absent for parentless (UI-spawned) sessions; a parent outside
   * the row set renders flat (the fork's unreachable-row normalization).
   */
  parentSessionId?: string | null;
  /**
   * Delegation attribution: the monitor event (`mev_…`) that caused this
   * session, recorded by the daemon on both hops of a delegated run (the
   * Bot's own headless run and the review session it dispatched). The
   * daemon shape-checks it, so a non-null value is always a real event id;
   * `null`/absent means nobody delegated this session. This is what lets
   * Session details answer "why did this session appear?" with the event
   * the user can find in the monitor's firing history.
   */
  causedByEventId?: string | null;
  /**
   * Additive (session resume by identity): the provider-native conversation
   * this session is, as the harness ITSELF reported it through
   * `session.hook_event` (Claude/Codex `session_id`, OpenCode's session id,
   * Antigravity's `conversation_id`). A reopen passes it back so the CLI opens
   * THAT conversation (`claude --resume <id>`) instead of the most recent one
   * in the directory. `null`/absent when the harness never reported one — a
   * plain shell, or a harness with no identity surface.
   */
  agentSessionId?: string | null;
  /**
   * Additive: the transcript/rollout file that id names (`transcript_path`,
   * Pi's `session_file`). Some CLIs resume by file rather than by id, so a
   * reopen needs both when the harness reported both.
   */
  agentSessionTranscriptPath?: string | null;
  /**
   * Additive, `harness.start` replies only: how the resume request actually
   * landed. `resumed` = the launch named the recorded provider conversation
   * and the daemon VERIFIED it (its persisted transcript exists);
   * `continued` = no recorded identity, so the CLI's own most-recent
   * entrypoint was used; `fresh` = the daemon declined to resume (nothing to
   * resume) and started a NEW conversation; `resume-unverified` = an id-only
   * locator the daemon could not verify before launch -- the harness's own
   * output is the only honest confirmation, so the pane withholds the
   * restored banner. Absent on `session.list` rows (a list read is not a
   * launch) — and `fresh` must never be presented as a restore.
   */
  agentResume?: "resumed" | "continued" | "fresh" | "resume-unverified";
  /**
   * Additive (issue #333): true while the session leader has a live child
   * process (a running foreground job). Reported on live rows only; absent
   * on older daemon payloads reads as idle.
   */
  hasForegroundChild?: boolean;
  /**
   * Additive (issue #622): the harness id the daemon observed in the
   * session PTY's foreground process group, with its RFC 3339 stamp. An
   * observation, never an inference, never persisted, and never authority
   * for hooks, restart, or `agentState`. Null/absent unless a harness-less
   * live session currently foregrounds a catalog harness.
   */
  observedHarnessId?: HarnessId | null;
  /**
   * Additive (issue #622): RFC 3339 stamp of the `observedHarnessId`
   * observation. An observation, never an inference, never persisted, and
   * never authority. Null/absent when no harness is observed.
   */
  observedHarnessAt?: string | null;
};
/**
 * Install-resilience P4/P5 (additive, both optional so an older daemon's
 * reply — which carries neither — still validates): `featureProtocol` is
 * the daemon's monotonic wire-behavior floor
 * (crates/drogon-protocol/src/feature_protocol.rs), and
 * `daemonArtifactSha256` is the sha256 of the answering process's own
 * binary, letting a freshly-installed desktop detect a changed `drogond`
 * behind a still-running detached process. Absent/null = identity unknown;
 * callers must treat that as "cannot verify", never as a match.
 */
export type Status = {
  hostId: string;
  serviceInstanceId: string;
  protocol: 1;
  capabilities: string[];
  version: string;
  featureProtocol?: number;
  daemonArtifactSha256?: string | null;
  /** Last completed automation scheduler tick; null before the first tick. */
  schedulerLastTickMs?: number | null;
};
export type Identity = { sessionId: string; incarnation: string };
export type HarnessId = "claude" | "pi" | "opencode" | "antigravity" | "codex";
export type HarnessAvailability =
  "available" | "missing" | "unsupported_launcher";
export type PermissionMode = "inherit" | "unattended";
export type Harness = {
  harnessId: HarnessId;
  displayName: string;
  availability: HarnessAvailability;
  executable: string | null;
};
/** One host-enumerated model, verbatim as the harness's own surface
 *  reported it (capability facts stay raw strings, never interpreted). */
export type HarnessModelEntry = {
  provider: string | null;
  id: string;
  context: string | null;
  maxOutput: string | null;
  thinking: boolean | null;
  images: boolean | null;
};
/** How the catalog was produced — source, version, and probe scope the UI
 *  renders instead of an unearned "confirmed". */
export type HarnessModelsProvenance = {
  executable: string;
  argv: string[];
  version: string | null;
  /** Wall-clock epoch ms of the probe; the UI derives honest age. */
  probedAtEpochMs: number;
  configScope: string;
};
/** How the enumeration attempt ended. Each variant renders distinctly;
 *  none of them invents model rows. */
export type HarnessModelsStatus =
  | "enumerated"
  | "not_installed"
  | "unsupported_surface"
  | "unsupported_platform"
  | "parse_failed"
  | "timed_out"
  | "probe_failed"
  | "isolation_failed";
/** One harness's host-scoped model catalog as probed by the daemon
 *  (`harness.models`). C01 honesty contract: installed vs discovered vs
 *  unavailable vs unknown is carried explicitly, with source, version and
 *  freshness — never a bare confident list. */
export type HarnessModelsCatalog = {
  harness: HarnessId;
  availability: HarnessAvailability;
  executable: string | null;
  provenance: HarnessModelsProvenance | null;
  entries: HarnessModelEntry[];
  status: HarnessModelsStatus;
  note: string | null;
  /** Probe isolation roots retained on disk (unverifiable cleanup);
 *  normally empty, non-empty is disclosed evidence. */
  retainedRoots: string[];
};
export type HarnessLaunchInput = {
  workspaceId: string;
  harnessId: HarnessId;
  model?: string;
  provider?: string;
  effort?: string;
  prompt?: string;
  permissionMode: PermissionMode;
  requestId: string;
  /**
   * Additive (resume): reopen the harness's own prior conversation instead of
   * starting blank. The daemon reports how it landed in the reply's
   * `agentResume`, so the pane can say "started fresh" instead of implying a
   * continuation.
   */
  resume?: boolean;
  /**
   * Additive (resume by identity): the Drogon session whose recorded provider
   * conversation should be reopened. The daemon reads the provider id off THAT
   * row (written by the harness's own hook payload), so the renderer never has
   * to carry or reconstruct it — one source of truth, and it works for a row
   * this daemon instance holds no child for (a post-restart `unverifiable`
   * stub) exactly as for a live one.
   */
  resumeSessionId?: string;
};
/**
 * Additive (R12-E terminal restart): explicit launch argv for
 * `start`, letting a restart re-launch the exact prior session command
 * instead of the default shell.
 */
export type SessionLaunchReuse = {
  command?: string;
  args?: string[];
  /**
   * Additive (R16-BC, #275): explicit spawn directory for the new session
   * (the explorer's "Open in Terminal" passes the row directory). The
   * daemon honours it only inside the workspace root.
   */
  cwd?: string;
};
export type ReadResult = {
  session: Session;
  dataBase64: string;
  startCursor: number;
  nextCursor: number;
  truncated: boolean;
  /**
   * Additive (#605): the grid in force at this page's first byte, then every
   * change inside the page, in order. A terminal emulator fed from the ring
   * switches grid at each one — two resizes can land in the same page, and
   * collapsing them to the newest parses the bytes composed at the middle
   * grid at the wrong width. Absent on a daemon predating the field, which
   * the reader degrades to the session's single `gridCursor`.
   */
  gridChanges?: { cursor: number; cols: number; rows: number }[];
};
export type Result<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean } };
export interface DesktopBridge extends FileBridge, BotBridge {
  status(): Promise<Result<Status>>;
  workspaces(): Promise<Result<{ workspaces: Workspace[] }>>;
  addWorkspace(path: string): Promise<Result<Workspace>>;
  chooseFolder(): Promise<string | null>;
  /** Omitting `workspaceId` returns every session on this host (Bot-session
   *  persistence: the sidebar's Chats section and the resume check need to
   *  see a Bot's session regardless of the currently selected workspace). */
  sessions(workspaceId?: string): Promise<Result<{ sessions: Session[] }>>;
  /**
   * `launch` is additive (R12-E restart reuse): pass the prior session's
   * recorded argv to re-launch it, or omit for the default shell.
   */
  start(
    workspaceId: string,
    launch?: SessionLaunchReuse,
  ): Promise<Result<Session>>;
  harnesses(): Promise<Result<{ hostId: string; harnesses: Harness[] }>>;
  /** Live per-harness model catalog (`harness.models`), probed by the
   *  daemon from the harness's own enumeration command under
   *  credential-free isolation. Never model inference. */
  harnessModels(input: {
    harnessId: HarnessId;
  }): Promise<Result<{ hostId: string; catalog: HarnessModelsCatalog }>>;
  startHarness(input: HarnessLaunchInput): Promise<Result<Session>>;
  read(input: Identity & { cursor: number }): Promise<Result<ReadResult>>;
  /**
   * PERF-01 push channel (`session.output` long-poll, additive): same
   * identity/cursor in, same `ReadResult` shape out — the call holds until
   * bytes exist, the child exits, or `waitMs` expires. Optional (like every
   * additive bridge member) so a test double or older preload that only
   * implements `read` still satisfies the type; the pane treats a missing
   * implementation as capability-absent and keeps the `read` poll.
   */
  readOutput?(input: Identity & { cursor: number; waitMs?: number }): Promise<
    Result<ReadResult>
  >;
  write(
    input: Identity & { text: string },
  ): Promise<Result<{ acceptedBytes: number }>>;
  resize(
    input: Identity & { cols: number; rows: number },
  ): Promise<Result<Session>>;
  stop(input: Identity): Promise<Result<Session>>;
  /**
   * Additive (R16-AL2, issue #228): the user-initiated close. Stops a live
   * PTY when this service instance owns it and forgets the durable record,
   * so exited rows AND post-restart `unverifiable` stubs alike release
   * their tab (a stub can never be resolved to `exited` — loss of contact
   * is not exit — so an explicit close is the honest dismissal). The
   * returned verdict is observed truth only: a forgotten stub still reads
   * `unverifiable`.
   */
  close(input: Identity): Promise<Result<Session>>;
  /**
   * Additive (R16-AL2, issue #228): forgets a record this service
   * instance holds no live handle for (a stub or an exited row). Refuses
   * a live session — `close` is the route that stops first.
   */
  forget(input: Identity): Promise<Result<Session>>;
  /** Non-secret packaged build identity (or `null` in development, or a build without it); never a token or path. */
  buildInfo(): Promise<{
    revision: string;
    builtAt: string;
    version: string;
  } | null>;
}
declare global {
  interface Window {
    drogon: DesktopBridge;
  }
}
