// Sessions a ticket can link, read one workspace at a time: a host-wide
// list outgrows the daemon's one-reply limit once a workspace has piled up
// history (a Bot's scheduled runs), and a workspace that cannot be read
// must not hide the others.
import type { Session } from "../../../../shared/session-contract";

/** What the ticket panel's picker lists: the sessions and, when known, how
 *  many workspaces could not be listed. */
export type LinkCandidates = Session[] | { sessions: Session[]; unreadable: number };

export type SessionsReply = {
  ok: boolean;
  result?: { sessions: Session[] };
  error?: { message: string };
};

/** Every listed session of `workspaceIds`, live ones first (each group in
 *  listed order), and how many workspaces could not be read. Throws only
 *  when none could. */
export async function listWorkspaceSessions(
  workspaceIds: string[],
  read: (workspaceId: string) => Promise<SessionsReply | undefined>,
): Promise<{ sessions: Session[]; unreadable: number }> {
  const replies = await Promise.all(
    workspaceIds.map(async (id) => {
      try {
        const reply = await read(id);
        return reply?.ok && reply.result
          ? { sessions: reply.result.sessions }
          : { error: reply?.error?.message };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  const read_ = replies.filter(
    (r): r is { sessions: Session[] } => "sessions" in r,
  );
  const failed = replies.filter(
    (r): r is { error: string | undefined } => "error" in r,
  );
  if (workspaceIds.length > 0 && read_.length === 0) {
    throw new Error(failed[0]?.error ?? "Sessions are unavailable.");
  }
  const all = read_.flatMap((r) => r.sessions);
  return {
    sessions: [
      ...all.filter((s) => s.verdict === "live"),
      ...all.filter((s) => s.verdict !== "live"),
    ],
    unreadable: failed.length,
  };
}

/** "Sessions of 1 workspace could not be listed." */
export function unreadableNotice(count: number): string {
  return `Sessions of ${count} ${count === 1 ? "workspace" : "workspaces"} could not be listed.`;
}
