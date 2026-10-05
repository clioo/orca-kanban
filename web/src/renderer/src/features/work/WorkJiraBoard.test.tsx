// @vitest-environment jsdom
// Imported (Jira) boards on the Work page, against a recording fake bridge
// that answers each board/sprint selection the way the daemon does: the
// import flow (board → issues), the board and sprint pickers, cards with
// Jira fields and every sync state with the action that settles it, a
// closed sprint (read-only board, outcome panel, summary with carry-over),
// the ticket panel's tabs, sessions and Jira details, and the column's
// status mapping.
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installRadixJsdomStubs } from "../../components/ui/radix-jsdom-stubs";
import { TooltipProvider } from "../../components/ui/tooltip";
import type { Result } from "../../../../shared/session-contract";
import type {
  WorkBoard,
  WorkBoardSummary,
  WorkBridge,
  WorkColumn,
  WorkSprint,
  WorkTicket,
  WorkView,
} from "../../../../shared/work-contract";
import { resetWorkViewMemoryForTests, WORK_BOARD_KEY, WorkPage } from "./WorkPage";
import { defaultChosen, groupIssues } from "./WorkImportDialog";
import { initials, priorityLevel, sprintDates, syncHeadline } from "./work-sources";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

beforeAll(() => installRadixJsdomStubs());
afterEach(() => {
  cleanup();
  resetWorkViewMemoryForTests();
});

const ok = <T,>(result: T): Promise<Result<T>> => Promise.resolve({ ok: true, result });
const fail = (message: string, code = "x"): Promise<Result<never>> =>
  Promise.resolve({ ok: false, error: { code, message, retryable: false } });

const STATUSES = {
  todo: { id: "10000", name: "To Do", category: "new" },
  prog: { id: "3", name: "In Progress", category: "indeterminate" },
  review: { id: "10100", name: "In Review", category: "indeterminate" },
  done: { id: "10001", name: "Done", category: "done" },
  blocked: { id: "10102", name: "Blocked", category: "indeterminate" },
};

const SPRINTS: WorkSprint[] = [
  { id: "24", name: "Sprint 24", state: "closed", start: "2026-09-01T09:00:00.000Z", end: "2026-09-14T17:00:00.000Z" },
  { id: "25", name: "Sprint 25", state: "active", start: "2026-09-15T09:00:00.000Z", end: "2026-09-28T17:00:00.000Z" },
  { id: "26", name: "Sprint 26", state: "future", start: null, end: null },
];

function col(overrides: Partial<WorkColumn>): WorkColumn {
  return {
    id: "c",
    name: "C",
    icon: "todo",
    position: 0,
    sendOnEnter: false,
    cron: null,
    prWatch: false,
    message: "",
    recipients: "all",
    harnessId: null,
    nextRunAt: null,
    ticketCount: 0,
    lastSentAt: null,
    lastSentCount: 0,
    boardId: "b7",
    statuses: [],
    ...overrides,
  };
}

function jira(overrides: Partial<WorkTicket>): WorkTicket {
  return {
    id: "t",
    key: "DRG-1",
    title: "T",
    description: "",
    projectId: "p1",
    projectName: "Drogon",
    workspaceId: null,
    columnId: "todo",
    position: 0,
    prUrl: null,
    prNumber: null,
    sourceUrl: null,
    nextStep: "",
    createdAt: 1,
    updatedAt: 1,
    sessions: [],
    boardId: "b7",
    provider: "jira",
    externalKey: "APP-1",
    externalUrl: "http://jira.local/browse/APP-1",
    issueType: "Task",
    priority: "Medium",
    assignee: "Jon Doe",
    externalStatus: { id: STATUSES.todo.id, name: "To Do", category: "new" },
    pendingStatus: null,
    statusConflict: false,
    statusUnmapped: false,
    pushError: null,
    removed: false,
    sprintId: "25",
    sprintName: "Sprint 25",
    sprintState: "active",
    sprintPending: false,
    carriedFrom: null,
    sync: "synced",
    sprints: [],
    ...overrides,
  };
}

const LOCAL: WorkBoardSummary = { id: "local", provider: null, name: "My work", kind: "local", statuses: [], pendingCount: 0, ticketCount: 0 };
const PLATFORM: WorkBoardSummary = {
  id: "b7",
  provider: "jira",
  name: "Platform Delivery",
  kind: "scrum",
  externalId: "7",
  projectId: "p1",
  statuses: Object.values(STATUSES),
  pendingCount: 1,
  ticketCount: 8,
  lastSyncedAt: 1,
  lastSyncError: null,
};

function columns(): WorkColumn[] {
  return [
    col({ id: "todo", name: "To Do", icon: "todo", position: 0, statuses: [STATUSES.todo] }),
    col({ id: "prog", name: "In Progress", icon: "in_progress", position: 1, statuses: [STATUSES.prog] }),
    col({ id: "review", name: "Review", icon: "review", position: 2, statuses: [STATUSES.review] }),
    col({ id: "done", name: "Done", icon: "done", position: 3, statuses: [STATUSES.done] }),
  ];
}

