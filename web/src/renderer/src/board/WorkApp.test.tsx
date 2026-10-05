// @vitest-environment jsdom
// The page around the board: Orca's worktrees for the pickers, Orca's live
// terminals as link candidates, and opening a session brings its terminal
// to the front in Orca.
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { installRadixJsdomStubs } from "../components/ui/radix-jsdom-stubs";
import type { Rpc } from "./board-rpc";

const page = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("../features/work/WorkPage", () => ({
  WorkPage: (props: Record<string, unknown>) => {
    page.props = props;
    return <div data-testid="work-page" />;
  },
}));
import { WorkApp } from "./WorkApp";

beforeAll(() => installRadixJsdomStubs());
afterEach(() => cleanup());

describe("WorkApp", () => {
  test("wires Orca's worktrees, terminals and focus into the board", async () => {
    const rpc = vi.fn<Rpc>(async (method) => {
      switch (method) {
        case "orca.workspaces":
          return { ok: true, result: { workspaces: [{ id: "r::/p", name: "Drogon · main" }] } };
        case "orca.sessions":
          return { ok: true, result: { sessions: [{ id: "term_1", verdict: "live" }] } };
        case "orca.session_focus":
          return { ok: true, result: { focused: "term_1" } };
        case "board.migration_status":
          return { ok: true, result: { drogonDataDir: null, drogonTickets: 0, drogonBoards: 0, migrated: null } };
        default:
          return { ok: false, error: { code: "x", message: method, retryable: false } };
      }
    });
    render(<WorkApp rpc={rpc} />);
    await screen.findByTestId("work-page");
    await waitFor(() => expect(page.props?.workspaces).toEqual([{ id: "r::/p", name: "Drogon · main" }]));
    const sessions = await (page.props!.listSessions as () => Promise<unknown[]>)();
    expect(sessions).toEqual([{ id: "term_1", verdict: "live" }]);
    (page.props!.onOpenSession as (t: object) => void)({ workspaceId: "r::/p", sessionId: "term_1" });
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("orca.session_focus", { sessionId: "term_1" }));
  });
});
