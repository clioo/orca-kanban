// The Work board contract (`work.*`, capability work.v1): Drogon tickets on
// configurable columns, each column able to type a prompt into the sessions
// linked to its tickets (on enter, on a schedule, when the ticket's PR
// changes, or on demand). The daemon owns the data; this module is the
// renderer/main view of it and the zod shapes both sides validate.
import { z } from "zod";
import type { Result } from "./session-contract";

export const WORK_CAPABILITY = "work.v1";
/** Boards imported from a ticket provider (Jira first): import, sync, push,
 *  sprints. A daemon without it serves My work only. */
export const WORK_BOARDS_CAPABILITY = "work.boards.v1";
/** Linear and GitHub beside Jira, which sources are allowed, and how each
 *  connects (`work.sources`, `work.source_*`). */
export const WORK_SOURCES_CAPABILITY = "work.sources.v1";
/** The board id `work.board` uses for the local board. */
export const WORK_LOCAL_BOARD = "local";

export const WORK_COLUMN_ICONS = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "qa",
  "done",
  "blocked",
] as const;
export type WorkColumnIcon = (typeof WORK_COLUMN_ICONS)[number];

export const WORK_HARNESSES = ["claude", "codex", "opencode", "pi", "antigravity"] as const;

export type WorkRecipients = "all" | "primary";

export type WorkColumn = {
  id: string;
  name: string;
  icon: string;
  position: number;
  sendOnEnter: boolean;
  cron: string | null;
  prWatch: boolean;
  message: string;
  recipients: WorkRecipients;
  harnessId: string | null;
  nextRunAt: number | null;
  ticketCount: number;
  lastSentAt: number | null;
  lastSentCount: number;
  /** Imported boards: the board it belongs to (null on My work). */
  boardId?: string | null;
  /** Provider statuses this column stands for (empty: Drogon-only). */
  statuses?: WorkBoardStatus[];
  /** Shown as a narrow strip; still a drop target. */
  collapsed?: boolean;
};

export type WorkBoardStatus = { id: string; name: string; category: string };

export type WorkSprint = {
  id: string;
  name: string;
  state: "active" | "closed" | "future" | string;
  start: string | null;
  end: string | null;
};

/** One entry of a ticket's sprint timeline. */
export type WorkSprintStep = WorkSprint & { status: string | null; outcome: string };

export type WorkActivity = { id: number; kind: string; text: string; at: number };

/** Where an imported ticket stands against its provider. */
export type WorkSyncState = "local" | "synced" | "pending" | "conflict" | "error" | "unmapped" | "removed";

/** A board in the picker: My work (`id: "local"`) or an imported one. */
export type WorkBoardSummary = {
  id: string;
  provider: string | null;
  name: string;
  kind: "local" | "scrum" | "kanban" | string;
  siteUrl?: string;
  externalId?: string;
  projectKey?: string | null;
  projectName?: string | null;
  projectId?: string | null;
  statuses: WorkBoardStatus[];
  lastSyncedAt?: number | null;
  lastSyncError?: string | null;
  pendingCount: number;
  ticketCount: number;
  /** Sync imports new issues assigned to the connected account. */
  autoImportMine?: boolean;
};

export type WorkSprintOutcome = {
  completed: string[];
  carried: { ticketId: string; toSprintId: string; toSprintName: string | null; pending: boolean }[];
  backlog: { ticketId: string; pending: boolean }[];
};

/** What the board shows: everything, one sprint, or the backlog. */
export type WorkView = {
  kind: "all" | "sprint" | "backlog";
  sprint?: WorkSprint | null;
  readOnly: boolean;
  promptsPaused: boolean;
  sprints: WorkSprint[];
  outcome?: WorkSprintOutcome;
};

/** A linked session as `session.list` reports it, or `{ id, missing }`. */
export type WorkSession = {
  id: string;
  missing?: boolean;
  workspaceId?: string;
  incarnation?: string;
  harnessId?: string | null;
  verdict?: string;
  agentState?: string | null;
  command?: string;
  [key: string]: unknown;
};