function activeTickets(): WorkTicket[] {
  return [
    jira({ id: "t142", key: "DRG-1", externalKey: "APP-142", title: "Improve error messages", issueType: "Bug", assignee: "Jon Doe" }),
    jira({
      id: "t128",
      key: "DRG-2",
      externalKey: "APP-128",
      title: "Handle session resume after PR review",
      columnId: "review",
      carriedFrom: "Sprint 24",
      prNumber: 84,
      externalStatus: { id: STATUSES.review.id, name: "In Review", category: "indeterminate" },
      description: "Ensure sessions can be resumed seamlessly.",
      sessions: [
        { id: "s1", workspaceId: "ws-1", harnessId: "claude", verdict: "live", label: "Implement", createdAt: new Date().toISOString() },
        { id: "s2", workspaceId: "ws-1", harnessId: "pi", verdict: "exited" },
        { id: "s3", workspaceId: "ws-1", harnessId: "codex", verdict: "exited" },
      ],
      sprints: [
        { ...SPRINTS[0]!, status: "Review", outcome: "carried over" },
        { ...SPRINTS[1]!, status: "Review", outcome: "active" },
      ],
    }),
    jira({
      id: "t130",
      key: "DRG-3",
      externalKey: "APP-130",
      title: "Refactor workspace initialization",
      columnId: "prog",
      sync: "pending",
      pendingStatus: { id: STATUSES.prog.id, name: "In Progress" },
    }),
    jira({
      id: "t135",
      key: "DRG-4",
      externalKey: "APP-135",
      title: "Validate release build",
      columnId: "review",
      sync: "conflict",
      statusConflict: true,
      pendingStatus: { id: STATUSES.review.id, name: "In Review" },
      externalStatus: { id: STATUSES.done.id, name: "Done", category: "done" },
    }),
    jira({
      id: "t146",
      key: "DRG-5",
      externalKey: "APP-146",
      title: "Add analytics for drop-file usage",
      sync: "error",
      pushError: "Jira's workflow has no transition from this issue's status to that one",
      pendingStatus: { id: STATUSES.blocked.id, name: "Blocked" },
    }),
    jira({
      id: "t149",
      key: "DRG-6",
      externalKey: "APP-149",
      title: "Document session resume flow",
      sync: "unmapped",
      statusUnmapped: true,
      externalStatus: { id: STATUSES.blocked.id, name: "Blocked", category: "indeterminate" },
    }),
    jira({ id: "t150", key: "DRG-7", externalKey: "APP-150", title: "Investigate flaky sync", sync: "removed", removed: true }),
  ];
}

function closedTickets(): WorkTicket[] {
  return [
    jira({ id: "t110", key: "DRG-8", externalKey: "APP-110", title: "Add telemetry for drop-files", columnId: "done", sprintId: null, sprintName: null, externalStatus: { id: STATUSES.done.id, name: "Done", category: "done" } }),
    jira({ id: "t128", key: "DRG-2", externalKey: "APP-128", title: "Handle session resume after PR review", columnId: "review", sessions: [{ id: "s1", verdict: "live" }] }),
    jira({ id: "t122", key: "DRG-9", externalKey: "APP-122", title: "Clarify retry strategy", sprintId: null, sprintName: null }),
  ];
}

function view(kind: WorkView["kind"], sprint: WorkSprint | null, extra: Partial<WorkView> = {}): WorkView {
  return {
    kind,
    sprint,
    readOnly: sprint?.state === "closed",
    promptsPaused: sprint?.state !== "active",
    sprints: SPRINTS,
    ...extra,
  };
}

function fakeBridge(options: { importedBoards?: boolean } = {}) {
  const importedBoards = options.importedBoards ?? true;
  const cols = columns();
  const board = vi.fn((input?: { boardId?: string; sprintId?: string }): Promise<Result<WorkBoard>> => {
    if (!input?.boardId) {
      return ok({
        columns: cols.map((c) => ({ ...c, boardId: null, statuses: [] })),
        tickets: [],
        projects: [{ id: "p1", name: "Drogon" }],
        board: LOCAL,
        boards: importedBoards ? [LOCAL, PLATFORM] : [LOCAL],
        view: view("all", null, { readOnly: false, promptsPaused: false, sprints: [] }),
      });
    }
    const base = { columns: cols, projects: [{ id: "p1", name: "Drogon" }], board: PLATFORM, boards: [LOCAL, PLATFORM] };
    if (input.sprintId === "backlog") {
      return ok({ ...base, tickets: [closedTickets()[2]!], view: view("backlog", null) });
    }
    if (input.sprintId === "24") {
      return ok({
        ...base,
        tickets: closedTickets(),
        view: view("sprint", SPRINTS[0]!, {
          outcome: {
            completed: ["t110"],
            carried: [{ ticketId: "t128", toSprintId: "25", toSprintName: "Sprint 25", pending: false }],
            backlog: [{ ticketId: "t122", pending: false }],
          },
        }),
      });
    }
    return ok({ ...base, tickets: activeTickets(), view: view("sprint", SPRINTS[1]!) });
  });
  const all = [...activeTickets(), ...closedTickets()];
  const find = (id: string) => all.find((t) => t.id === id)!;
  return {
    board,
    ticketShow: vi.fn((input: { ticketId: string }) =>
      ok({
        ...find(input.ticketId),
        sends: [],
        activity: [{ id: 1, kind: "moved_by_provider", text: "Moved by Jira: In Progress → Review", at: Date.now() }],
      }),
    ),
    sends: vi.fn(() => ok({ sends: [] })),
    preview: vi.fn(),
    columnCreate: vi.fn(),
    columnUpdate: vi.fn((input: { columnId: string }) => ok(cols.find((c) => c.id === input.columnId)!)),
    columnDelete: vi.fn(),
    columnSend: vi.fn(),
    ticketCreate: vi.fn(),
    ticketUpdate: vi.fn((input: { ticketId: string }) => ok(find(input.ticketId))),
    ticketMove: vi.fn((input: { ticketId: string }) => ok({ ...find(input.ticketId), delivery: null })),
    ticketDelete: vi.fn(),
    linkSession: vi.fn(),
    unlinkSession: vi.fn(),
    sessionOpen: vi.fn(),
    providerBoards: vi.fn(() =>
      ok({
        provider: "jira",
        boards: [
          { id: "7", name: "Platform Delivery", kind: "scrum", projectKey: "APP", projectName: "Platform", importedBoardId: null },
          { id: "9", name: "Ops Kanban", kind: "kanban", projectKey: "APP", projectName: "Platform", importedBoardId: null },
        ],
      }),
    ),
    // Filters like the daemon: `assignee` me/none/any/<id>, `query` words.
    importPreview: vi.fn((input: { assignee?: string; query?: string }) => {
      const all = [
        { ...issue("APP-142", "Improve error messages", SPRINTS[1]!, STATUSES.todo), assignee: "Jon Doe", assigneeId: "acc-me" },
        { ...issue("APP-128", "Handle session resume", SPRINTS[1]!, STATUSES.review, "t128"), assignee: "Jon Doe", assigneeId: "acc-me" },
        { ...issue("APP-122", "Clarify retry strategy", null, STATUSES.todo), assignee: "Ana Lopez", assigneeId: "acc-ana" },
        issue("APP-110", "Add telemetry", null, STATUSES.done, null, [SPRINTS[0]!]),
      ];
      const who = input.assignee === "me" ? "acc-me" : input.assignee;
      const issues = all.filter(
        (i) =>
          (!who || (who === "none" ? !("assigneeId" in i) : "assigneeId" in i && i.assigneeId === who)) &&
          (!input.query || `${i.key} ${i.title}`.toLowerCase().includes(input.query.toLowerCase())),
      );
      return ok({
        provider: "jira",
        board: { id: "7", name: "Platform Delivery", kind: "scrum" },
        columns: [{ name: "To Do", statuses: [STATUSES.todo] }, { name: "Review", statuses: [STATUSES.review] }],
        sprints: SPRINTS,
        me: "acc-me",
        facets: {
          mine: 2,
          unassigned: 1,
          noProject: 0,
          people: [
            { id: "acc-me", name: "Jon Doe", count: 2 },
            { id: "acc-ana", name: "Ana Lopez", count: 1 },
          ],
          projects: [{ id: "Platform Delivery", name: "Platform Delivery", count: 4 }],
          statuses: [{ id: STATUSES.todo.id, name: "To Do", count: 2 }],
        },
        issues,
      });
    }),
    boardImport: vi.fn(() => ok({ board: PLATFORM, imported: 2, refreshed: 0 })),
    boardSync: vi.fn(() => ok({ board: PLATFORM, updated: 7, moved: 1, conflicts: 1, removed: 0, deliveries: [] })),
    boardPush: vi.fn(() => ok({ results: [], pushed: 1, failed: 0 })),
    boardDelete: vi.fn(() => ok({ deleted: "b7", name: "Platform Delivery", tickets: 8 })),
    ticketPush: vi.fn((input: { ticketId: string }) => ok({ ticketId: input.ticketId, key: "APP-130", pushed: true, error: null })),
    ticketResolve: vi.fn((input: { ticketId: string }) => ok({ ...find(input.ticketId), sync: "synced" as const })),
    ticketSprint: vi.fn((input: { ticketId: string }) => ok({ ...find(input.ticketId), sprintName: "Sprint 25" })),
    ticketSessionStart: vi.fn((input: { ticketId: string }) =>
      ok({ ...find(input.ticketId), session: { id: "s9", workspaceId: "ws-1", verdict: "live" } }),
    ),
    ticketSessionRename: vi.fn((input: { ticketId: string }) => ok(find(input.ticketId))),
    sources: vi.fn(() => ok({ sources: SOURCES })),
    sourceUpdate: vi.fn(),
    sourceConnect: vi.fn(),
    sourceDisconnect: vi.fn(),
  };
}

