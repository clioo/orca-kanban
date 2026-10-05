// @vitest-environment jsdom
// The Work page against a recording fake bridge: the board renders the
// daemon's columns and tickets, a drag calls ticket move with the target
// column and index, the column panel saves its triggers and sends, and a
// ticket's session opens in one click (a live one directly, one that is no
// longer running through sessionOpen first).
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { installRadixJsdomStubs } from "../../components/ui/radix-jsdom-stubs";
import type { Result } from "../../../../shared/session-contract";
import type {
  WorkBoard,
  WorkBridge,
  WorkColumn,
  WorkTicket,
} from "../../../../shared/work-contract";
import { columnDropIndex, resetWorkViewMemoryForTests, WorkPage } from "./WorkPage";
import { TooltipProvider } from "../../components/ui/tooltip";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

beforeAll(() => installRadixJsdomStubs());
afterEach(() => {
  cleanup();
  resetWorkViewMemoryForTests();
});

function column(overrides: Partial<WorkColumn>): WorkColumn {
  return {
    id: "col",
    name: "Column",
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

function ticket(overrides: Partial<WorkTicket>): WorkTicket {
  return {
    id: "t",
    key: "DRG-1",
    title: "Ticket",
    description: "",
    projectId: "p1",
    projectName: "Drogon",
    workspaceId: "ws-1",
    columnId: "todo",
    position: 0,
    prUrl: null,
    prNumber: null,
    sourceUrl: null,
    nextStep: "",
    createdAt: 1,
    updatedAt: 1,
    sessions: [],
    ...overrides,
  };
}

function boardFixture(): WorkBoard {
  return {
    columns: [
      column({ id: "todo", name: "To do", icon: "todo", position: 0, ticketCount: 1 }),
      column({ id: "prog", name: "In progress", icon: "in_progress", position: 1 }),
      column({
        id: "review",
        name: "Review",
        icon: "review",
        position: 2,
        sendOnEnter: true,
        prWatch: true,
        cron: "*/15 * * * *",
        message: "Review {ticket.pr} for {ticket.id}",
        ticketCount: 1,
        lastSentAt: Date.now(),
        lastSentCount: 3,
      }),
    ],
    tickets: [
      ticket({ id: "t1", key: "DRG-41", title: "Plan the personal workspace", columnId: "todo" }),
      ticket({
        id: "t2",
        key: "DRG-42",
        title: "Improve Jira resume",
        columnId: "review",
        prNumber: 648,
        prUrl: "https://github.com/clioo/drogon/pull/648",
        sourceUrl: "https://jira.example.com/browse/DRG-9",
        nextStep: "Choose the demo scope",
        sessions: [
          { id: "live-1", workspaceId: "ws-1", harnessId: "claude", verdict: "live", agentState: "working", agentStateAuthority: "hook", incarnation: "i1" },
          { id: "gone-2", workspaceId: "ws-2", harnessId: "pi", verdict: "exited", incarnation: "i2" },
        ],
      }),
    ],
    projects: [{ id: "p1", name: "Drogon" }],
  };
}

const ok = <T,>(result: T): Promise<Result<T>> => Promise.resolve({ ok: true, result });

function fakeBridge(board = boardFixture()) {
  const current = board;
  const bridge = {
    board: vi.fn(() => ok(current)),
    ticketShow: vi.fn((input: { ticketId: string }) =>
      ok({ ...current.tickets.find((t) => t.id === input.ticketId)!, sends: [], activity: [] }),
    ),
    sends: vi.fn(() => ok({ sends: [] })),
    preview: vi.fn(() =>
      ok({
        columnId: "review",
        previews: [
          {
            ticketId: "t2",
            ticketKey: "DRG-42",
            message: "Review PR #648 for DRG-42",
            recipients: [{ sessionId: "live-1", action: "send" }],
          },
        ],
      }),
    ),
    columnCreate: vi.fn((input: { name: string }) => ok(column({ id: "new", name: input.name }))),
    // Updates land in the board the next reload returns, like the daemon.
    columnUpdate: vi.fn((input: { columnId: string } & Partial<WorkColumn>) => {
      const index = current.columns.findIndex((c) => c.id === input.columnId);
      const { columnId: _id, ...patch } = input;
      current.columns[index] = { ...current.columns[index], ...patch };
      return ok(current.columns[index]);
    }),
    columnDelete: vi.fn(() => ok({ deleted: "x", movedTickets: 0 })),
    columnSend: vi.fn(() =>
      ok({
        columnId: "review",
        sends: [
          {
            ticketId: "t2",
            ticketKey: "DRG-42",
            columnId: "review",
            trigger: "manual",
            message: "m",
            results: [{ sessionId: "live-1", action: "sent" as const }],
            at: 1,
          },
        ],
      }),
    ),
    ticketCreate: vi.fn((input: { title: string }) =>
      ok(ticket({ id: "t9", key: "DRG-43", title: input.title })),
    ),
    ticketUpdate: vi.fn(() => ok(current.tickets[1])),
    ticketMove: vi.fn((input: { ticketId: string }) =>
      ok({ ...current.tickets.find((t) => t.id === input.ticketId)!, delivery: null }),
    ),
    ticketDelete: vi.fn(() => ok({ deleted: "t1", key: "DRG-41" })),
    linkSession: vi.fn(() => ok(current.tickets[1])),
    unlinkSession: vi.fn(() => ok(current.tickets[1])),
    sessionOpen: vi.fn(() =>
      ok({ action: "resumed" as const, session: { id: "resumed-3", workspaceId: "ws-2", verdict: "live" } }),
    ),
  };
  return bridge;
}

async function mount(bridge = fakeBridge(), onOpenSession = vi.fn(), listSessions: () => Promise<unknown[]> = vi.fn(async () => [])) {
  const view = render(
    <TooltipProvider>
    <WorkPage
      bridge={bridge as unknown as WorkBridge}
      workspaces={[
        { id: "ws-1", name: "issue-621" },
        { id: "ws-2", name: "issue-623" },
      ]}
      onOpenSession={onOpenSession}
      onOpenExternal={vi.fn()}
      listSessions={listSessions as never}
    />
    </TooltipProvider>,
  );
  await screen.findByText("Improve Jira resume");
  return { view, bridge, onOpenSession, listSessions };
}

function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
  fireEvent.click(trigger);
}

describe("Work board", () => {
  test("renders columns with their counts, triggers and ticket cards", async () => {
    await mount();
    const review = screen.getByRole("region", { name: "Review column" });
    expect(within(review).getByText("On enter · PR watch · every 15 min")).toBeTruthy();
    expect(within(review).getByLabelText("1 tickets")).toBeTruthy();
    const card = within(review).getByRole("article", { name: "DRG-42 Improve Jira resume" });
    expect(within(card).getByText("PR #648")).toBeTruthy();
    expect(within(card).getByText("2 linked sessions")).toBeTruthy();
    expect(within(card).getByText("Next: Choose the demo scope")).toBeTruthy();
    expect(within(card).getByRole("img", { name: "Agent working" })).toBeTruthy();
    const todo = screen.getByRole("region", { name: "To do column" });
    expect(within(todo).getByText("0 sessions")).toBeTruthy();
    expect(within(todo).getByText("Drogon")).toBeTruthy();
  });

  test("dragging a ticket onto another column moves it there", async () => {
    const { bridge } = await mount();
    const card = screen.getByRole("article", { name: "DRG-41 Plan the personal workspace" });
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
    expect(screen.getByTestId("work-drop-indicator")).toBeTruthy();
    fireEvent.drop(target, { dataTransfer, clientY: 10_000 });
    await waitFor(() =>
      expect(bridge.ticketMove).toHaveBeenCalledWith({ ticketId: "t1", columnId: "review", index: 1 }),
    );
  });

  test("dragging a column by its header drops it on the side of the column it is released over", async () => {
    const { bridge } = await mount();
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
    const region = (name: string) => {
      const el = screen.getByRole("region", { name: `${name} column` });
      // jsdom lays nothing out: give each column a 200px-wide box.
      el.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, height: 600, right: 200, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
      return el;
    };
    // jsdom's drag events carry no pointer position; set it on the event.
    const drag = (kind: "dragOver" | "drop", el: HTMLElement, clientX: number) => {
      const event = createEvent[kind](el, { dataTransfer });
      Object.defineProperty(event, "clientX", { value: clientX });
      fireEvent(el, event);
    };
    const header = within(region("Review")).getByTestId("work-column-header");
    expect(header.getAttribute("draggable")).toBe("true");
    fireEvent.dragStart(header, { dataTransfer });
    // Over the left half of To do: lands before it.
    const target = region("To do");
    drag("dragOver", target, 40);
    expect(target.className).toContain("inset_2px");
    drag("dragOver", target, 160);
    expect(target.className).toContain("inset_-2px");
    drag("drop", target, 40);
    await waitFor(() => expect(bridge.columnUpdate).toHaveBeenCalledWith({ columnId: "review", index: 0 }));
    expect(target.className).not.toContain("inset_");
    // A column is not a ticket: nothing moved.
    expect(bridge.ticketMove).not.toHaveBeenCalled();
    // The right half of To do puts it between To do and In progress.
    fireEvent.dragStart(header, { dataTransfer });
    drag("drop", region("To do"), 160);
    await waitFor(() => expect(bridge.columnUpdate).toHaveBeenLastCalledWith({ columnId: "review", index: 1 }));
    // Released on its own place, it stays put.
    bridge.columnUpdate.mockClear();
    fireEvent.dragStart(header, { dataTransfer });
    drag("drop", region("Review"), 40);
    drag("drop", region("In progress"), 160);
    expect(bridge.columnUpdate).not.toHaveBeenCalled();
  });

  test("a collapsed column also shows where a dragged column lands", async () => {
    const board = boardFixture();
    board.columns = board.columns.map((c) => (c.id === "prog" ? { ...c, collapsed: true } : c));
    const { bridge } = await mount(fakeBridge(board));
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
    const strip = screen.getByRole("region", { name: "In progress column" });
    expect(strip.getAttribute("data-collapsed")).toBe("true");
    strip.getBoundingClientRect = () => ({ left: 0, width: 44, top: 0, height: 600, right: 44, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.dragStart(within(screen.getByRole("region", { name: "Review column" })).getByTestId("work-column-header"), { dataTransfer });
    const over = createEvent.dragOver(strip, { dataTransfer });
    Object.defineProperty(over, "clientX", { value: 10 });
    fireEvent(strip, over);
    expect(strip.className).toContain("inset_2px");
    const drop = createEvent.drop(strip, { dataTransfer });
    Object.defineProperty(drop, "clientX", { value: 10 });
    fireEvent(strip, drop);
    await waitFor(() => expect(bridge.columnUpdate).toHaveBeenCalledWith({ columnId: "review", index: 1 }));
  });

  test("dragging near the board's edge scrolls it after a short delay and stops away from the edge", async () => {
    const { bridge } = await mount();
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
    const board = screen.getByTestId("work-board");
    board.getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
    const over = (clientX: number, types = dataTransfer) => {
      const event = createEvent.dragOver(board, { dataTransfer: types });
      Object.defineProperty(event, "clientX", { value: clientX });
      fireEvent(board, event);
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      fireEvent.dragStart(within(screen.getByRole("region", { name: "To do column" })).getByTestId("work-column-header"), { dataTransfer });
      over(995);
      // Passing over the edge does not scroll yet.
      act(() => vi.advanceTimersByTime(100));
      expect(board.scrollLeft).toBe(0);
      act(() => vi.advanceTimersByTime(200));
      const moved = board.scrollLeft;
      expect(moved).toBeGreaterThan(0);
      act(() => vi.advanceTimersByTime(100));
      expect(board.scrollLeft).toBeGreaterThan(moved);
      // Back in the middle: it stops.
      over(500);
      const stopped = board.scrollLeft;
      act(() => vi.advanceTimersByTime(500));
      expect(board.scrollLeft).toBe(stopped);
      // Near the start it scrolls back; a drop ends it.
      over(5);
      act(() => vi.advanceTimersByTime(400));
      expect(board.scrollLeft).toBeLessThan(stopped);
      fireEvent.drop(board, { dataTransfer });
      const dropped = board.scrollLeft;
      act(() => vi.advanceTimersByTime(500));
      expect(board.scrollLeft).toBe(dropped);
      // Something dragged in from outside (a file, text) never scrolls it.
      const file = { ...dataTransfer, types: ["Files"] };
      board.scrollLeft = 0;
      over(995, file as never);
      act(() => vi.advanceTimersByTime(500));
      expect(board.scrollLeft).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(bridge.columnUpdate).not.toHaveBeenCalled();
  });

  test("dragging a card near a column's bottom edge scrolls its list", async () => {
    await mount();
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
    const card = screen.getByRole("article", { name: "DRG-41 Plan the personal workspace" });
    const list = card.closest("[class*='overflow-y-auto']") as HTMLElement;
    list.getBoundingClientRect = () => ({ left: 0, width: 272, top: 100, height: 400, right: 272, bottom: 500, x: 0, y: 100, toJSON: () => ({}) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      fireEvent.dragStart(card, { dataTransfer });
      const event = createEvent.dragOver(list, { dataTransfer });
      Object.defineProperty(event, "clientY", { value: 495 });
      fireEvent(list, event);
      act(() => vi.advanceTimersByTime(400));
      expect(list.scrollTop).toBeGreaterThan(0);
      fireEvent(window, new Event("dragend"));
      const ended = list.scrollTop;
      act(() => vi.advanceTimersByTime(400));
      expect(list.scrollTop).toBe(ended);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a long column name is shown whole, wrapping instead of truncating", async () => {
    await mount();
    const title = within(screen.getByRole("region", { name: "Review column" })).getByRole("heading", { name: "Review" });
    expect(title.className).toContain("break-words");
    expect(title.className).not.toContain("truncate");
  });

  test("the card menu moves a ticket without dragging", async () => {
    const { bridge } = await mount();
    openMenu(screen.getByRole("button", { name: "DRG-41 actions" }));
    const moveTo = await screen.findByRole("menuitem", { name: "Move to" });
    fireEvent.keyDown(moveTo, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Review/ }));
    await waitFor(() =>
      expect(bridge.ticketMove).toHaveBeenCalledWith({ ticketId: "t1", columnId: "review", index: undefined }),
    );
  });

  test("the column prompt panel saves triggers, previews and sends", async () => {
    const { bridge } = await mount();
    openMenu(screen.getByRole("button", { name: "In progress column actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Configure prompt…" }));
    const panel = await screen.findByRole("complementary", { name: "In progress prompt" });
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Ticket enters In progress" }));
    await waitFor(() =>
      expect(bridge.columnUpdate).toHaveBeenCalledWith({ columnId: "prog", sendOnEnter: true }),
    );
    fireEvent.click(within(panel).getByRole("checkbox", { name: "On a schedule" }));
    await waitFor(() =>
      expect(bridge.columnUpdate).toHaveBeenCalledWith({ columnId: "prog", cron: "*/15 * * * *" }),
    );
    fireEvent.change(within(panel).getByRole("combobox", { name: "Recipients" }), { target: { value: "primary" } });
    await waitFor(() =>
      expect(bridge.columnUpdate).toHaveBeenCalledWith({ columnId: "prog", recipients: "primary" }),
    );
    fireEvent.change(within(panel).getByRole("combobox", { name: "Harness for new sessions" }), { target: { value: "pi" } });
    await waitFor(() => expect(bridge.columnUpdate).toHaveBeenCalledWith({ columnId: "prog", harnessId: "pi" }));

    // The Review panel: the message is saved before Send now uses it.
    fireEvent.click(within(panel).getByRole("button", { name: "Close prompt panel" }));
    openMenu(screen.getByRole("button", { name: "Review column actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Configure prompt…" }));
    const review = await screen.findByRole("complementary", { name: "Review prompt" });
    expect(within(review).getByTestId("work-column-last-sent").textContent).toMatch(/Last sent .* · 3 sessions/);
    const message = within(review).getByRole("textbox", { name: "Message to sessions" });
    fireEvent.change(message, { target: { value: "Check {ticket.id} now" } });
    fireEvent.click(within(review).getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(bridge.columnUpdate).toHaveBeenCalledWith({ columnId: "review", message: "Check {ticket.id} now" }),
    );
    expect(await within(review).findByText("Review PR #648 for DRG-42")).toBeTruthy();
    // The saved message coming back from the daemon does not clear the
    // preview it produced, nor the draft.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(within(review).getByTestId("work-column-preview")).toBeTruthy();
    expect((message as HTMLTextAreaElement).value).toBe("Check {ticket.id} now");
    fireEvent.click(within(review).getByRole("button", { name: "Send now" }));
    await waitFor(() => expect(bridge.columnSend).toHaveBeenCalledWith({ columnId: "review" }));
  });

  test("a live session on a ticket opens directly in its workspace", async () => {
    const { onOpenSession, bridge } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Open DRG-42: Improve Jira resume" }));
    const panel = await screen.findByRole("complementary", { name: "Ticket DRG-42" });
    fireEvent.click(within(panel).getByRole("button", { name: /Open Claude Code session live-1/ }));
    expect(onOpenSession).toHaveBeenCalledWith({ workspaceId: "ws-1", sessionId: "live-1" });
    expect(bridge.sessionOpen).not.toHaveBeenCalled();
  });

  test("a session that is no longer running is resumed first, then opened", async () => {
    const { onOpenSession, bridge } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Open DRG-42: Improve Jira resume" }));
    const panel = await screen.findByRole("complementary", { name: "Ticket DRG-42" });
    expect(within(panel).getByText("Exited")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: /Open Pi session gone-2/ }));
    await waitFor(() =>
      expect(bridge.sessionOpen).toHaveBeenCalledWith({ ticketId: "t2", sessionId: "gone-2" }),
    );
    await waitFor(() =>
      expect(onOpenSession).toHaveBeenCalledWith({ workspaceId: "ws-2", sessionId: "resumed-3" }),
    );
  });

  test("Link a session reads each workspace; one too big to list leaves the others and says so", async () => {
    const sessions = vi.fn(async (workspaceId?: string) =>
      workspaceId === "ws-1"
        ? { ok: false, error: { message: "the reply (1.8 MB) is over the 1 MB limit of one answer; narrow the request" } }
        : { ok: true, result: { sessions: [{ id: "other-9", workspaceId: "ws-2", harnessId: "claude", verdict: "live", incarnation: "i" }] } },
    );
    (window as unknown as { drogon?: unknown }).drogon = { sessions };
    try {
      render(
        <TooltipProvider>
          <WorkPage
            bridge={fakeBridge() as unknown as WorkBridge}
            workspaces={[
              { id: "ws-1", name: "issue-621" },
              { id: "ws-2", name: "issue-623" },
            ]}
            onOpenSession={vi.fn()}
            onOpenExternal={vi.fn()}
          />
        </TooltipProvider>,
      );
      await screen.findByText("Improve Jira resume");
      fireEvent.click(screen.getByRole("button", { name: "Open DRG-42: Improve Jira resume" }));
      const panel = await screen.findByRole("complementary", { name: "Ticket DRG-42" });
      fireEvent.click(within(panel).getByRole("tab", { name: "sessions" }));
      fireEvent.click(within(panel).getByRole("button", { name: /Link a session/ }));
      const picker = await within(panel).findByRole("combobox", { name: "Session to link" });
      // Never one host-wide list: each workspace on its own.
      expect(sessions.mock.calls.map((c) => c[0]).sort()).toEqual(["ws-1", "ws-2"]);
      expect(within(picker).getAllByRole("option").map((o) => o.getAttribute("value"))).toEqual(["", "other-9"]);
      // Said beside the picker, not in a toast that goes away.
      expect(within(panel).getByRole("status").textContent).toBe("Sessions of 1 workspace could not be listed.");
    } finally {
      delete (window as unknown as { drogon?: unknown }).drogon;
    }
  });

  test("New column picks its icon from the real icons, suggested by the name until you choose", async () => {
    const { bridge } = await mount();
    fireEvent.click(screen.getAllByRole("button", { name: "New column" })[0]!);
    const form = await screen.findByRole("form", { name: "New column" });
    const icons = within(form).getByRole("radiogroup", { name: "Icon" });
    const checked = () =>
      within(icons)
        .getAllByRole("radio")
        .filter((r) => r.getAttribute("aria-checked") === "true")
        .map((r) => r.getAttribute("aria-label"));
    expect(within(icons).getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual([
      "Backlog",
      "Todo",
      "In progress",
      "Review",
      "Qa",
      "Done",
      "Blocked",
    ]);
    expect(checked()).toEqual(["Todo"]);
    const name = within(form).getByRole("textbox", { name: "Column name" });
    fireEvent.change(name, { target: { value: "Code Review" } });
    expect(checked()).toEqual(["Review"]);
    // A choice of yours sticks while the name changes.
    fireEvent.click(within(icons).getByRole("radio", { name: "Qa" }));
    fireEvent.change(name, { target: { value: "Code Review 2" } });
    expect(checked()).toEqual(["Qa"]);
    // Arrow keys move the choice like any radio group.
    fireEvent.keyDown(within(icons).getByRole("radio", { name: "Qa" }), { key: "ArrowRight" });
    expect(checked()).toEqual(["Done"]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Done");
    fireEvent.keyDown(within(icons).getByRole("radio", { name: "Backlog" }), { key: "ArrowLeft" });
    expect(checked()).toEqual(["Blocked"]);
    fireEvent.click(within(form).getByRole("button", { name: "Add column" }));
    await waitFor(() =>
      expect(bridge.columnCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Code Review 2", icon: "blocked" })),
    );
  });

  test("a column's Icon submenu names each icon in words", async () => {
    const { bridge } = await mount();
    openMenu(screen.getByRole("button", { name: "Review column actions" }));
    const sub = await screen.findByRole("menuitem", { name: "Icon" });
    fireEvent.keyDown(sub, { key: "ArrowRight" });
    const item = await screen.findByRole("menuitem", { name: "In progress" });
    expect(screen.getByRole("menuitem", { name: "Blocked" })).toBeTruthy();
    fireEvent.click(item);
    await waitFor(() => expect(bridge.columnUpdate).toHaveBeenCalledWith({ columnId: "review", icon: "in_progress" }));
  });

  test("a reopened New column dialog starts empty, its icon following the name again", async () => {
    await mount();
    fireEvent.click(screen.getAllByRole("button", { name: "New column" })[0]!);
    let form = await screen.findByRole("form", { name: "New column" });
    fireEvent.change(within(form).getByRole("textbox", { name: "Column name" }), { target: { value: "Doing" } });
    fireEvent.click(within(form).getByRole("radio", { name: "Qa" }));
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "New column" })).toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: "New column" })[0]!);
    form = await screen.findByRole("form", { name: "New column" });
    const name = within(form).getByRole("textbox", { name: "Column name" }) as HTMLInputElement;
    expect(name.value).toBe("");
    fireEvent.change(name, { target: { value: "Done" } });
    expect(within(form).getByRole("radio", { name: "Done" }).getAttribute("aria-checked")).toBe("true");
  });

  test("the ticket panel links a session and edits fields", async () => {
    const listSessions = vi.fn(async () => [
      { id: "live-1", workspaceId: "ws-1", harnessId: "claude", verdict: "live" },
      { id: "other-9", workspaceId: "ws-2", harnessId: "claude", verdict: "live" },
    ]);
    const { bridge } = await mount(fakeBridge(), vi.fn(), listSessions);
    fireEvent.click(screen.getByRole("button", { name: "Open DRG-42: Improve Jira resume" }));
    const panel = await screen.findByRole("complementary", { name: "Ticket DRG-42" });
    fireEvent.click(within(panel).getByRole("tab", { name: "sessions" }));
    fireEvent.click(within(panel).getByRole("button", { name: /Link a session/ }));
    const picker = await within(panel).findByRole("combobox", { name: "Session to link" });
    // Every workspace listed: nothing to say beside the picker.
    expect(within(panel).queryByText(/could not be listed/)).toBeNull();
    // Already-linked sessions are not offered again.
    expect(within(picker).queryByText(/issue-621/)).toBeNull();
    fireEvent.change(picker, { target: { value: "other-9" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Link" }));
    await waitFor(() =>
      expect(bridge.linkSession).toHaveBeenCalledWith({ ticketId: "t2", sessionId: "other-9" }),
    );
    fireEvent.click(within(panel).getByRole("tab", { name: "details" }));
    const next = within(panel).getByRole("textbox", { name: "Next step" });
    fireEvent.change(next, { target: { value: "Ship it" } });
    fireEvent.blur(next);
    await waitFor(() =>
      expect(bridge.ticketUpdate).toHaveBeenCalledWith({ ticketId: "t2", nextStep: "Ship it" }),
    );
    fireEvent.change(within(panel).getByRole("combobox", { name: "Column" }), { target: { value: "prog" } });
    await waitFor(() =>
      expect(bridge.ticketMove).toHaveBeenCalledWith({ ticketId: "t2", columnId: "prog" }),
    );
    openMenu(within(panel).getByRole("button", { name: "Session live-1 actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unlink from ticket" }));
    await waitFor(() =>
      expect(bridge.unlinkSession).toHaveBeenCalledWith({ ticketId: "t2", sessionId: "live-1" }),
    );
  });

  test("New ticket creates the ticket in the chosen column and opens it", async () => {
    const { bridge } = await mount();
    fireEvent.click(screen.getByRole("button", { name: "New ticket in In progress" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "Prepare client demo" } });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Project" }), { target: { value: "p1" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Source link" }), {
      target: { value: "https://linear.app/x/issue/WM-18" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Create ticket" }));
    });
    expect(bridge.ticketCreate).toHaveBeenCalledWith({
      title: "Prepare client demo",
      columnId: "prog",
      projectId: "p1",
      workspaceId: undefined,
      prUrl: undefined,
      sourceUrl: "https://linear.app/x/issue/WM-18",
      description: undefined,
    });
  });

  test("search, filter, list and sources views", async () => {
    await mount();
    fireEvent.change(screen.getByRole("textbox", { name: "Search work" }), { target: { value: "jira" } });
    expect(screen.queryByText("Plan the personal workspace")).toBeNull();
    expect(screen.getByText("Improve Jira resume")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Search work" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("tab", { name: "list" }));
    const table = screen.getByRole("table", { name: "Tickets" });
    expect(within(table).getByText("DRG-41")).toBeTruthy();
    expect(within(table).getByText("#648")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "sources" }));
    const jira = screen.getByRole("region", { name: "Jira sources" });
    expect(within(jira).getByText("Improve Jira resume")).toBeTruthy();
    expect(screen.getByTestId("work-sources").textContent).toContain("1 ticket has no source link.");
  });

  test("the open panel and tab survive the page remounting", async () => {
    const first = await mount();
    fireEvent.click(screen.getByRole("button", { name: "Open DRG-42: Improve Jira resume" }));
    await screen.findByRole("complementary", { name: "Ticket DRG-42" });
    first.view.unmount();
    await mount();
    expect(await screen.findByRole("complementary", { name: "Ticket DRG-42" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "list" }));
    cleanup();
    await mount().catch(() => {});
    expect(screen.getByRole("tab", { name: "list" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("columnDropIndex", () => {
  test("lands before or after the target, accounting for the column leaving its place", () => {
    // Moving right: the column's old place closes up.
    expect(columnDropIndex(0, 2, "after")).toBe(2);
    expect(columnDropIndex(0, 2, "before")).toBe(1);
    // Moving left.
    expect(columnDropIndex(7, 4, "after")).toBe(5);
    expect(columnDropIndex(7, 0, "before")).toBe(0);
    // Its own place, either side of itself or of a neighbour it already touches.
    expect(columnDropIndex(3, 3, "before")).toBeNull();
    expect(columnDropIndex(3, 3, "after")).toBeNull();
    expect(columnDropIndex(3, 2, "after")).toBeNull();
    expect(columnDropIndex(3, 4, "before")).toBeNull();
  });
});