export type WorkDeliveryResult = {
  sessionId: string | null;
  action: "sent" | "resumed" | "started" | "skipped" | "failed";
  newSessionId?: string | null;
  error?: string;
  [key: string]: unknown;
};

export type WorkDelivery = {
  ticketId: string;
  ticketKey: string;
  columnId: string;
  trigger: string;
  message: string;
  results: WorkDeliveryResult[];
  at: number;
};

export type WorkSend = {
  id: number;
  columnId: string | null;
  ticketId: string;
  ticketKey: string | null;
  trigger: string;
  message: string;
  results: WorkDeliveryResult[];
  at: number;
};

export type WorkTicket = {
  id: string;
  key: string;
  title: string;
  description: string;
  projectId: string | null;
  projectName: string | null;
  workspaceId: string | null;
  columnId: string;
  position: number;
  prUrl: string | null;
  prNumber: number | null;
  sourceUrl: string | null;
  nextStep: string;
  createdAt: number;
  updatedAt: number;
  sessions: WorkSession[];
  /** The board listing carries an excerpt; `ticketShow` the whole text. */
  descriptionTruncated?: boolean;
  delivery?: WorkDelivery | null;
  sends?: WorkSend[];
  activity?: WorkActivity[];
  // Imported tickets (all absent or null on My work).
  boardId?: string | null;
  provider?: string | null;
  externalKey?: string | null;
  externalUrl?: string | null;
  issueType?: string | null;
  priority?: string | null;
  assignee?: string | null;
  externalStatus?: { id: string; name: string | null; category: string | null } | null;
  pendingStatus?: { id: string; name: string } | null;
  statusConflict?: boolean;
  statusUnmapped?: boolean;
  pushError?: string | null;
  removed?: boolean;
  sprintId?: string | null;
  sprintName?: string | null;
  sprintState?: string | null;
  externalSprintId?: string | null;
  sprintPending?: boolean;
  carriedFrom?: string | null;
  sync?: WorkSyncState;
  sprints?: WorkSprintStep[];
};

export type WorkBoard = {
  columns: WorkColumn[];
  tickets: WorkTicket[];
  projects: { id: string; name: string }[];
  /** The board shown (absent from a daemon without imported boards). */
  board?: WorkBoardSummary;
  boards?: WorkBoardSummary[];
  view?: WorkView;
};

/** A ticket source a board can sync with, and its connection. */
export type WorkSource = {
  id: "jira" | "linear" | "github" | string;
  name: string;
  /** Allowed by the owner (every source starts allowed). */
  enabled: boolean;
  connected: boolean;
  account: string | null;
  /** `tasks` (Jira's Tasks connection), `token` (a stored key) or `gh`. */
  via: string | null;
  apiUrl: string | null;
  error: string | null;
  boardTerm: string;
  /** The plural for lists ("teams", "projects and repositories"). */
  boardsTerm?: string;
  sprintTerm: string;
  /** How it connects: `tasks`, `api_key` or `gh_or_token`. */
  connect: string;
  helpUrl: string | null;
  boards: number;
};

export type WorkProviderBoard = {
  id: string;
  name: string;
  kind: string;
  projectKey: string | null;
  projectName: string | null;
  importedBoardId: string | null;
};

export type WorkProviderIssue = {
  id: string;
  key: string;
  url: string;
  title: string;
  issueType: string | null;
  priority: string | null;
  assignee: string | null;
  assigneeId?: string | null;
  project?: string | null;
  status: { id: string; name: string; category: string };
  sprint: WorkSprint | null;
  closedSprints: WorkSprint[];
  importedTicketId: string | null;
};

