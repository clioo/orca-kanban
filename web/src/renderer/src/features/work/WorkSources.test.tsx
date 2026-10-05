// @vitest-environment jsdom
// Ticket sources on the Work page against a recording fake bridge: every
// source starts allowed and the Sources tab turns them off and on,
// connects Linear with an API key and GitHub with the gh login or a token
// (plus an Enterprise URL), and forgets a key; the "Import board" menu and
// the dismissible "Sync a board" card offer only allowed sources; the
// import dialog connects a source in place; and a Linear board speaks in
// cycles, a GitHub one in iterations.
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installRadixJsdomStubs } from "../../components/ui/radix-jsdom-stubs";
import { TooltipProvider } from "../../components/ui/tooltip";
import type { Result } from "../../../../shared/session-contract";
import type { WorkBoard, WorkBridge, WorkColumn, WorkSource, WorkTicket } from "../../../../shared/work-contract";
import { resetWorkViewMemoryForTests, WorkPage } from "./WorkPage";
import { importLabel, SYNC_CARD_DISMISSED_KEY, WorkSourceConnectForm } from "./WorkSources";
import { providerLabel, sprintTerm, ticketDisplayKey } from "./work-sources";
import {
  consumePendingTaskSource,
  consumePendingTaskSourceConnect,
  resetTaskSourceNavigation,
} from "../tasks/task-source-navigation";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

beforeAll(() => installRadixJsdomStubs());
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  resetWorkViewMemoryForTests();
  resetTaskSourceNavigation();
});

const ok = <T,>(result: T): Promise<Result<T>> => Promise.resolve({ ok: true, result });
const fail = (message: string, code: string): Promise<Result<never>> =>
  Promise.resolve({ ok: false, error: { code, message, retryable: false } });

function source(overrides: Partial<WorkSource> & { id: string; name: string }): WorkSource {
  return {
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
    ...overrides,
  };
}

function initialSources(): WorkSource[] {
  return [
    source({ id: "jira", name: "Jira" }),
    source({ id: "linear", name: "Linear", boardTerm: "team", sprintTerm: "cycle", connect: "api_key", helpUrl: "https://linear.app/settings/account/security" }),
    source({ id: "github", name: "GitHub", boardTerm: "project or repository", boardsTerm: "projects and repositories", sprintTerm: "iteration", connect: "gh_or_token", helpUrl: "https://github.com/settings/tokens/new" }),
  ];
}

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
    ...overrides,
  };
}

const LINEAR_BOARD = {
  id: "bl",
  provider: "linear",
  name: "Engineering",
  kind: "scrum",
  externalId: "team-eng",
  statuses: [],
  pendingCount: 0,
  ticketCount: 1,
};
const LOCAL = { id: "local", provider: null, name: "My work", kind: "local", statuses: [], pendingCount: 0, ticketCount: 0 };

function linearTicket(): WorkTicket {
  return {
    id: "t1",
    key: "DRG-1",
    title: "Resume Linear sessions",
    description: "",
    projectId: null,
    projectName: null,
    workspaceId: null,
    columnId: "review",
    position: 0,
    prUrl: null,
    prNumber: null,
    sourceUrl: null,
    nextStep: "",
    createdAt: 1,
    updatedAt: 1,
    sessions: [],
    boardId: "bl",
    provider: "linear",
    externalKey: "ENG-1",
    externalUrl: "https://linear.app/drogon/issue/ENG-1",
    issueType: "backend",
    priority: "High",
    assignee: "Jon Doe",
    externalStatus: { id: "st-review", name: "In Review", category: "indeterminate" },
    sync: "pending",
    pendingStatus: { id: "st-done", name: "Done" },
    sprintId: "cy-12",
    sprintName: "Cycle 12",
    sprints: [],
  };
}