const SOURCES = [
  { id: "jira", name: "Jira", enabled: true, connected: true, account: "https://jira.local", via: "tasks", apiUrl: null, error: null, boardTerm: "board", sprintTerm: "sprint", connect: "tasks", helpUrl: null, boards: 1 },
  { id: "linear", name: "Linear", enabled: false, connected: false, account: null, via: null, apiUrl: null, error: null, boardTerm: "team", sprintTerm: "cycle", connect: "api_key", helpUrl: "https://linear.app/settings/account/security", boards: 0 },
  { id: "github", name: "GitHub", enabled: false, connected: false, account: null, via: null, apiUrl: null, error: null, boardTerm: "project or repository", sprintTerm: "iteration", connect: "gh_or_token", helpUrl: null, boards: 0 },
];

function issue(
  key: string,
  title: string,
  sprint: WorkSprint | null,
  status: { id: string; name: string; category: string },
  importedTicketId: string | null = null,
  closedSprints: WorkSprint[] = [],
) {
  return {
    id: key,
    key,
    url: `http://jira.local/browse/${key}`,
    title,
    issueType: "Task",
    priority: "Medium",
    assignee: null,
    status,
    sprint,
    closedSprints,
    importedTicketId,
  };
}

async function mount(bridge = fakeBridge(), onOpenSession = vi.fn()) {
  const view = render(
    <TooltipProvider>
      <WorkPage
        bridge={bridge as unknown as WorkBridge}
        workspaces={[{ id: "ws-1", name: "issue-621" }]}
        onOpenSession={onOpenSession}
        onOpenExternal={vi.fn()}
        listSessions={vi.fn(async () => []) as never}
      />
    </TooltipProvider>,
  );
  await waitFor(() => expect(bridge.board).toHaveBeenCalled());
  await screen.findByRole("region", { name: "To Do column" });
  return { view, bridge, onOpenSession };
}

function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
  fireEvent.click(trigger);
}

