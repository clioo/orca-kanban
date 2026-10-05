// @vitest-environment jsdom
// The import dialog's board picker, mounted alone against a recording fake
// bridge: a filter by name or project (every word, Enter picks a lone
// match) and "Recommended for you" — the boards holding your open issues,
// most first — above the rest.
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { installRadixJsdomStubs } from "../../components/ui/radix-jsdom-stubs";
import { TooltipProvider } from "../../components/ui/tooltip";
import type { Result } from "../../../../shared/session-contract";
import type { WorkBridge, WorkSource } from "../../../../shared/work-contract";
import { WorkImportDialog } from "./WorkImportDialog";

beforeAll(() => installRadixJsdomStubs());
afterEach(() => cleanup());

const ok = <T,>(result: T): Promise<Result<T>> =>
  Promise.resolve({ ok: true, result });

const LINEAR: WorkSource = {
  id: "linear",
  name: "Linear",
  enabled: true,
  connected: true,
  account: null,
  via: "token",
  apiUrl: null,
  error: null,
  boardTerm: "team",
  sprintTerm: "cycle",
  connect: "api_key",
  helpUrl: null,
  boards: 0,
};

function team(
  id: string,
  name: string,
  key: string | null,
  assignedOpen?: number,
  assignedInProject?: number,
) {
  return {
    id,
    name,
    kind: "kanban",
    projectKey: key,
    projectName: name,
    importedBoardId: null,
    ...(assignedOpen === undefined ? {} : { assignedOpen }),
    ...(assignedInProject === undefined ? {} : { assignedInProject }),
  };
}

function mount(boards: ReturnType<typeof team>[]) {
  const bridge = {
    providerBoards: vi.fn(() => ok({ provider: "linear", boards })),
    // Never answers: the test only watches which board was asked for.
    importPreview: vi.fn(() => new Promise(() => {})),
  };
  render(
    <TooltipProvider>
      <WorkImportDialog
        open
        bridge={bridge as unknown as WorkBridge}
        source={LINEAR}
        projects={[]}
        onClose={vi.fn()}
        onImported={vi.fn()}
        onOpenExternal={vi.fn()}
      />
    </TooltipProvider>,
  );
  return bridge;
}

const chooseNames = (region: HTMLElement) =>
  within(region)
    .getAllByRole("button", { name: /^Choose / })
    .map((b) => b.getAttribute("aria-label"));