export type WorkImportPreview = {
  provider: string;
  board: { id: string; name: string; kind: string };
  columns: { name: string; statuses: WorkBoardStatus[] }[];
  sprints: WorkSprint[];
  issues: WorkProviderIssue[];
  /** The board had more issues than one reply carries. */
  truncated?: boolean;
  total?: number;
  /** The connected account's id, as issues carry it in `assigneeId`. */
  me?: string | null;
  facets?: WorkImportFacets;
};

export type WorkFacet = { id: string; name: string; count: number };

/** Counts over every issue of the board (not only the filtered ones). */
export type WorkImportFacets = {
  mine: number;
  /** Finished issues (done, closed, canceled). */
  finished?: number;
  unassigned: number;
  noProject: number;
  people: WorkFacet[];
  projects: WorkFacet[];
  statuses: WorkFacet[];
};

/** The import picker's filters: `assignee` is `me`, `none`, `any` or a
 *  person's id; `project` a name or `none`. */
export type WorkImportFilter = { assignee?: string; project?: string; status?: string; query?: string; open?: boolean };

export type WorkSyncResult = {
  board: WorkBoardSummary;
  updated: number;
  moved: number;
  conflicts: number;
  removed: number;
  /** New issues assigned to you, brought in by the sync. */
  imported?: number;
  deliveries: WorkDelivery[];
};

export type WorkPushResult = {
  ticketId: string;
  key: string;
  pushed: boolean;
  error: string | null;
  nothing?: boolean;
  ticket?: WorkTicket;
};

export type WorkPreview = {
  columnId: string;
  previews: {
    ticketId: string;
    ticketKey: string;
    message: string;
    recipients: { sessionId: string | null; action: string; harnessId?: string | null }[];
  }[];
};

export type WorkSessionOpen = {
  action: "open" | "resumed" | "started";
  session: WorkSession;
};

export type WorkColumnUpdate = {
  columnId: string;
  name?: string;
  icon?: string;
  index?: number;
  sendOnEnter?: boolean;
  cron?: string | null;
  prWatch?: boolean;
  message?: string;
  recipients?: WorkRecipients;
  harnessId?: string | null;
  statusIds?: string[];
  collapsed?: boolean;
};

export type WorkTicketCreate = {
  title: string;
  description?: string;
  projectId?: string;
  workspaceId?: string;
  columnId?: string;
  prUrl?: string;
  sourceUrl?: string;
  nextStep?: string;
  sessionIds?: string[];
  /** Imported boards: the ticket is a new issue in the board's source. */
  boardId?: string;
  /** Imported boards (default true). */
  assignToMe?: boolean;
  /** Jira: the issue type id (default Task). */
  issueType?: string;
  /** GitHub Project: the repository the issue is created in. */
  repo?: string;
  /** Imported boards: `backlog`, `active` or a sprint id (default: active on a sprint board). */
  sprintId?: string;
};

/** What creating an issue on an imported board can choose. */
export type WorkCreateOptions = {
  provider: string;
  boardId: string;
  issueTypes: { id: string; name: string }[];
  repos: string[];
};

export type WorkTicketUpdate = {
  ticketId: string;
  title?: string;
  description?: string;
  projectId?: string | null;
  workspaceId?: string | null;
  prUrl?: string | null;
  sourceUrl?: string | null;
  nextStep?: string;
};