async function openPlatform(bridge = fakeBridge(), onOpenSession = vi.fn()) {
  const mounted = await mount(bridge, onOpenSession);
  openMenu(screen.getByRole("button", { name: "Board" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Platform Delivery · Jira" }));
  await screen.findByText("Improve error messages");
  return mounted;
}

describe("the chosen board survives a restart", () => {
  test("picking a board remembers it; a new launch opens on it", async () => {
    const first = await openPlatform();
    expect(localStorage.getItem(WORK_BOARD_KEY)).toBe("b7");
    first.view.unmount();
    // A new launch: this renderer's memory is gone, the storage is not.
    resetWorkViewMemoryForTests();
    localStorage.setItem(WORK_BOARD_KEY, "b7");
    const { bridge } = await mount();
    await screen.findByText("Improve error messages");
    expect(bridge.board).toHaveBeenCalledWith(expect.objectContaining({ boardId: "b7" }));
    // Back to My work: forgotten.
    openMenu(screen.getByRole("button", { name: "Board" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /My work/ }));
    await waitFor(() => expect(localStorage.getItem(WORK_BOARD_KEY)).toBeNull());
  });

  test("a remembered board that is gone falls back to My work and is forgotten", async () => {
    resetWorkViewMemoryForTests();
    localStorage.setItem(WORK_BOARD_KEY, "gone");
    const bridge = fakeBridge();
    const original = bridge.board.getMockImplementation()!;
    bridge.board.mockImplementation((input?: { boardId?: string; sprintId?: string }) =>
      input?.boardId === "gone" ? fail("work board gone not found") : original(input),
    );
    await mount(bridge);
    await waitFor(() => expect(bridge.board).toHaveBeenCalledWith(expect.not.objectContaining({ boardId: "gone" })));
    await waitFor(() => expect(localStorage.getItem(WORK_BOARD_KEY)).toBeNull());
  });
});

describe("Jira boards on the Work page", () => {
  test("an empty My work offers the allowed sources; the dialog picks a board, then its issues", async () => {
    const { bridge } = await mount(fakeBridge({ importedBoards: false }));
    const card = await screen.findByTestId("work-sync-card");
    expect(within(card).getByText("Sync a board")).toBeTruthy();
    // Only allowed sources are offered (Linear and GitHub are off here).
    expect(within(card).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "",
      "Import a Jira boardhttps://jira.local",
      "Manage sources",
    ]);
    fireEvent.click(within(card).getByRole("button", { name: /Import a Jira board/ }));
    const dialog = await screen.findByTestId("work-import-dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Choose Platform Delivery" }));
    await within(dialog).findByText("Columns: To Do · Review");
    expect(bridge.providerBoards).toHaveBeenCalledWith({ provider: "jira" });
    // It opens on the issues assigned to you, all chosen.
    expect(bridge.importPreview).toHaveBeenCalledWith({ externalBoardId: "7", provider: "jira", assignee: "me", open: true });
    expect((within(dialog).getByRole("combobox", { name: "Assigned to" }) as HTMLSelectElement).value).toBe("me");
    expect(within(dialog).queryByRole("checkbox", { name: "Import APP-122" })).toBeNull();
    expect(within(dialog).getAllByText("You").length).toBe(2);
    expect(within(dialog).getByRole("checkbox", { name: "Import APP-142" }).getAttribute("aria-checked")).toBe("true");
    // Anyone shows the rest; what you chose stays chosen.
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Assigned to" }), { target: { value: "any" } });
    await within(dialog).findByRole("checkbox", { name: "Import APP-122" });
    expect(bridge.importPreview).toHaveBeenLastCalledWith({ externalBoardId: "7", provider: "jira", open: true });
    // Grouped like the board: active sprint, backlog, finished in a past sprint.
    expect(within(dialog).getByRole("region", { name: "Sprint 25 · Active" })).toBeTruthy();
    expect(within(dialog).getByRole("region", { name: "Backlog" })).toBeTruthy();
    expect(within(dialog).getByRole("region", { name: "Finished in past sprints" })).toBeTruthy();
    // Yours stay chosen; others are not; an imported one is fixed.
    expect(within(dialog).getByRole("checkbox", { name: "Import APP-142" }).getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).getByRole("checkbox", { name: "Import APP-122" }).getAttribute("aria-checked")).toBe("false");
    const onBoard = within(dialog).getByRole("checkbox", { name: "Import APP-128" });
    expect(onBoard.hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByText("On the board")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Import APP-122" }));
    // The project picker says what it is for.
    const agentsWorkIn = within(dialog).getByRole("combobox", { name: "Agents work in" });
    const hint = document.getElementById(agentsWorkIn.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toBe(
      "When a ticket starts a session (a column's prompt or New session), it opens in this project's folder.",
    );
    fireEvent.change(agentsWorkIn, { target: { value: "p1" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Import 2 issues" }));
    });
    expect(bridge.boardImport).toHaveBeenCalledWith({
      provider: "jira",
      externalBoardId: "7",
      issueKeys: ["APP-142", "APP-122"],
      autoImportMine: true,
      projectId: "p1",
    });
    // The page moves to the imported board.
    await waitFor(() => expect(bridge.board).toHaveBeenCalledWith({ boardId: "b7" }));
  });

  test("the import dialog points an unconnected Jira at the Tasks page, and shows other errors", async () => {
    const bridge = fakeBridge();
    bridge.providerBoards.mockImplementation(() =>
      fail("Jira is not connected. Connect it from the Tasks page first.", "jira_not_connected") as never,
    );
    await mount(bridge);
    openMenu(screen.getByRole("button", { name: "Import board" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Import a Jira board/ }));
    const dialog = await screen.findByTestId("work-import-dialog");
    expect((await within(dialog).findByTestId("work-connect-jira")).textContent).toContain(
      "Work uses the Jira connection from the Tasks page.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    bridge.providerBoards.mockImplementation(() => fail("Jira request timed out.", "jira_timeout") as never);
    openMenu(screen.getByRole("button", { name: "Import board" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Import a Jira board/ }));
    const again = await screen.findByTestId("work-import-dialog");
    expect((await within(again).findByRole("alert")).textContent).toContain("Jira request timed out.");
  });

  test("an imported sprint board: pickers, cards with Jira fields and each sync state's action", async () => {
    const { bridge } = await openPlatform();
    expect(screen.getByRole("button", { name: "Board" }).textContent).toContain("Platform Delivery · Jira");
    expect(screen.getByRole("button", { name: "Sprint" }).textContent).toContain("Sprint 25 · Active");
    expect(screen.getByRole("button", { name: "Backlog" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Past sprints" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Project filter" })).toBeNull();

    const card = screen.getByRole("article", { name: "APP-128 Handle session resume after PR review" });
    expect(within(card).getByTestId("work-carried").textContent).toBe("Carried from Sprint 24");
    expect(within(card).getByTestId("work-issue-type").textContent).toBe("Task");
    expect(within(card).getByTestId("work-priority").textContent).toBe("Medium");
    expect(within(card).getByRole("img", { name: "Jon Doe" }).textContent).toBe("JD");
    expect(within(card).getByTestId("work-card-sessions").textContent).toBe("3 sessions · PR #84");
    expect(within(screen.getByRole("article", { name: /APP-142/ })).getByTestId("work-card-sessions").textContent).toBe("No sessions");

    const pending = screen.getByRole("article", { name: /APP-130/ });
    expect(within(pending).getByText("Not synced to Jira")).toBeTruthy();
    fireEvent.click(within(pending).getByRole("button", { name: "Push to Jira" }));
    await waitFor(() => expect(bridge.ticketPush).toHaveBeenCalledWith({ ticketId: "t130" }));

    const conflict = screen.getByRole("article", { name: /APP-135/ });
    expect(within(conflict).getByText("Jira: Done")).toBeTruthy();
    expect(within(conflict).getByText("Yours: In Review")).toBeTruthy();
    fireEvent.click(within(conflict).getByRole("button", { name: "Use Jira's" }));
    await waitFor(() => expect(bridge.ticketResolve).toHaveBeenCalledWith({ ticketId: "t135", keep: "theirs" }));
    fireEvent.click(within(conflict).getByRole("button", { name: "Push ours" }));
    await waitFor(() => expect(bridge.ticketResolve).toHaveBeenCalledWith({ ticketId: "t135", keep: "ours" }));

    const refused = screen.getByRole("article", { name: /APP-146/ });
    expect(within(refused).getByText("Jira refused the push")).toBeTruthy();
    expect(within(refused).getByText(/no transition/)).toBeTruthy();
    fireEvent.click(within(refused).getByRole("button", { name: "Retry push" }));
    await waitFor(() => expect(bridge.ticketPush).toHaveBeenCalledWith({ ticketId: "t146" }));

    const unmapped = screen.getByRole("article", { name: /APP-149/ });
    expect(within(unmapped).getByText("Status 'Blocked' not mapped")).toBeTruthy();
    openMenu(within(unmapped).getByRole("button", { name: "Map to a column…" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Review/ }));
    await waitFor(() =>
      expect(bridge.columnUpdate).toHaveBeenCalledWith({ columnId: "review", statusIds: ["10100", "10102"] }),
    );

    expect(within(screen.getByRole("article", { name: /APP-150/ })).getByText("Not in Jira anymore")).toBeTruthy();
    // The empty Done column says what it is for.
    expect(within(screen.getByRole("region", { name: "Done column" })).getByText("Tickets moved here will stay in this sprint.")).toBeTruthy();
  });

  test("sync, push all, and a drag that carries the viewed sprint", async () => {
    const { bridge } = await openPlatform();
    expect(screen.getByTestId("work-pending-count").textContent).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Sync Platform Delivery" }));
    await waitFor(() => expect(bridge.boardSync).toHaveBeenCalledWith({ boardId: "b7" }));
    openMenu(screen.getByRole("button", { name: "Sync options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Push all pending moves (1) to Jira" }));
    await waitFor(() => expect(bridge.boardPush).toHaveBeenCalledWith({ boardId: "b7" }));

    const card = screen.getByRole("article", { name: /APP-142/ });
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
      get types() {
        return [...data.keys()];
      },
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(card, { dataTransfer });
    const target = screen.getByRole("region", { name: "Review column" });
    fireEvent.dragOver(target, { dataTransfer, clientY: 10_000 });
    fireEvent.drop(target, { dataTransfer, clientY: 10_000 });
    await waitFor(() =>
      expect(bridge.ticketMove).toHaveBeenCalledWith({ ticketId: "t142", columnId: "review", index: 2, sprintId: "25" }),
    );

    // Import more issues brings existing issues in from Jira.
    openMenu(screen.getByRole("button", { name: "Sync options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Import more issues…" }));
    await screen.findByText("Columns: To Do · Review");
    expect(bridge.importPreview).toHaveBeenCalledWith({ externalBoardId: "7", provider: "jira", assignee: "me", open: true });
  });

  test("removing the board returns to My work", async () => {
    const { bridge } = await openPlatform();
    openMenu(screen.getByRole("button", { name: "Sync options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove board" }));
    await waitFor(() => expect(bridge.boardDelete).toHaveBeenCalledWith({ boardId: "b7" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Board" }).textContent).toContain("My work"));
  });

  test("the sprint picker and the Backlog link change the slice", async () => {
    const { bridge } = await openPlatform();
    fireEvent.click(screen.getByRole("button", { name: "Backlog" }));
    await waitFor(() => expect(bridge.board).toHaveBeenCalledWith({ boardId: "b7", sprintId: "backlog" }));
    expect(await screen.findByText("Backlog · prompts fire only in the active sprint")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to active sprint" }));
    await screen.findByText("Improve error messages");
    openMenu(screen.getByRole("button", { name: "Sprint" }));
    const items = (await screen.findAllByRole("menuitem")).map((i) => i.getAttribute("aria-label"));
    expect(items).toEqual(["Sprint 25 · Active", "Sprint 26 · Upcoming", "Sprint 24 · Closed", "Backlog"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Sprint 24 · Closed" }));
    await waitFor(() => expect(bridge.board).toHaveBeenCalledWith({ boardId: "b7", sprintId: "24" }));
  });

  test("selecting another active sprint shows its tickets when the board has multiple active sprints", async () => {
    const bridge = fakeBridge();
    const originalBoard = bridge.board.getMockImplementation()!;
    const emptySprint: WorkSprint = { ...SPRINTS[1]!, id: "empty", name: "2026.Q4.S1" };
    bridge.board.mockImplementation((input) => {
      if (!input?.boardId) return originalBoard(input);
      const selected = input.sprintId === "25" ? SPRINTS[1]! : emptySprint;
      return ok({
        columns: columns(),
        projects: [{ id: "p1", name: "Drogon" }],
        board: PLATFORM,
        boards: [LOCAL, PLATFORM],
        tickets: selected.id === "25" ? activeTickets() : [],
        view: view("sprint", selected, { sprints: [emptySprint, SPRINTS[1]!] }),
      });
    });
    await mount(bridge);
    openMenu(screen.getByRole("button", { name: "Board" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Platform Delivery · Jira" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Sprint" }).textContent).toContain("2026.Q4.S1"));
    expect(screen.queryByText("Improve error messages")).toBeNull();

    openMenu(screen.getByRole("button", { name: "Sprint" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sprint 25 · Active" }));
    await waitFor(() => expect(bridge.board).toHaveBeenCalledWith({ boardId: "b7", sprintId: "25" }));
    expect(await screen.findByText("Improve error messages")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sprint" }).textContent).toContain("Sprint 25 · Active");

    openMenu(screen.getByRole("button", { name: "Sprint" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "2026.Q4.S1 · Active" }));
    await waitFor(() => expect(bridge.board).toHaveBeenCalledWith({ boardId: "b7", sprintId: "empty" }));
    expect(screen.queryByText("Improve error messages")).toBeNull();
  });

  test("a closed sprint is a read-only record with its outcome and carry-over", async () => {
    const { bridge } = await openPlatform();
    openMenu(screen.getByRole("button", { name: "Sprint" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sprint 24 · Closed" }));
    const banner = await screen.findByTestId("work-closed-banner");
    expect(banner.textContent).toContain("Sprint 24 · closed");
    expect(banner.textContent).toContain("Historical snapshot · prompts paused");
    expect(screen.queryByRole("button", { name: "New column" })).toBeNull();
    expect(screen.queryByRole("button", { name: /New ticket in/ })).toBeNull();
    expect((screen.getByRole("button", { name: "New ticket" }) as HTMLButtonElement).disabled).toBe(true);
    const moved = screen.getByRole("article", { name: /APP-128/ });
    expect(moved.getAttribute("draggable")).toBe("false");
    expect(within(moved).getByTestId("work-carried").textContent).toContain("Carried to Sprint 25");

    const outcome = screen.getByTestId("work-sprint-outcome");
    expect(within(outcome).getByText("1 completed")).toBeTruthy();
    expect(within(outcome).getByText("1 carried over")).toBeTruthy();
    expect(within(outcome).getByText("Sessions and notes remain on APP-128.")).toBeTruthy();

    // The only change a closed sprint takes: carry over or send to backlog.
    openMenu(screen.getByRole("button", { name: "APP-122 actions" }));
    expect(screen.queryByRole("menuitem", { name: "Move to" })).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Carry over to active sprint" }));
    await waitFor(() => expect(bridge.ticketSprint).toHaveBeenCalledWith({ ticketId: "t122", to: "active" }));

    fireEvent.click(within(banner).getByRole("button", { name: "Sprint summary" }));
    const summary = await screen.findByTestId("work-sprint-summary");
    expect(within(summary).getByRole("heading", { name: "Sprint 24" })).toBeTruthy();
    expect(within(summary).getByText("Read-only · prompts paused")).toBeTruthy();
    expect(within(summary).getByRole("heading", { name: "Completed · 1" })).toBeTruthy();
    expect(within(summary).getByRole("heading", { name: "Carried forward · 1" })).toBeTruthy();
    expect(within(summary).getByRole("heading", { name: "Returned to backlog · 1" })).toBeTruthy();
    expect(within(summary).getByText("1 linked session · notes kept")).toBeTruthy();
    fireEvent.click(within(summary).getByRole("button", { name: "Carry over to Sprint 25" }));
    await waitFor(() => expect(bridge.ticketSprint).toHaveBeenCalledTimes(2));
    fireEvent.click(within(summary).getByRole("button", { name: "Send to backlog" }));
    await waitFor(() => expect(bridge.ticketSprint).toHaveBeenCalledWith({ ticketId: "t128", to: "backlog" }));
    // Open current ticket goes to the sprint it lives in now.
    fireEvent.click(within(summary).getAllByRole("button", { name: /Open current ticket/ })[0]!);
    await waitFor(() => expect(bridge.board).toHaveBeenLastCalledWith({ boardId: "b7" }));
  });

  test("the ticket panel: Jira key, read-only Jira fields, continuity, sessions and activity", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const onOpenSession = vi.fn();
    const { bridge } = await openPlatform(fakeBridge(), onOpenSession);
    fireEvent.click(screen.getByRole("button", { name: "Open APP-128: Handle session resume after PR review" }));
    const panel = await screen.findByRole("complementary", { name: "Ticket APP-128" });
    expect(within(panel).getByTestId("work-panel-key").textContent).toBe("APP-128");
    expect(within(panel).queryByRole("textbox", { name: "Ticket title" })).toBeNull();
    expect(within(panel).getByTestId("work-panel-title").textContent).toBe("Handle session resume after PR review");
    fireEvent.click(within(panel).getByRole("button", { name: "Copy Board key DRG-2" }));
    expect(writeText).toHaveBeenCalledWith("DRG-2");

    const continuity = within(panel).getByRole("region", { name: "Sprint continuity" });
    expect(continuity.textContent).toContain("Sprint 24 · Review · carried over");
    expect(continuity.textContent).toContain("Sprint 25 · Review · active");
    const details = within(panel).getByRole("region", { name: "Jira details" });
    expect(details.textContent).toContain("Jon Doe");
    expect(details.textContent).toContain("In Review");
    expect(details.textContent).toContain("Sprint 25");
    expect(within(panel).getByText("Sessions (3)")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: /Open Implement session s1/ })).toBeTruthy();

    openMenu(within(panel).getByRole("button", { name: "New session" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Claude Code" }));
    await waitFor(() => expect(bridge.ticketSessionStart).toHaveBeenCalledWith({ ticketId: "t128", harnessId: "claude" }));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith({ workspaceId: "ws-1", sessionId: "s9" }));

    openMenu(within(panel).getByRole("button", { name: "Session s1 actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const name = await within(panel).findByRole("textbox", { name: "Session name" });
    await waitFor(() => expect(document.activeElement).toBe(name));
    fireEvent.change(name, { target: { value: "Review follow-up" } });
    fireEvent.blur(name);
    await waitFor(() =>
      expect(bridge.ticketSessionRename).toHaveBeenCalledWith({ ticketId: "t128", sessionId: "s1", title: "Review follow-up" }),
    );

    fireEvent.click(within(panel).getByRole("tab", { name: "activity" }));
    expect(await within(panel).findByText("Moved by Jira: In Progress → Review")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("tab", { name: "links" }));
    expect(within(panel).getByText("http://jira.local/browse/APP-1")).toBeTruthy();
  });

  test("the column panel maps Jira statuses", async () => {
    const { bridge } = await openPlatform();
    openMenu(screen.getByRole("button", { name: "Review column actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Configure prompt…" }));
    const panel = await screen.findByRole("complementary", { name: "Review prompt" });
    expect(within(panel).getByTestId("work-column-mapped").textContent).toContain("In Review");
    fireEvent.click(within(panel).getByRole("button", { name: "Change" }));
    const statuses = within(panel).getByTestId("work-column-statuses");
    expect(within(statuses).getByRole("checkbox", { name: "Map In Review to Review" }).getAttribute("aria-checked")).toBe("true");
    expect(within(statuses).getByText("in In Progress")).toBeTruthy();
    fireEvent.click(within(statuses).getByRole("checkbox", { name: "Map Blocked to Review" }));
    await waitFor(() =>
      expect(bridge.columnUpdate).toHaveBeenCalledWith({ columnId: "review", statusIds: ["10100", "10102"] }),
    );
    expect(within(panel).getByText(/Prompts reach only tickets in the active sprint/)).toBeTruthy();
  });
});

describe("Jira board helpers", () => {
  test("labels and levels", () => {
    expect(initials("Jon Doe")).toBe("JD");
    expect(initials("Ana")).toBe("AN");
    expect(priorityLevel("Highest")).toBe(4);
    expect(priorityLevel("High")).toBe(3);
    expect(priorityLevel("Medium")).toBe(2);
    expect(priorityLevel("Low")).toBe(1);
    expect(sprintDates({ start: "2026-09-01T09:00:00.000Z", end: "2026-09-14T17:00:00.000Z" })).toBe("Sep 1 – Sep 14, 2026");
    expect(sprintDates({ start: null, end: null })).toBe("");
    expect(syncHeadline(jira({ sync: "pending", pendingStatus: null, sprintName: null }))).toBe(
      "Not synced to Jira: sent to the backlog",
    );
    expect(syncHeadline(jira({ sync: "synced" }))).toBeNull();
  });

  test("the picker starts on the active sprint's issues, or every issue without one", () => {
    const sprint = (id: string, state: string) => ({ id, name: `S${id}`, state, start: null, end: null, goal: null });
    const active = sprint("25", "active");
    const future = sprint("26", "future");
    const preview = (sprints: ReturnType<typeof sprint>[], issues: ReturnType<typeof issue>[]) => ({
      provider: "jira",
      board: { id: "7", name: "P", kind: "scrum" },
      columns: [],
      sprints,
      issues,
    });
    const now = issue("APP-1", "now", active, STATUSES.todo);
    const onBoard = issue("APP-2", "on the board", active, STATUSES.todo, "t2");
    const next = issue("APP-3", "next", future, STATUSES.todo);
    const backlog = issue("APP-4", "backlog", null, STATUSES.todo);
    // Active sprint only; an issue already on the board is not chosen again.
    expect([...defaultChosen(preview([active, future], [now, onBoard, next, backlog]))]).toEqual(["APP-1"]);
    // No active sprint (or nothing importable in it): every importable issue.
    expect([...defaultChosen(preview([future], [next, backlog]))]).toEqual(["APP-3", "APP-4"]);
    expect([...defaultChosen(preview([active, future], [onBoard, next]))]).toEqual(["APP-3"]);
  });

  test("a kanban preview is one group", () => {
    const groups = groupIssues({
      provider: "jira",
      board: { id: "9", name: "Ops", kind: "kanban" },
      columns: [],
      sprints: [],
      issues: [issue("APP-1", "x", null, STATUSES.todo)],
    });
    expect(groups.map((g) => g.label)).toEqual(["Issues"]);
  });
});

describe("working on an imported board", () => {
  /** The fake board with a change applied to every answer. */
  function withBoard(change: (board: WorkBoard) => WorkBoard) {
    const bridge = { ...fakeBridge(), boardUpdate: vi.fn(() => ok(PLATFORM)) };
    const original = bridge.board;
    bridge.board = vi.fn(async (input?: { boardId?: string; sprintId?: string }) => {
      const result = await original(input);
      return result.ok && input?.boardId ? { ok: true as const, result: change(result.result) } : result;
    });
    return bridge;
  }

  test("a column collapses to a strip that still takes a card, and expands again", async () => {
    const bridge = withBoard((b) => ({ ...b, columns: b.columns.map((c) => (c.id === "done" ? { ...c, collapsed: true } : c)) }));
    await openPlatform(bridge as never);
    const strip = screen.getByRole("region", { name: "Done column" });
    expect(strip.getAttribute("data-collapsed")).toBe("true");
    expect(within(strip).getByText("Done")).toBeTruthy();
    fireEvent.click(within(strip).getByRole("button", { name: "Expand Done column" }));
    await waitFor(() => expect(bridge.columnUpdate).toHaveBeenCalledWith({ columnId: "done", collapsed: false }));
    // A card dropped on the strip moves there.
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? "",
      get types() {
        return [...data.keys()];
      },
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(screen.getByRole("article", { name: /APP-142/ }), { dataTransfer });
    fireEvent.dragOver(strip, { dataTransfer, clientY: 10 });
    fireEvent.drop(strip, { dataTransfer, clientY: 10 });
    await waitFor(() =>
      expect(bridge.ticketMove).toHaveBeenCalledWith({ ticketId: "t142", columnId: "done", index: 0, sprintId: "25" }),
    );
    openMenu(screen.getByRole("button", { name: "Review column actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Collapse" }));
    await waitFor(() => expect(bridge.columnUpdate).toHaveBeenCalledWith({ columnId: "review", collapsed: true }));
  });

  test("a board without a project for sessions says so, and choosing one applies it", async () => {
    const bridge = withBoard((b) => ({ ...b, board: { ...b.board!, projectId: null } }));
    await openPlatform(bridge as never);
    const notice = screen.getByTestId("work-board-no-project");
    expect(notice.textContent).toContain("Agents on this board need an Orca project to work in");
    fireEvent.change(within(notice).getByRole("combobox", { name: "Agents work in" }), { target: { value: "p1" } });
    await waitFor(() => expect(bridge.boardUpdate).toHaveBeenCalledWith({ boardId: "b7", projectId: "p1" }));
    openMenu(screen.getByRole("button", { name: "Sync options" }));
    const sub = await screen.findByRole("menuitem", { name: "Agents work in" });
    fireEvent.keyDown(sub, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "No project" }));
    await waitFor(() => expect(bridge.boardUpdate).toHaveBeenLastCalledWith({ boardId: "b7", projectId: null }));
  });

  test("the column panel offers prompt templates, suggested for the column first", async () => {
    const bridge = withBoard((b) => b);
    await openPlatform(bridge as never);
    openMenu(screen.getByRole("button", { name: "Review column actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Configure prompt…" }));
    const panel = await screen.findByRole("complementary", { name: "Review prompt" });
    const picker = within(panel).getByRole("combobox", { name: "Use a template" }) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent).slice(0, 3)).toEqual(["Use a template…", "Address review", "Rework after feedback"]);
    fireEvent.change(picker, { target: { value: "review" } });
    await waitFor(() =>
      expect(bridge.columnUpdate).toHaveBeenCalledWith({
        columnId: "review",
        message: expect.stringContaining("{board.cli} ticket move --ticket {ticket.key} --column \"{column.next}\""),
      }),
    );
    expect((within(panel).getByRole("textbox", { name: "Message to sessions" }) as HTMLTextAreaElement).value).toContain("is in review");
  });

  test("the panel's sprint continuity comes from the full ticket, not the board listing", async () => {
    const bridge = withBoard((b) => ({ ...b, tickets: b.tickets.map((t) => ({ ...t, sprints: undefined })) }));
    await openPlatform(bridge as never);
    fireEvent.click(screen.getByRole("button", { name: "Open APP-128: Handle session resume after PR review" }));
    const panel = await screen.findByRole("complementary", { name: "Ticket APP-128" });
    expect((await within(panel).findByRole("region", { name: "Sprint continuity" })).textContent).toContain("Sprint 24");
  });
});

describe("reading a real board", () => {
  test("descriptions render their markdown; empty Jira fields and a kanban's sprint row stay out", async () => {
    const bridge = fakeBridge();
    const original = bridge.board;
    bridge.board = vi.fn(async (input?: { boardId?: string; sprintId?: string }) => {
      const result = await original(input);
      if (!result.ok || !input?.boardId) return result;
      return { ok: true as const, result: { ...result.result, board: { ...result.result.board!, kind: "kanban" } } };
    });
    bridge.ticketShow.mockImplementation(((input: { ticketId: string }) =>
      ok({
        ...activeTickets().find((t) => t.id === input.ticketId)!,
        description: "## Objetivo\n\nAgregar **imágenes** controladas.\n\n- una\n- dos",
        priority: null,
        issueType: null,
        sends: [],
        activity: [],
      })) as never);
    await openPlatform(bridge as never);
    fireEvent.click(screen.getByRole("button", { name: "Open APP-128: Handle session resume after PR review" }));
    const panel = await screen.findByRole("complementary", { name: "Ticket APP-128" });
    const description = await within(panel).findByTestId("work-panel-description");
    await waitFor(() => expect(within(description).getByRole("heading", { name: "Objetivo" })).toBeTruthy());
    expect(within(description).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["una", "dos"]);
    expect(description.textContent).not.toContain("##");
    const details = within(panel).getByRole("region", { name: "Jira details" });
    expect(within(details).queryByText("Sprint")).toBeNull();
    expect(within(details).getByText("Assignee")).toBeTruthy();
  });

  test("Filter folds the empty columns of the view and unfolds them all", async () => {
    const bridge = fakeBridge();
    await openPlatform(bridge as never);
    openMenu(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Collapse empty columns" }));
    await waitFor(() => expect(bridge.columnUpdate).toHaveBeenCalledWith({ columnId: "done", collapsed: true }));
    expect(bridge.columnUpdate).toHaveBeenCalledTimes(1);
  });

  test("+ on a column creates a Jira issue in that column's status, sprint and type", async () => {
    const base = fakeBridge();
    const created = jira({ id: "t200", key: "DRG-9", externalKey: "APP-151", title: "Created here", columnId: "review" });
    const bridge = {
      ...base,
      createOptions: vi.fn(() =>
        ok({ provider: "jira", boardId: "b7", issueTypes: [{ id: "2", name: "Task" }, { id: "1", name: "Bug" }], repos: [] }),
      ),
      ticketCreate: vi.fn(() => ok({ ...created, warnings: [] })),
    };
    await openPlatform(bridge);
    fireEvent.click(screen.getByRole("button", { name: "New ticket in Review" }));
    const dialog = await screen.findByTestId("work-create-issue-dialog");
    expect(within(dialog).getByText("New Jira issue")).toBeTruthy();
    expect(within(dialog).getByTestId("work-create-issue-status").textContent).toBe("It starts in Jira as In Review.");
    // The sprint being viewed; closed sprints are not offered.
    const sprint = within(dialog).getByRole("combobox", { name: "Sprint" }) as HTMLSelectElement;
    expect(sprint.value).toBe("25");
    expect(Array.from(sprint.options).map((o) => o.value)).toEqual(["backlog", "25", "26"]);
    const type = (await within(dialog).findByRole("combobox", { name: "Issue type" })) as HTMLSelectElement;
    await waitFor(() => expect(type.value).toBe("2"));
    const submit = within(dialog).getByRole("button", { name: "Create in Jira" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "Created here" } });
    fireEvent.change(type, { target: { value: "1" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Assign to me" }));
    fireEvent.click(submit);
    await waitFor(() =>
      expect(bridge.ticketCreate).toHaveBeenCalledWith({
        boardId: "b7",
        title: "Created here",
        columnId: "review",
        assignToMe: false,
        sprintId: "25",
        issueType: "1",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("work-create-issue-dialog")).toBeNull());
    expect(bridge.createOptions).toHaveBeenCalledWith({ boardId: "b7" });
    expect(base.importPreview).not.toHaveBeenCalled();
  });

  test("a failed create keeps the form and says why", async () => {
    const bridge = {
      ...fakeBridge(),
      createOptions: vi.fn(() => ok({ provider: "jira", boardId: "b7", issueTypes: [{ id: "2", name: "Task" }], repos: [] })),
      ticketCreate: vi.fn(() =>
        Promise.resolve({ ok: false as const, error: { code: "jira_error", message: "Jira refused: summary too long", retryable: false } }),
      ),
    };
    await openPlatform(bridge);
    fireEvent.click(screen.getByRole("button", { name: "New ticket" }));
    const dialog = await screen.findByTestId("work-create-issue-dialog");
    expect((within(dialog).getByRole("combobox", { name: "Column" }) as HTMLSelectElement).value).toBe("todo");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "Too long" } });
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Create in Jira" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create in Jira" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("summary too long");
  });
});
