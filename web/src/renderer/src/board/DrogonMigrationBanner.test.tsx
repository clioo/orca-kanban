// @vitest-environment jsdom
// The offer to bring a Drogon board over: shown once there is one to bring,
// gone once brought or dismissed; asking before replacing tickets.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DrogonMigrationBanner, MIGRATION_DISMISSED_KEY } from "./DrogonMigrationBanner";
import type { Rpc } from "./board-rpc";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from "sonner";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const status = (over: object = {}) => ({ drogonDataDir: "/Users/x/Library/Application Support/Drogon", drogonTickets: 130, drogonBoards: 1, migrated: null, ...over });

function mount(answers: Record<string, unknown[]>) {
  const rpc = vi.fn<Rpc>(async (method) => {
    const next = answers[method]?.shift();
    return (next ?? { ok: false, error: { code: "x", message: "unexpected", retryable: false } }) as never;
  });
  const onMigrated = vi.fn();
  render(<DrogonMigrationBanner rpc={rpc} onMigrated={onMigrated} />);
  return { rpc, onMigrated };
}

describe("DrogonMigrationBanner", () => {
  test("offers the Drogon board and brings it over", async () => {
    const { rpc, onMigrated } = mount({
      "board.migration_status": [{ ok: true, result: status() }],
      "board.migrate_from_drogon": [{ ok: true, result: { tickets: 130, boards: 1, unmappedProjects: ["/Users/x/geeky"] } }],
    });
    await screen.findByText(/Drogon has a Work board with 130 tickets and 1 imported boards/);
    fireEvent.click(screen.getByRole("button", { name: "Bring my Drogon board" }));
    await waitFor(() => expect(onMigrated).toHaveBeenCalled());
    expect(rpc).toHaveBeenCalledWith("board.migrate_from_drogon", {});
    expect(vi.mocked(toast.success).mock.calls[0]![0]).toContain("Add these folders to Orca to work in them again: /Users/x/geeky");
    expect(screen.queryByRole("region", { name: "Bring your Drogon board" })).toBeNull();
  });

  test("asks before replacing this board's tickets", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { rpc } = mount({
      "board.migration_status": [{ ok: true, result: status() }],
      "board.migrate_from_drogon": [
        { ok: false, error: { code: "invalid_argument", message: "this board already has 3 tickets; pass replace to overwrite them", retryable: false } },
        { ok: true, result: { tickets: 130, boards: 1, unmappedProjects: [] } },
      ],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Bring my Drogon board" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("board.migrate_from_drogon", { replace: true }));
    expect(confirm).toHaveBeenCalled();
  });

  test("stays away once brought, without a Drogon board, or once dismissed", async () => {
    mount({ "board.migration_status": [{ ok: true, result: status({ migrated: { tickets: 3, unmappedProjects: [] } }) }] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("region", { name: "Bring your Drogon board" })).toBeNull();
    cleanup();
    mount({ "board.migration_status": [{ ok: true, result: status({ drogonDataDir: null }) }] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("region", { name: "Bring your Drogon board" })).toBeNull();
    cleanup();
    mount({ "board.migration_status": [{ ok: true, result: status() }] });
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(localStorage.getItem(MIGRATION_DISMISSED_KEY)).toBe("1");
    expect(screen.queryByRole("region", { name: "Bring your Drogon board" })).toBeNull();
  });
});
