// @vitest-environment jsdom
// The ticket panel's session picker, mounted alone: the sessions it offers
// and, when some workspaces could not be listed, a note beside it.
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { installRadixJsdomStubs } from "../../components/ui/radix-jsdom-stubs";
import { TooltipProvider } from "../../components/ui/tooltip";
import type { Session } from "../../../../shared/session-contract";
import type {
  WorkBoard,
  WorkBridge,
  WorkTicket,
} from "../../../../shared/work-contract";
import { WorkTicketPanel } from "./WorkTicketPanel";

beforeAll(() => installRadixJsdomStubs());
afterEach(() => cleanup());

const TICKET = {
  id: "t1",
  key: "DRG-1",
  title: "Link me",
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
  sessions: [
    {
      id: "linked",
      workspaceId: "ws-1",
      harnessId: "claude",
      verdict: "live",
      incarnation: "i",
    },
  ],
} as unknown as WorkTicket;

const BOARD = {
  columns: [
    { id: "todo", name: "To do", icon: "todo", position: 0, ticketCount: 1 },
  ],
  tickets: [TICKET],
  projects: [{ id: "p1", name: "Drogon" }],
} as unknown as WorkBoard;

const session = (id: string, workspaceId: string) =>
  ({
    id,
    workspaceId,
    harnessId: "claude",
    verdict: "live",
    incarnation: "i",
  }) as unknown as Session;

function mount(
  listSessions: () => Promise<
    Session[] | { sessions: Session[]; unreadable: number }
  >,
) {
  const bridge = { ticketShow: vi.fn(() => new Promise(() => {})) };
  render(
    <TooltipProvider>
      <WorkTicketPanel
        ticket={TICKET}
        board={BOARD}
        state={{ run: vi.fn() } as never}
        bridge={bridge as unknown as WorkBridge}
        workspaces={[
          { id: "ws-1", name: "Drogon" },
          { id: "ws-2", name: "Zillow" },
        ]}
        listLinkCandidates={listSessions}
        syncHandlers={{} as never}
        onOpenSession={vi.fn()}
        onOpenExternal={vi.fn()}
        onClose={vi.fn()}
        onNotice={vi.fn()}
      />
    </TooltipProvider>,
  );
}

async function openPicker() {
  fireEvent.click(screen.getByRole("tab", { name: "sessions" }));
  fireEvent.click(screen.getByRole("button", { name: /Link a session/ }));
  return screen.findByRole("combobox", { name: "Session to link" });
}

describe("session picker", () => {
  test("says beside the picker how many workspaces could not be listed", async () => {
    mount(async () => ({
      sessions: [session("linked", "ws-1"), session("other", "ws-2")],
      unreadable: 2,
    }));
    const picker = await openPicker();
    // The linked session is not offered again.
    expect(
      within(picker)
        .getAllByRole("option")
        .map((o) => o.getAttribute("value")),
    ).toEqual(["", "other"]);
    expect(screen.getByRole("status").textContent).toBe(
      "Sessions of 2 workspaces could not be listed.",
    );
  });

  test("says nothing when every workspace was listed, or the list is a plain array", async () => {
    mount(async () => ({
      sessions: [session("other", "ws-2")],
      unreadable: 0,
    }));
    await openPicker();
    expect(screen.queryByText(/could not be listed/)).toBeNull();
    cleanup();
    mount(async () => [session("other", "ws-2")]);
    const picker = await openPicker();
    expect(within(picker).getAllByRole("option")).toHaveLength(2);
    expect(screen.queryByText(/could not be listed/)).toBeNull();
  });
});

describe("description", () => {
  test("Show all expands a long description into its own scroll, so the tabs stay reachable", async () => {
    const long = Array.from(
      { length: 40 },
      (_, i) => `Line ${i + 1} of the acceptance criteria.`,
    ).join("\n\n");
    const imported = {
      ...TICKET,
      externalKey: "FT-18787",
      provider: "jira",
      description: long,
    } as unknown as WorkTicket;
    const bridge = { ticketShow: vi.fn(() => new Promise(() => {})) };
    render(
      <TooltipProvider>
        <WorkTicketPanel
          ticket={imported}
          board={BOARD}
          state={{ run: vi.fn() } as never}
          bridge={bridge as unknown as WorkBridge}
          workspaces={[]}
          listLinkCandidates={async () => []}
          syncHandlers={{} as never}
          onOpenSession={vi.fn()}
          onOpenExternal={vi.fn()}
          onClose={vi.fn()}
          onNotice={vi.fn()}
        />
      </TooltipProvider>,
    );
    const description = screen.getByTestId("work-panel-description");
    expect(description.className).toContain("max-h-32");
    expect(description.className).toContain("overflow-hidden");
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(description.className).toContain("overflow-y-auto");
    expect(description.className).toMatch(/max-h-\[45vh\]/);
    expect(screen.getByRole("tab", { name: "details" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(description.className).toContain("max-h-32");
  });
});