function fakeBridge(options: { withLinearBoard?: boolean } = {}) {
  let sources = initialSources();
  const cycles = [
    { id: "cy-11", name: "Cycle 11", state: "closed", start: null, end: null },
    { id: "cy-12", name: "Cycle 12", state: "active", start: null, end: null },
  ];
  const board = vi.fn((input?: { boardId?: string }): Promise<Result<WorkBoard>> => {
    if (input?.boardId === "bl") {
      return ok({
        columns: [col({ id: "review", name: "In Review", boardId: "bl" }), col({ id: "done", name: "Done", icon: "done", position: 1, boardId: "bl" })],
        tickets: [linearTicket()],
        projects: [],
        board: LINEAR_BOARD,
        boards: [LOCAL, LINEAR_BOARD],
        view: { kind: "sprint", sprint: cycles[1]!, readOnly: false, promptsPaused: false, sprints: cycles },
      });
    }
    return ok({
      columns: [col({ id: "todo", name: "To do" })],
      tickets: [],
      projects: [],
      board: LOCAL,
      boards: options.withLinearBoard ? [LOCAL, LINEAR_BOARD] : [LOCAL],
      view: { kind: "all", readOnly: false, promptsPaused: false, sprints: [] },
    });
  });
  const update = (id: string, patch: Partial<WorkSource>) => {
    sources = sources.map((s) => (s.id === id ? { ...s, ...patch } : s));
    return sources.find((s) => s.id === id)!;
  };
  let linearConnected = false;
  return {
    board,
    ticketShow: vi.fn(() => ok({ ...linearTicket(), sends: [], activity: [] })),
    sends: vi.fn(() => ok({ sends: [] })),
    columnUpdate: vi.fn(),
    ticketMove: vi.fn(),
    ticketPush: vi.fn(() => ok({ ticketId: "t1", key: "ENG-1", pushed: true, error: null })),
    ticketResolve: vi.fn(),
    sources: vi.fn(() => ok({ sources })),
    sourceUpdate: vi.fn((input: { provider: string; enabled: boolean }) => ok(update(input.provider, { enabled: input.enabled }))),
    sourceConnect: vi.fn((input: { provider: string; apiKey?: string; apiUrl?: string }) => {
      if (input.provider === "linear") {
        if (input.apiKey !== "lin_api_good") return fail("Authentication required, not authenticated", "linear_auth_required");
        linearConnected = true;
        return ok(update("linear", { connected: true, account: "Jon Doe · Drogon", via: "token" }));
      }
      return ok(update("github", { connected: true, account: "octo", via: input.apiKey ? "token" : "gh", apiUrl: input.apiUrl ?? null }));
    }),
    sourceDisconnect: vi.fn((input: { provider: string }) => ok(update(input.provider, { connected: false, account: null, via: null }))),
    providerBoards: vi.fn((input: { provider: string }) =>
      input.provider === "linear" && !linearConnected
        ? fail("Linear is not connected. Connect it in Work → Sources with a Linear API key.", "linear_not_connected")
        : ok({
            provider: input.provider,
            boards: [{ id: "team-eng", name: "Engineering", kind: "scrum", projectKey: "ENG", projectName: "Engineering", importedBoardId: null }],
          }),
    ),
    importPreview: vi.fn((input: { assignee?: string }) =>
      ok({
        provider: "linear",
        me: "lin-me",
        facets: { mine: 1, unassigned: 1, noProject: 2, people: [{ id: "lin-me", name: "Jon Doe", count: 1 }], projects: [], statuses: [] },
        board: { id: "team-eng", name: "Engineering", kind: "scrum" },
        columns: [{ name: "Todo", statuses: [] }, { name: "In Review", statuses: [] }],
        sprints: cycles,
        issues: [
          {
            id: "li-1", key: "ENG-1", url: "", title: "Resume Linear sessions", issueType: null, priority: "High", assignee: "Jon Doe", assigneeId: "lin-me",
            status: { id: "st-review", name: "In Review", category: "indeterminate" }, sprint: cycles[1]!, closedSprints: [], importedTicketId: null,
          },
          {
            id: "li-4", key: "ENG-4", url: "", title: "Old leftover", issueType: null, priority: null, assignee: null,
            status: { id: "st-done", name: "Done", category: "done" }, sprint: null, closedSprints: [cycles[0]!], importedTicketId: null,
          },
        ].filter((i) => input.assignee !== "me" || i.assigneeId === "lin-me"),
      }),
    ),
    boardImport: vi.fn(() => ok({ board: LINEAR_BOARD, imported: 1, refreshed: 0 })),
    boardSync: vi.fn(),
    boardPush: vi.fn(),
    boardDelete: vi.fn(),
  };
}

async function mount(bridge = fakeBridge(), extra: { onOpenExternal?: (url: string) => void; onOpenTasks?: () => void } = {}) {
  render(
    <TooltipProvider>
      <WorkPage
        bridge={bridge as unknown as WorkBridge}
        workspaces={[]}
        onOpenSession={vi.fn()}
        onOpenExternal={extra.onOpenExternal ?? vi.fn()}
        onOpenTasks={extra.onOpenTasks}
        listSessions={vi.fn(async () => []) as never}
      />
    </TooltipProvider>,
  );
  await waitFor(() => expect(bridge.sources).toHaveBeenCalled());
  await screen.findByRole("region", { name: "To do column" });
  return bridge;
}

function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
  fireEvent.click(trigger);
}