export interface WorkBridge {
  board(input?: { projectId?: string; boardId?: string; sprintId?: string }): Promise<Result<WorkBoard>>;
  ticketShow(input: { ticketId: string }): Promise<Result<WorkTicket>>;
  sends(input: { columnId?: string; ticketId?: string; limit?: number }): Promise<Result<{ sends: WorkSend[] }>>;
  preview(input: { columnId: string; ticketId?: string; message?: string }): Promise<Result<WorkPreview>>;
  columnCreate(input: { name: string; icon?: string; index?: number; boardId?: string }): Promise<Result<WorkColumn>>;
  columnUpdate(input: WorkColumnUpdate): Promise<Result<WorkColumn>>;
  columnDelete(input: { columnId: string; moveTicketsTo?: string }): Promise<Result<{ deleted: string; movedTickets: number }>>;
  columnSend(input: { columnId: string; ticketId?: string; message?: string }): Promise<Result<{ columnId: string; sends: WorkDelivery[] }>>;
  ticketCreate(input: WorkTicketCreate): Promise<Result<WorkTicket & { warnings?: string[] }>>;
  createOptions(input: { boardId: string }): Promise<Result<WorkCreateOptions>>;
  ticketUpdate(input: WorkTicketUpdate): Promise<Result<WorkTicket>>;
  ticketMove(input: { ticketId: string; columnId: string; index?: number; sprintId?: string }): Promise<Result<WorkTicket>>;
  ticketDelete(input: { ticketId: string }): Promise<Result<{ deleted: string; key: string }>>;
  linkSession(input: { ticketId: string; sessionId: string }): Promise<Result<WorkTicket>>;
  unlinkSession(input: { ticketId: string; sessionId: string }): Promise<Result<WorkTicket>>;
  sessionOpen(input: { ticketId: string; sessionId: string }): Promise<Result<WorkSessionOpen>>;
  // Imported boards (`work.boards.v1`).
  providerBoards(input?: {
    provider?: string;
    siteId?: string;
  }): Promise<Result<{ provider: string; boards: WorkProviderBoard[]; warnings?: string[] }>>;
  importPreview(
    input: { externalBoardId: string; provider?: string; siteId?: string; scope?: string } & WorkImportFilter,
  ): Promise<Result<WorkImportPreview>>;
  boardImport(input: {
    externalBoardId: string;
    issueKeys?: string[];
    all?: boolean;
    mine?: boolean;
    autoImportMine?: boolean;
    projectId?: string;
    provider?: string;
    siteId?: string;
  }): Promise<Result<{ board: WorkBoardSummary; imported: number; refreshed: number }>>;
  boardSync(input: { boardId: string }): Promise<Result<WorkSyncResult>>;
  boardPush(input: { boardId: string }): Promise<Result<{ results: WorkPushResult[]; pushed: number; failed: number }>>;
  boardDelete(input: { boardId: string }): Promise<Result<{ deleted: string; name: string; tickets: number }>>;
  boardUpdate(input: { boardId: string; autoImportMine?: boolean; projectId?: string | null }): Promise<Result<WorkBoardSummary>>;
  ticketPush(input: { ticketId: string }): Promise<Result<WorkPushResult>>;
  ticketResolve(input: { ticketId: string; keep: "theirs" | "ours" }): Promise<Result<WorkTicket>>;
  ticketSprint(input: { ticketId: string; to: string }): Promise<Result<WorkTicket>>;
  ticketSessionStart(input: { ticketId: string; harnessId?: string; prompt?: string }): Promise<Result<WorkTicket & { session: WorkSession }>>;
  ticketSessionRename(input: { ticketId: string; sessionId: string; title: string }): Promise<Result<WorkTicket>>;
  // Sources (`work.sources.v1`).
  sources(): Promise<Result<{ sources: WorkSource[] }>>;
  sourceUpdate(input: { provider: string; enabled: boolean }): Promise<Result<WorkSource>>;
  sourceConnect(input: {
    provider: string;
    apiKey?: string;
    apiUrl?: string;
    /** Jira: the site, the account email (Cloud) and Cloud or Server. */
    siteUrl?: string;
    email?: string;
    authType?: "cloud" | "server";
  }): Promise<Result<WorkSource>>;
  sourceDisconnect(input: { provider: string }): Promise<Result<WorkSource>>;
}

declare module "./session-contract" {
  interface DesktopBridge {
    /** Optional: an older bridge has no namespace and the page says so. */
    work?: WorkBridge;
  }
}

// ------------------------------------------------------------- schemas --