describe("board picker", () => {
  test("recommends the teams holding your open issues, most first, above the rest", async () => {
    mount([
      team("team-web", "Web Platform", "WEB", 0),
      team("team-eng", "Engineering", "ENG", 2),
      team("team-ops", "Operations", "OPS", 5),
      team("team-data", "Data Science", "DS"),
    ]);
    const dialog = await screen.findByTestId("work-import-dialog");
    const recommended = await within(dialog).findByRole("region", {
      name: "Recommended for you",
    });
    expect(chooseNames(recommended)).toEqual([
      "Choose Operations",
      "Choose Engineering",
    ]);
    expect(within(recommended).getByText("5 assigned to you")).toBeTruthy();
    expect(within(recommended).getByText("2 assigned to you")).toBeTruthy();
    const all = within(dialog).getByRole("region", { name: "All teams" });
    expect(chooseNames(all)).toEqual([
      "Choose Web Platform",
      "Choose Data Science",
    ]);
    expect(within(all).queryByText(/assigned to you/)).toBeNull();
  });

  test("a project's views stay out once one board holds your issues; a project-only board says so", async () => {
    mount([
      team("ft-person", "Fintech Scrum Board - By Person", "FT", 0, 63),
      team("ft-billing", "Fintech Billing Scrum Board", "FT", 5, 63),
      team("ft-team", "Fintech Scrum Board - By Team", "FT", 0, 63),
      team("ops", "Ops Reliability", "OPS", 0, 3),
    ]);
    const dialog = await screen.findByTestId("work-import-dialog");
    const recommended = await within(dialog).findByRole("region", {
      name: "Recommended for you",
    });
    expect(chooseNames(recommended)).toEqual([
      "Choose Fintech Billing Scrum Board",
      "Choose Ops Reliability",
    ]);
    expect(within(recommended).getByText("5 assigned to you")).toBeTruthy();
    expect(
      within(recommended).getByText("3 in OPS assigned to you"),
    ).toBeTruthy();
    const all = within(dialog).getByRole("region", { name: "All teams" });
    expect(chooseNames(all)).toEqual([
      "Choose Fintech Scrum Board - By Person",
      "Choose Fintech Scrum Board - By Team",
    ]);
    expect(within(all).queryByText(/assigned to you/)).toBeNull();
  });

  test("more than five recommendations show five until Show all; a filter shows every match", async () => {
    mount(
      Array.from({ length: 7 }, (_, i) =>
        team(`t${i}`, `Team ${i}`, `K${i}`, 7 - i),
      ),
    );
    const dialog = await screen.findByTestId("work-import-dialog");
    const recommended = await within(dialog).findByRole("region", {
      name: "Recommended for you",
    });
    expect(within(recommended).getByText("7")).toBeTruthy();
    expect(chooseNames(recommended)).toEqual([
      "Choose Team 0",
      "Choose Team 1",
      "Choose Team 2",
      "Choose Team 3",
      "Choose Team 4",
    ]);
    fireEvent.click(
      within(recommended).getByRole("button", { name: "Show all 7" }),
    );
    expect(chooseNames(recommended)).toHaveLength(7);
    fireEvent.click(
      within(recommended).getByRole("button", { name: "Show fewer" }),
    );
    expect(chooseNames(recommended)).toHaveLength(5);
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "Filter teams" }),
      { target: { value: "team" } },
    );
    const filtered = within(dialog).getByRole("region", {
      name: "Recommended for you",
    });
    expect(chooseNames(filtered)).toHaveLength(7);
    expect(
      within(filtered).queryByRole("button", { name: /Show all|Show fewer/ }),
    ).toBeNull();
  });

  test("filters by name or project key, says when nothing matches, and Enter picks a lone match", async () => {
    const bridge = mount([
      team("team-web", "Web Platform", "WEB", 0),
      team("team-ops", "Operations", "OPS", 5),
      team("team-data", "Data Science", "DS"),
    ]);
    const dialog = await screen.findByTestId("work-import-dialog");
    const filter = await within(dialog).findByRole("textbox", {
      name: "Filter teams",
    });

    fireEvent.change(filter, { target: { value: "ds" } });
    expect(
      within(dialog).queryByRole("region", { name: "Recommended for you" }),
    ).toBeNull();
    expect(chooseNames(dialog)).toEqual(["Choose Data Science"]);

    fireEvent.change(filter, { target: { value: "nothing like it" } });
    expect(
      within(dialog).getByText("No teams match “nothing like it”."),
    ).toBeTruthy();
    expect(
      within(dialog).queryAllByRole("button", { name: /^Choose / }),
    ).toHaveLength(0);

    fireEvent.change(filter, { target: { value: "operat" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    await waitFor(() =>
      expect(bridge.importPreview).toHaveBeenCalledWith(
        expect.objectContaining({
          externalBoardId: "team-ops",
          provider: "linear",
        }),
      ),
    );
  });

  test("Enter does nothing while several boards still show; without counts there are no groups", async () => {
    const bridge = mount([team("one", "One", null), team("two", "Two", null)]);
    const dialog = await screen.findByTestId("work-import-dialog");
    const filter = await within(dialog).findByRole("textbox", {
      name: "Filter teams",
    });
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(bridge.importPreview).not.toHaveBeenCalled();
    expect(chooseNames(dialog)).toEqual(["Choose One", "Choose Two"]);
    expect(
      within(dialog).queryByRole("region", { name: "Recommended for you" }),
    ).toBeNull();
    expect(within(dialog).queryByText(/^All teams/)).toBeNull();
  });

  test("reopening the dialog starts with an empty filter", async () => {
    const boards = [team("one", "One", null), team("two", "Two", null)];
    const bridge = {
      providerBoards: vi.fn(() => ok({ provider: "linear", boards })),
      importPreview: vi.fn(() => new Promise(() => {})),
    };
    const dialog = (open: boolean) => (
      <TooltipProvider>
        <WorkImportDialog
          open={open}
          bridge={bridge as unknown as WorkBridge}
          source={LINEAR}
          projects={[]}
          onClose={vi.fn()}
          onImported={vi.fn()}
          onOpenExternal={vi.fn()}
        />
      </TooltipProvider>
    );
    const { rerender } = render(dialog(true));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Filter teams" }),
      { target: { value: "one" } },
    );
    expect(screen.queryByRole("button", { name: "Choose Two" })).toBeNull();
    rerender(dialog(false));
    rerender(dialog(true));
    const filter = await screen.findByRole("textbox", { name: "Filter teams" });
    expect((filter as HTMLInputElement).value).toBe("");
    expect(
      await screen.findByRole("button", { name: "Choose Two" }),
    ).toBeTruthy();
  });

  test("an account with no boards says so and shows no filter", async () => {
    mount([]);
    const dialog = await screen.findByTestId("work-import-dialog");
    expect(
      await within(dialog).findByText(
        "Linear has no teams this account can see.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("textbox", { name: "Filter teams" }),
    ).toBeNull();
  });

  test("a sprint board opens with only the active sprint's issues chosen, and says so", async () => {
    const JIRA: WorkSource = {
      ...LINEAR,
      id: "jira",
      name: "Jira",
      boardTerm: "board",
      sprintTerm: "sprint",
      connect: "tasks",
    };
    const sprint = (id: string, name: string, state: string) => ({
      id,
      name,
      state,
      start: null,
      end: null,
      goal: null,
    });
    const todo = { id: "1", name: "To Do", category: "new" };
    const mine = (key: string, inSprint: ReturnType<typeof sprint> | null) => ({
      id: key,
      key,
      url: `http://jira.local/browse/${key}`,
      title: key,
      issueType: "Story",
      priority: null,
      assignee: "Carlos",
      assigneeId: "me",
      status: todo,
      sprint: inSprint,
      closedSprints: [],
      importedTicketId: null,
    });
    const active = sprint("20", "S20", "active");
    const next = sprint("21", "S21", "future");
    const bridge = {
      providerBoards: vi.fn(),
      importPreview: vi.fn(() =>
        ok({
          provider: "jira",
          me: "me",
          board: { id: "7", name: "L&C Scrum Board", kind: "scrum" },
          columns: [{ name: "To Do" }],
          sprints: [active, next],
          issues: [
            mine("FT-1", active),
            mine("FT-2", active),
            mine("FT-3", next),
            mine("FT-4", null),
          ],
          facets: {
            mine: 4,
            finished: 0,
            unassigned: 0,
            noProject: 0,
            people: [],
            projects: [],
            statuses: [],
          },
        }),
      ),
    };
    render(
      <TooltipProvider>
        <WorkImportDialog
          open
          bridge={bridge as unknown as WorkBridge}
          source={JIRA}
          projects={[]}
          initialBoard={{ externalId: "7" }}
          onClose={vi.fn()}
          onImported={vi.fn()}
          onOpenExternal={vi.fn()}
        />
      </TooltipProvider>,
    );
    const dialog = await screen.findByTestId("work-import-dialog");
    const checked = (key: string) =>
      within(dialog)
        .getByRole("checkbox", { name: `Import ${key}` })
        .getAttribute("aria-checked");
    await within(dialog).findByRole("checkbox", { name: "Import FT-1" });
    expect([
      checked("FT-1"),
      checked("FT-2"),
      checked("FT-3"),
      checked("FT-4"),
    ]).toEqual(["true", "true", "false", "false"]);
    expect(
      within(dialog).getByRole("button", { name: "Import 2 issues" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        /^Yours in the active sprint are chosen; pick more or filter to add others\./,
      ),
    ).toBeTruthy();
    // Finished issues start hidden.
    expect(bridge.importPreview).toHaveBeenCalledWith(
      expect.objectContaining({ open: true }),
    );
  });
});