async function importMenuItems(): Promise<string[]> {
  openMenu(await screen.findByRole("button", { name: "Import board" }));
  const items = (await screen.findAllByRole("menuitem")).map((i) => (i.textContent ?? "").trim());
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  return items;
}

describe("Work sources", () => {
  test("every source starts allowed: the import menu and the card offer all three", async () => {
    await mount();
    expect(await importMenuItems()).toEqual([
      "Import a Jira board…",
      "Import a Linear team…",
      "Import a GitHub project or repository…",
      "Manage sources…",
    ]);
    const card = await screen.findByTestId("work-sync-card");
    expect(within(card).getByText("Sync a board")).toBeTruthy();
    expect(within(card).getByText(/Optional/)).toBeTruthy();
    expect(within(card).getByRole("button", { name: /Import a Linear team/ })).toBeTruthy();
    expect(within(card).getByRole("button", { name: /Import a GitHub project or repository/ })).toBeTruthy();
  });

  test("the card is dismissible, stays dismissed, and can come back from Sources", async () => {
    await mount();
    fireEvent.click(within(await screen.findByTestId("work-sync-card")).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("work-sync-card")).toBeNull();
    expect(localStorage.getItem(SYNC_CARD_DISMISSED_KEY)).toBe("1");
    // Import stays available from the header.
    expect(screen.getByRole("button", { name: "Import board" })).toBeTruthy();
    cleanup();
    resetWorkViewMemoryForTests();
    await mount();
    expect(screen.queryByTestId("work-sync-card")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "sources" }));
    fireEvent.click(await screen.findByRole("button", { name: /Sync a board" card/ }));
    fireEvent.click(screen.getByRole("tab", { name: "board" }));
    expect(await screen.findByTestId("work-sync-card")).toBeTruthy();
  });

  test("Sources turns a source off and on; an off source leaves the menu and the card", async () => {
    const bridge = await mount();
    fireEvent.click(screen.getByRole("tab", { name: "sources" }));
    const panel = await screen.findByTestId("work-sync-sources");
    expect(within(within(panel).getByRole("listitem", { name: "GitHub" })).getByText(/Projects and repositories, iterations/)).toBeTruthy();
    const jira = within(panel).getByRole("listitem", { name: "Jira" });
    expect(within(jira).getByTestId("work-source-status").textContent).toBe("Not connected");
    fireEvent.click(within(jira).getByRole("switch", { name: "Allow Jira" }));
    await waitFor(() => expect(bridge.sourceUpdate).toHaveBeenCalledWith({ provider: "jira", enabled: false }));
    await waitFor(() =>
      expect(within(within(panel).getByRole("listitem", { name: "Jira" })).getByTestId("work-source-status").textContent).toBe(
        "Off: not imported, synced or pushed",
      ),
    );
    fireEvent.click(screen.getByRole("tab", { name: "board" }));
    expect(await importMenuItems()).toEqual([
      "Import a Linear team…",
      "Import a GitHub project or repository…",
      "Manage sources…",
    ]);
    expect(within(screen.getByTestId("work-sync-card")).queryByRole("button", { name: /Jira/ })).toBeNull();

    // Everything off: no import menu, no card.
    fireEvent.click(screen.getByRole("tab", { name: "sources" }));
    for (const name of ["Linear", "GitHub"]) {
      fireEvent.click(within(await screen.findByTestId("work-sync-sources")).getByRole("switch", { name: `Allow ${name}` }));
      await waitFor(() => expect(bridge.sourceUpdate).toHaveBeenCalledWith({ provider: name.toLowerCase(), enabled: false }));
    }
    fireEvent.click(screen.getByRole("tab", { name: "board" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Import board" })).toBeNull());
    expect(screen.queryByTestId("work-sync-card")).toBeNull();
  });

  test("Linear connects with an API key: its settings page opens, a bad key shows Linear's error", async () => {
    const onOpenExternal = vi.fn();
    const bridge = await mount(fakeBridge(), { onOpenExternal });
    fireEvent.click(screen.getByRole("tab", { name: "sources" }));
    const linear = within(await screen.findByTestId("work-sync-sources")).getByRole("listitem", { name: "Linear" });
    fireEvent.click(within(linear).getByRole("button", { name: "Connect" }));
    const form = within(linear).getByRole("form", { name: "Connect Linear" });
    fireEvent.click(within(form).getByRole("button", { name: /Get a Linear API key/ }));
    expect(onOpenExternal).toHaveBeenCalledWith("https://linear.app/settings/account/security");
    const key = within(form).getByLabelText("Linear API key");
    expect(key.getAttribute("type")).toBe("password");
    fireEvent.change(key, { target: { value: "lin_api_bad" } });
    fireEvent.submit(form);
    expect((await within(form).findByRole("alert")).textContent).toContain("Authentication required");
    fireEvent.change(key, { target: { value: "lin_api_good" } });
    fireEvent.submit(form);
    await waitFor(() => expect(bridge.sourceConnect).toHaveBeenLastCalledWith({ provider: "linear", apiKey: "lin_api_good" }));
    await waitFor(() =>
      expect(
        within(within(screen.getByTestId("work-sync-sources")).getByRole("listitem", { name: "Linear" })).getByTestId("work-source-status")
          .textContent,
      ).toBe("Connected as Jon Doe · Drogon"),
    );
    fireEvent.click(within(within(screen.getByTestId("work-sync-sources")).getByRole("listitem", { name: "Linear" })).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(bridge.sourceDisconnect).toHaveBeenCalledWith({ provider: "linear" }));
  });

  test("a gh login with no account yet reads as connected through gh", async () => {
    const bridge = fakeBridge();
    const sources = initialSources().map((s) => (s.id === "github" ? { ...s, connected: true, via: "gh" } : s));
    bridge.sources.mockImplementation(() => ok({ sources }));
    await mount(bridge);
    fireEvent.click(screen.getByRole("tab", { name: "sources" }));
    const github = within(await screen.findByTestId("work-sync-sources")).getByRole("listitem", { name: "GitHub" });
    expect(within(github).getByTestId("work-source-status").textContent).toBe("Connected (gh login)");
  });

  test("GitHub connects with the gh login or a token and an Enterprise URL; Jira points at Tasks", async () => {
    const onOpenTasks = vi.fn();
    const bridge = await mount(fakeBridge(), { onOpenTasks });
    fireEvent.click(screen.getByRole("tab", { name: "sources" }));
    const panel = await screen.findByTestId("work-sync-sources");
    fireEvent.click(within(within(panel).getByRole("listitem", { name: "Jira" })).getByRole("button", { name: "Connect" }));
    expect(onOpenTasks).toHaveBeenCalled();
    expect(consumePendingTaskSourceConnect()).toBe("jira");
    const github = within(panel).getByRole("listitem", { name: "GitHub" });
    fireEvent.click(within(github).getByRole("button", { name: "Connect" }));
    fireEvent.click(within(github).getByRole("button", { name: "Use my gh login" }));
    await waitFor(() => expect(bridge.sourceConnect).toHaveBeenCalledWith({ provider: "github" }));
    await waitFor(() =>
      expect(within(within(panel).getByRole("listitem", { name: "GitHub" })).getByTestId("work-source-status").textContent).toBe(
        "Connected as octo (gh login)",
      ),
    );
    const again = within(panel).getByRole("listitem", { name: "GitHub" });
    fireEvent.click(within(again).getByRole("button", { name: "Change" }));
    fireEvent.click(within(again).getByRole("button", { name: "GitHub Enterprise?" }));
    fireEvent.change(within(again).getByLabelText("GitHub Enterprise API URL"), { target: { value: "https://ghe.example/api/v3" } });
    fireEvent.change(within(again).getByLabelText("GitHub token"), { target: { value: "ghp_x" } });
    fireEvent.submit(within(again).getByRole("form", { name: "Connect GitHub" }));
    await waitFor(() =>
      expect(bridge.sourceConnect).toHaveBeenLastCalledWith({ provider: "github", apiKey: "ghp_x", apiUrl: "https://ghe.example/api/v3" }),
    );
  });

  test("Connect Jira on the Tasks page closes the import dialog and opens Tasks on Jira's connect flow", async () => {
    const onOpenTasks = vi.fn();
    const bridge = fakeBridge();
    bridge.providerBoards.mockImplementation(() =>
      fail("Jira is not connected. Connect it on the Tasks page.", "jira_not_connected"),
    );
    await mount(bridge, { onOpenTasks });
    openMenu(await screen.findByRole("button", { name: "Import board" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Import a Jira board/ }));
    const dialog = await screen.findByTestId("work-import-dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Connect Jira on the Tasks page" }));

    expect(onOpenTasks).toHaveBeenCalledTimes(1);
    // The page stays mounted (hidden) behind Tasks, so a lingering dialog
    // would cover the Tasks page: it must be gone.
    await waitFor(() => expect(screen.queryByTestId("work-import-dialog")).toBeNull());
    expect(consumePendingTaskSource()).toBe("jira");
    expect(consumePendingTaskSourceConnect()).toBe("jira");
  });

  test("importing from an unconnected Linear connects in place, then lists its teams", async () => {
    const bridge = await mount();
    fireEvent.click(within(await screen.findByTestId("work-sync-card")).getByRole("button", { name: /Import a Linear team/ }));
    const dialog = await screen.findByTestId("work-import-dialog");
    expect(within(dialog).getByText("Import a Linear team")).toBeTruthy();
    const form = await within(dialog).findByRole("form", { name: "Connect Linear" });
    fireEvent.change(within(form).getByLabelText("Linear API key"), { target: { value: "lin_api_good" } });
    await act(async () => {
      fireEvent.submit(form);
    });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Choose Engineering" }));
    await within(dialog).findByText("Columns: Todo · In Review");
    expect(bridge.importPreview).toHaveBeenCalledWith({ externalBoardId: "team-eng", provider: "linear", assignee: "me", open: true });
    expect(within(dialog).getByRole("region", { name: "Cycle 12 · Active" })).toBeTruthy();
    // Yours by default; Anyone shows the rest (the finished one too).
    expect(within(dialog).queryByRole("region", { name: "Finished in past cycles" })).toBeNull();
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Assigned to" }), { target: { value: "any" } });
    expect(await within(dialog).findByRole("region", { name: "Finished in past cycles" })).toBeTruthy();
    expect(within(dialog).getByRole("checkbox", { name: "Import ENG-4" }).getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Import 1 issue" }));
    });
    expect(bridge.boardImport).toHaveBeenCalledWith({
      provider: "linear",
      externalBoardId: "team-eng",
      issueKeys: ["ENG-1"],
      autoImportMine: true,
      projectId: undefined,
    });
    await waitFor(() => expect(bridge.board).toHaveBeenCalledWith({ boardId: "bl" }));
  });

  test("a Linear board speaks in cycles and pushes to Linear", async () => {
    const bridge = await mount(fakeBridge({ withLinearBoard: true }));
    openMenu(screen.getByRole("button", { name: "Board" }));
    const items = (await screen.findAllByRole("menuitem")).map((i) => (i.textContent ?? "").trim());
    expect(items).toContain("Import a Linear team…");
    fireEvent.click(screen.getByRole("menuitem", { name: "Engineering · Linear" }));
    await screen.findByText("Resume Linear sessions");
    expect(screen.getByRole("button", { name: "Cycle" }).textContent).toContain("Cycle 12 · Active");
    expect(screen.getByRole("button", { name: "Past cycles" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Done column" })).getByText("Tickets moved here will stay in this cycle.")).toBeTruthy();
    openMenu(screen.getByRole("button", { name: "In Review column actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Configure prompt…" }));
    const prompt = await screen.findByRole("complementary", { name: "In Review prompt" });
    expect(within(prompt).getByText(/Prompts reach only tickets in the active cycle\./)).toBeTruthy();
    expect(within(prompt).getByRole("heading", { name: "Linear statuses" })).toBeTruthy();
    fireEvent.click(within(prompt).getByRole("button", { name: "Close prompt panel" }));
    const card = screen.getByRole("article", { name: /ENG-1/ });
    expect(within(card).getByText("Not synced to Linear")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Push to Linear" }));
    await waitFor(() => expect(bridge.ticketPush).toHaveBeenCalledWith({ ticketId: "t1" }));
    fireEvent.click(screen.getByRole("button", { name: "Open ENG-1: Resume Linear sessions" }));
    const panel = await screen.findByRole("complementary", { name: "Ticket ENG-1" });
    expect(within(panel).getByRole("region", { name: "Linear details" }).textContent).toContain("Team");
  });
});

describe("creating issues on an imported board", () => {
  test("+ on a Linear column asks only for a title and creates it in the viewed cycle", async () => {
    const created = { ...linearTicket(), id: "t9", externalKey: "ENG-6", title: "From the board" };
    const bridge = { ...fakeBridge({ withLinearBoard: true }), createOptions: vi.fn(), ticketCreate: vi.fn(() => ok({ ...created, warnings: [] })) };
    await mount(bridge);
    openMenu(screen.getByRole("button", { name: "Board" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Engineering · Linear" }));
    await screen.findByText("Resume Linear sessions");
    fireEvent.click(screen.getByRole("button", { name: "New ticket in In Review" }));
    const dialog = await screen.findByTestId("work-create-issue-dialog");
    expect(within(dialog).getByText("New Linear issue")).toBeTruthy();
    expect(within(dialog).queryByRole("combobox", { name: "Issue type" })).toBeNull();
    expect(within(dialog).queryByRole("combobox", { name: "Repository" })).toBeNull();
    // A Drogon-only column: Linear's default status, the card stays here.
    expect(within(dialog).getByTestId("work-create-issue-status").textContent).toContain("has no Linear status");
    expect((within(dialog).getByRole("combobox", { name: "Cycle" }) as HTMLSelectElement).value).toBe("cy-12");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "From the board" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Description" }), { target: { value: "Some **markdown**" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create in Linear" }));
    await waitFor(() =>
      expect(bridge.ticketCreate).toHaveBeenCalledWith({
        boardId: "bl",
        title: "From the board",
        columnId: "review",
        description: "Some **markdown**",
        assignToMe: true,
        sprintId: "cy-12",
      }),
    );
    expect(bridge.createOptions).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("work-create-issue-dialog")).toBeNull());
  });

  test("a GitHub Project asks which repository; none tracked yet blocks the create", async () => {
    const base = fakeBridge({ withLinearBoard: true });
    const project = { ...LINEAR_BOARD, id: "bg", provider: "github", name: "Roadmap", kind: "kanban", externalId: "project:PVT_1" };
    const board = base.board;
    let repos = ["clioo/drogon", "clioo/site"];
    const bridge = {
      ...base,
      board: vi.fn(async (input?: { boardId?: string }) => {
        const result = await board(input);
        if (!result.ok || input?.boardId !== "bl") return result;
        return { ok: true as const, result: { ...result.result, board: project, view: { ...result.result.view!, kind: "all" as const, sprint: null, sprints: [] } } };
      }),
      createOptions: vi.fn(() => ok({ provider: "github", boardId: "bg", issueTypes: [], repos })),
      ticketCreate: vi.fn(() => ok({ ...linearTicket(), provider: "github", externalKey: "clioo/site#3", warnings: ["Created with no status: refused"] })),
    };
    await mount(bridge);
    openMenu(screen.getByRole("button", { name: "Board" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Engineering · Linear" }));
    await screen.findByText("Resume Linear sessions");
    fireEvent.click(screen.getByRole("button", { name: "New ticket" }));
    let dialog = await screen.findByTestId("work-create-issue-dialog");
    const repo = (await within(dialog).findByRole("combobox", { name: "Repository" })) as HTMLSelectElement;
    await waitFor(() => expect(repo.value).toBe("clioo/drogon"));
    expect(within(dialog).queryByRole("combobox", { name: "Iteration" })).toBeNull();
    fireEvent.change(repo, { target: { value: "clioo/site" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "Site fix" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create in GitHub" }));
    await waitFor(() =>
      expect(bridge.ticketCreate).toHaveBeenCalledWith({ boardId: "bg", title: "Site fix", columnId: "review", assignToMe: true, repo: "clioo/site" }),
    );
    await waitFor(() => expect(screen.queryByTestId("work-create-issue-dialog")).toBeNull());

    repos = [];
    fireEvent.click(screen.getByRole("button", { name: "New ticket" }));
    dialog = await screen.findByTestId("work-create-issue-dialog");
    await within(dialog).findByRole("option", { name: "No repository in this project yet" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "Nowhere" } });
    expect((within(dialog).getByRole("button", { name: "Create in GitHub" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("source vocabulary", () => {
  test("names, sprint words, keys and import labels per source", () => {
    expect(providerLabel("linear")).toBe("Linear");
    expect(providerLabel("github")).toBe("GitHub");
    expect(providerLabel("gitlab")).toBe("gitlab");
    expect(sprintTerm("linear")).toBe("cycle");
    expect(sprintTerm("github")).toBe("iteration");
    expect(sprintTerm(null)).toBe("sprint");
    expect(ticketDisplayKey({ ...linearTicket(), provider: "github", externalKey: "clioo/drogon#12" })).toBe("drogon#12");
    expect(ticketDisplayKey(linearTicket())).toBe("ENG-1");
    expect(importLabel(initialSources()[2]!)).toBe("Import a GitHub project or repository");
  });
});

describe("long descriptions", () => {
  test("the panel shows and edits the whole description, never the board's excerpt", async () => {
    const whole = `${"Resume context. ".repeat(40)}The end.`;
    const excerpt = `${whole.slice(0, 280)}…`;
    const local: WorkTicket = {
      ...linearTicket(),
      id: "t9",
      key: "DRG-9",
      provider: null,
      externalKey: null,
      boardId: null,
      sync: "local",
      columnId: "todo",
      description: excerpt,
      descriptionTruncated: true,
    };
    let release: (() => void) | null = null;
    const bridge = {
      ...fakeBridge(),
      board: vi.fn(() =>
        ok({
          columns: [col({ id: "todo", name: "To do" })],
          tickets: [local],
          projects: [],
          board: LOCAL,
          boards: [LOCAL],
          view: { kind: "all" as const, readOnly: false, promptsPaused: false, sprints: [] },
        }),
      ),
      ticketShow: vi.fn(
        () =>
          new Promise<Result<WorkTicket>>((resolve) => {
            release = () => resolve({ ok: true, result: { ...local, description: whole, descriptionTruncated: false, sends: [], activity: [] } });
          }),
      ),
      ticketUpdate: vi.fn(() => ok(local)),
    };
    render(
      <TooltipProvider>
        <WorkPage bridge={bridge as unknown as WorkBridge} workspaces={[]} onOpenSession={vi.fn()} onOpenExternal={vi.fn()} listSessions={vi.fn(async () => []) as never} />
      </TooltipProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Open DRG-9/ }));
    const panel = await screen.findByRole("complementary", { name: "Ticket DRG-9" });
    const box = within(panel).getByRole("textbox", { name: "Description" }) as HTMLTextAreaElement;
    // Until the whole text arrives the excerpt is read-only: a blur saves nothing.
    expect(box.disabled).toBe(true);
    fireEvent.blur(box);
    expect(bridge.ticketUpdate).not.toHaveBeenCalled();
    await act(async () => release?.());
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.value).toBe(whole);
    fireEvent.change(box, { target: { value: `${whole} More.` } });
    fireEvent.blur(box);
    await waitFor(() => expect(bridge.ticketUpdate).toHaveBeenCalledWith({ ticketId: "t9", description: `${whole} More.` }));
  });
});

describe("GitHub without project access", () => {
  test("the import dialog lists repositories and says how to enable Projects", async () => {
    const bridge = fakeBridge();
    bridge.providerBoards.mockImplementation(() =>
      ok({
        provider: "github",
        boards: [{ id: "repo:clioo/drogon", name: "clioo/drogon issues", kind: "kanban", projectKey: "clioo/drogon", projectName: "Repository issues", importedBoardId: null }],
        warnings: ["Your GitHub login can't read Projects: it needs the read:project scope. Run `gh auth refresh -s read:project,project`."],
      }) as never,
    );
    await mount(bridge);
    fireEvent.click(within(await screen.findByTestId("work-sync-card")).getByRole("button", { name: /Import a GitHub project or repository/ }));
    const dialog = await screen.findByTestId("work-import-dialog");
    expect((await within(dialog).findByTestId("work-import-warnings")).textContent).toContain("gh auth refresh -s read:project,project");
    expect(within(dialog).getByRole("button", { name: "Choose clioo/drogon issues" })).toBeTruthy();
  });
});

describe("the import picker's filters", () => {
  test("project, status and words go to the daemon; auto-import can be turned off", async () => {
    const bridge = fakeBridge();
    bridge.providerBoards.mockImplementation((() =>
      ok({
        provider: "linear",
        boards: [{ id: "team-eng", name: "Engineering", kind: "kanban", projectKey: "ENG", projectName: "Engineering", importedBoardId: null }],
      })) as never);
    bridge.importPreview.mockImplementation(((input: { assignee?: string; project?: string; status?: string; query?: string }) =>
      ok({
        provider: "linear",
        board: { id: "team-eng", name: "Engineering", kind: "kanban" },
        columns: [{ name: "Todo", statuses: [] }],
        sprints: [],
        me: "lin-me",
        facets: {
          mine: 1,
          unassigned: 0,
          noProject: 1,
          people: [
            { id: "lin-me", name: "Jon Doe", count: 1 },
            { id: "lin-ana", name: "Ana Lopez", count: 1 },
          ],
          projects: [{ id: "Resume", name: "Resume", count: 1 }],
          statuses: [{ id: "st-todo", name: "Todo", count: 2 }],
        },
        issues: input.query === "nothing"
          ? []
          : [
              {
                id: "li-1", key: "ENG-1", url: "", title: "Resume", issueType: null, priority: null, assignee: "Jon Doe", assigneeId: "lin-me",
                project: "Resume", status: { id: "st-todo", name: "Todo", category: "new" }, sprint: null, closedSprints: [], importedTicketId: null,
              },
            ],
      })) as never);
    await mount(bridge);
    fireEvent.click(within(await screen.findByTestId("work-sync-card")).getByRole("button", { name: /Import a Linear team/ }));
    const dialog = await screen.findByTestId("work-import-dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: "Choose Engineering" }));
    const assignee = (await within(dialog).findByRole("combobox", { name: "Assigned to" })) as HTMLSelectElement;
    const options = [...assignee.options].map((o) => o.textContent);
    expect(options).toEqual(["Assigned to me (1)", "Anyone", "Unassigned (0)", "Ana Lopez (1)"]);
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Project" }), { target: { value: "none" } });
    await waitFor(() =>
      expect(bridge.importPreview).toHaveBeenLastCalledWith({ externalBoardId: "team-eng", provider: "linear", assignee: "me", open: true, project: "none" }),
    );
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Status" }), { target: { value: "st-todo" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Search issues" }), { target: { value: "nothing" } });
    await waitFor(() =>
      expect(bridge.importPreview).toHaveBeenLastCalledWith({
        externalBoardId: "team-eng",
        provider: "linear",
        assignee: "me",
        open: true,
        project: "none",
        status: "st-todo",
        query: "nothing",
      }),
    );
    expect(await within(dialog).findByText("No issues match these filters.")).toBeTruthy();
    // Finished issues are hidden by default; unticking asks for them too.
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Hide finished issues" }));
    await waitFor(() => expect(bridge.importPreview.mock.lastCall?.[0]).not.toHaveProperty("open"));
    // ENG-1 stays chosen while filtered out.
    expect(within(dialog).getByRole("button", { name: "Import 1 issue" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Keep importing new issues assigned to me" }));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Import 1 issue" }));
    });
    expect(bridge.boardImport).toHaveBeenCalledWith({
      provider: "linear",
      externalBoardId: "team-eng",
      issueKeys: ["ENG-1"],
      autoImportMine: false,
      projectId: undefined,
    });
  });

  test("the Sync menu turns importing new assigned issues on and off", async () => {
    const bridge = { ...fakeBridge({ withLinearBoard: true }), boardUpdate: vi.fn(() => ok({ ...LINEAR_BOARD, autoImportMine: true })) };
    await mount(bridge);
    openMenu(screen.getByRole("button", { name: "Board" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Engineering · Linear" }));
    await screen.findByText("Resume Linear sessions");
    openMenu(screen.getByRole("button", { name: "Sync options" }));
    const item = await screen.findByRole("menuitemcheckbox", { name: "Import new issues assigned to me" });
    expect(item.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(item);
    await waitFor(() => expect(bridge.boardUpdate).toHaveBeenCalledWith({ boardId: "bl", autoImportMine: true }));
  });
});

describe("connecting Jira in Sources", () => {
  const jira = {
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
    connect: "jira_token",
    helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    boards: 0,
  };

  test("takes the site, the email and an API token (Cloud) or a personal access token (Server)", async () => {
    const sourceConnect = vi.fn(async () => ({ ok: true as const, result: { ...jira, connected: true, account: "acme.atlassian.net", via: "token" } }));
    const onConnected = vi.fn();
    render(
      <WorkSourceConnectForm
        source={jira as never}
        bridge={{ sourceConnect } as never}
        onConnected={onConnected}
        onOpenExternal={vi.fn()}
      />,
    );
    const connect = screen.getByRole("button", { name: "Connect" });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Jira site URL"), { target: { value: " https://acme.atlassian.net " } });
    fireEvent.change(screen.getByLabelText("Jira email"), { target: { value: "me@acme.com" } });
    fireEvent.change(screen.getByLabelText("Jira API token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(sourceConnect).toHaveBeenCalledWith({
      provider: "jira",
      apiKey: "tok",
      siteUrl: "https://acme.atlassian.net",
      email: "me@acme.com",
      authType: "cloud",
    });

    fireEvent.click(screen.getByRole("button", { name: "Jira Server or Data Center?" }));
    expect(screen.queryByLabelText("Jira email")).toBeNull();
    fireEvent.change(screen.getByLabelText("Jira site URL"), { target: { value: "https://jira.corp" } });
    fireEvent.change(screen.getByLabelText("Jira personal access token"), { target: { value: "pat" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(sourceConnect).toHaveBeenLastCalledWith(expect.objectContaining({ siteUrl: "https://jira.corp", authType: "server", apiKey: "pat" })));
  });

  test("shows Jira's refusal", async () => {
    const sourceConnect = vi.fn(async () => ({ ok: false as const, error: { code: "unauthorized", message: "Jira refused the token.", retryable: false } }));
    render(<WorkSourceConnectForm source={jira as never} bridge={{ sourceConnect } as never} onConnected={vi.fn()} onOpenExternal={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Jira site URL"), { target: { value: "https://acme.atlassian.net" } });
    fireEvent.change(screen.getByLabelText("Jira email"), { target: { value: "me@acme.com" } });
    fireEvent.change(screen.getByLabelText("Jira API token"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Jira refused the token.");
  });
});