const sessionSchema = z.looseObject({ id: z.string() });
const resultSchema = z.looseObject({
  sessionId: z.string().nullable(),
  action: z.enum(["sent", "resumed", "started", "skipped", "failed"]),
});
const deliverySchema = z.looseObject({
  ticketId: z.string(),
  ticketKey: z.string(),
  columnId: z.string(),
  trigger: z.string(),
  message: z.string(),
  results: z.array(resultSchema),
  at: z.number(),
});
const sendSchema = z.looseObject({
  id: z.number(),
  columnId: z.string().nullable(),
  ticketId: z.string(),
  ticketKey: z.string().nullable(),
  trigger: z.string(),
  message: z.string(),
  results: z.array(resultSchema),
  at: z.number(),
});
export const workColumnSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  position: z.number(),
  sendOnEnter: z.boolean(),
  cron: z.string().nullable(),
  prWatch: z.boolean(),
  message: z.string(),
  recipients: z.enum(["all", "primary"]),
  harnessId: z.string().nullable(),
  nextRunAt: z.number().nullable(),
  ticketCount: z.number(),
  lastSentAt: z.number().nullable(),
  lastSentCount: z.number(),
});
export const workTicketSchema = z.looseObject({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  description: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  workspaceId: z.string().nullable(),
  columnId: z.string(),
  position: z.number(),
  prUrl: z.string().nullable(),
  prNumber: z.number().nullable(),
  sourceUrl: z.string().nullable(),
  nextStep: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  sessions: z.array(sessionSchema),
  delivery: deliverySchema.nullable().optional(),
  sends: z.array(sendSchema).optional(),
});
const boardSummarySchema = z.looseObject({
  id: z.string(),
  provider: z.string().nullable(),
  name: z.string(),
  kind: z.string(),
  pendingCount: z.number(),
  ticketCount: z.number(),
});
const sprintSchema = z.looseObject({ id: z.string(), name: z.string(), state: z.string() });
export const workBoardSchema = z.looseObject({
  columns: z.array(workColumnSchema),
  tickets: z.array(workTicketSchema),
  projects: z.array(z.looseObject({ id: z.string(), name: z.string() })),
  board: boardSummarySchema.optional(),
  boards: z.array(boardSummarySchema).optional(),
  view: z
    .looseObject({
      kind: z.enum(["all", "sprint", "backlog"]),
      readOnly: z.boolean(),
      promptsPaused: z.boolean(),
      sprints: z.array(sprintSchema),
    })
    .optional(),
});
export const workProviderBoardsSchema = z.looseObject({
  provider: z.string(),
  boards: z.array(z.looseObject({ id: z.string(), name: z.string(), kind: z.string() })),
});
export const workImportPreviewSchema = z.looseObject({
  provider: z.string(),
  board: z.looseObject({ id: z.string(), name: z.string(), kind: z.string() }),
  columns: z.array(z.looseObject({ name: z.string() })),
  sprints: z.array(sprintSchema),
  issues: z.array(z.looseObject({ key: z.string(), title: z.string() })),
});
export const workBoardImportSchema = z.looseObject({
  board: boardSummarySchema,
  imported: z.number(),
  refreshed: z.number(),
});
export const workSyncSchema = z.looseObject({
  board: boardSummarySchema,
  updated: z.number(),
  moved: z.number(),
  conflicts: z.number(),
  removed: z.number(),
  deliveries: z.array(deliverySchema),
});
const pushSchema = z.looseObject({ ticketId: z.string(), key: z.string(), pushed: z.boolean() });
export const workBoardPushSchema = z.looseObject({
  results: z.array(pushSchema),
  pushed: z.number(),
  failed: z.number(),
});
const sourceSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  connected: z.boolean(),
  account: z.string().nullable(),
  boardTerm: z.string(),
  sprintTerm: z.string(),
  connect: z.string(),
  boards: z.number(),
});
export const workSourcesSchema = z.looseObject({ sources: z.array(sourceSchema) });
export const workBoardDeleteSchema = z.looseObject({ deleted: z.string(), name: z.string(), tickets: z.number() });
export const workSendsSchema = z.looseObject({ sends: z.array(sendSchema) });
export const workPreviewSchema = z.looseObject({
  columnId: z.string(),
  previews: z.array(
    z.looseObject({
      ticketId: z.string(),
      ticketKey: z.string(),
      message: z.string(),
      recipients: z.array(z.looseObject({ sessionId: z.string().nullable(), action: z.string() })),
    }),
  ),
});
export const workColumnDeleteSchema = z.looseObject({ deleted: z.string(), movedTickets: z.number() });
export const workColumnSendSchema = z.looseObject({ columnId: z.string(), sends: z.array(deliverySchema) });
export const workCreateOptionsSchema = z.looseObject({
  provider: z.string(),
  boardId: z.string(),
  issueTypes: z.array(z.looseObject({ id: z.string(), name: z.string() })),
  repos: z.array(z.string()),
});
export const workTicketDeleteSchema = z.looseObject({ deleted: z.string(), key: z.string() });
export const workSessionOpenSchema = z.looseObject({
  action: z.enum(["open", "resumed", "started"]),
  session: sessionSchema,
});

