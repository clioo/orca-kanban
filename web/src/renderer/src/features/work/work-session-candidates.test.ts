// Linkable sessions read one workspace at a time.
import { describe, expect, test, vi } from "vitest";
import type { Session } from "../../../../shared/session-contract";
import {
  listWorkspaceSessions,
  unreadableNotice,
  type SessionsReply,
} from "./work-session-candidates";

const session = (id: string, workspaceId: string, verdict: string) =>
  ({ id, workspaceId, verdict }) as unknown as Session;
const ok = (sessions: Session[]): SessionsReply => ({
  ok: true,
  result: { sessions },
});

describe("listWorkspaceSessions", () => {
  test("reads each workspace and puts live sessions first, each group in listed order", async () => {
    const read = vi.fn(async (id: string) =>
      id === "a"
        ? ok([session("a-old", "a", "exited"), session("a-live", "a", "live")])
        : ok([
            session("b-live", "b", "live"),
            session("b-gone", "b", "unverifiable"),
          ]),
    );
    const { sessions, unreadable } = await listWorkspaceSessions(
      ["a", "b"],
      read,
    );
    expect(read.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
    expect(sessions.map((s) => s.id)).toEqual([
      "a-live",
      "b-live",
      "a-old",
      "b-gone",
    ]);
    expect(unreadable).toBe(0);
  });

  test("a workspace that cannot be read (a refusal, a throw, no reply) leaves the others listed", async () => {
    const read = vi.fn(
      async (id: string): Promise<SessionsReply | undefined> => {
        if (id === "big")
          return {
            ok: false,
            error: { message: "the reply (1.8 MB) is over the 1 MB limit" },
          };
        if (id === "boom") throw new Error("socket closed");
        if (id === "none") return undefined;
        return ok([session("s", id, "live")]);
      },
    );
    const { sessions, unreadable } = await listWorkspaceSessions(
      ["big", "fine", "boom", "none"],
      read,
    );
    expect(sessions.map((s) => s.id)).toEqual(["s"]);
    expect(unreadable).toBe(3);
  });

  test("throws the first reason only when no workspace could be read; none asked reads empty", async () => {
    const read = vi.fn(async (): Promise<SessionsReply> => ({
      ok: false,
      error: { message: "over the 1 MB limit" },
    }));
    await expect(listWorkspaceSessions(["a", "b"], read)).rejects.toThrow(
      "over the 1 MB limit",
    );
    await expect(
      listWorkspaceSessions(["a"], async () => undefined),
    ).rejects.toThrow("Sessions are unavailable.");
    await expect(listWorkspaceSessions([], read)).resolves.toEqual({
      sessions: [],
      unreadable: 0,
    });
  });
});

test("unreadableNotice counts workspaces", () => {
  expect(unreadableNotice(1)).toBe(
    "Sessions of 1 workspace could not be listed.",
  );
  expect(unreadableNotice(2)).toBe(
    "Sessions of 2 workspaces could not be listed.",
  );
});