/** One renderer request: an op the main bridge maps onto one daemon method. */
export const WORK_OPS = {
  board: { method: "work.board", schema: workBoardSchema },
  ticketShow: { method: "work.ticket_show", schema: workTicketSchema },
  sends: { method: "work.sends", schema: workSendsSchema },
  preview: { method: "work.column_preview", schema: workPreviewSchema },
  columnCreate: { method: "work.column_create", schema: workColumnSchema },
  columnUpdate: { method: "work.column_update", schema: workColumnSchema },
  columnDelete: { method: "work.column_delete", schema: workColumnDeleteSchema },
  columnSend: { method: "work.column_send", schema: workColumnSendSchema },
  ticketCreate: { method: "work.ticket_create", schema: workTicketSchema },
  createOptions: { method: "work.create_options", schema: workCreateOptionsSchema },
  ticketUpdate: { method: "work.ticket_update", schema: workTicketSchema },
  ticketMove: { method: "work.ticket_move", schema: workTicketSchema },
  ticketDelete: { method: "work.ticket_delete", schema: workTicketDeleteSchema },
  linkSession: { method: "work.ticket_link_session", schema: workTicketSchema },
  unlinkSession: { method: "work.ticket_unlink_session", schema: workTicketSchema },
  sessionOpen: { method: "work.session_open", schema: workSessionOpenSchema },
  providerBoards: { method: "work.provider_boards", schema: workProviderBoardsSchema },
  importPreview: { method: "work.import_preview", schema: workImportPreviewSchema },
  boardImport: { method: "work.board_import", schema: workBoardImportSchema },
  boardSync: { method: "work.board_sync", schema: workSyncSchema },
  boardPush: { method: "work.board_push", schema: workBoardPushSchema },
  boardDelete: { method: "work.board_delete", schema: workBoardDeleteSchema },
  boardUpdate: { method: "work.board_update", schema: boardSummarySchema },
  ticketPush: { method: "work.ticket_push", schema: pushSchema },
  ticketResolve: { method: "work.ticket_resolve", schema: workTicketSchema },
  ticketSprint: { method: "work.ticket_sprint", schema: workTicketSchema },
  ticketSessionStart: { method: "work.ticket_session_start", schema: workTicketSchema },
  ticketSessionRename: { method: "work.ticket_session_rename", schema: workTicketSchema },
  sources: { method: "work.sources", schema: workSourcesSchema },
  sourceUpdate: { method: "work.source_update", schema: sourceSchema },
  sourceConnect: { method: "work.source_connect", schema: sourceSchema },
  sourceDisconnect: { method: "work.source_disconnect", schema: sourceSchema },
} as const;

export type WorkOp = keyof typeof WORK_OPS;

export const workRequestSchema = z.object({
  op: z.enum(Object.keys(WORK_OPS) as [WorkOp, ...WorkOp[]]),
  params: z.record(z.string(), z.unknown()).optional(),
});
