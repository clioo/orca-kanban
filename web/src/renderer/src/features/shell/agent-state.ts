import type { AgentState, Session } from "../../../../shared/session-contract";

/**
 * Agent-state vocabulary for the shell (journey J1). The contract's five
 * states render as-is; nothing is invented — an unreported state stays
 * `unknown`.
 */
export type AgentIconKind =
  | "working"
  | "idle"
  | "needs-input"
  | "exited"
  | "unknown";

/** Maps a contract state to its shell icon kind (1:1, no invention). */
export function agentIconKind(state: AgentState): AgentIconKind {
  switch (state) {
    case "working":
      return "working";
    case "idle":
      return "idle";
    case "needs_input":
      return "needs-input";
    case "exited":
      return "exited";
    case "unknown":
      return "unknown";
  }
}

/**
 * Accessible label shared by the tab badge and the card dot — the fork's
 * `agentStateLabel` (AgentStateDot.tsx) verbatim for the four mapped states;
 * `exited` has no fork equivalent (a Drogon-only verdict) and keeps its own
 * label. The tooltip copy is the same string.
 */
export function agentStateLabel(state: AgentState): string {
  switch (state) {
    case "working":
      return "Working";
    case "idle":
      return "Idle";
    case "needs_input":
      return "Waiting for input";
    case "exited":
      return "Exited";
    case "unknown":
      return "No recent update";
  }
}

/** Renders `session.agentState ?? "unknown"`; never invents a state. */
export function agentStateOf(session: Session): AgentState {
  return sessionDotState(session);
}

/**
 * The agent-activity state every shell surface reads (rows, card sentence,
 * tab badge, summary pill). `working`/`idle` render only on hook proof
 * (`agentStateAuthority === "hook"`): the harness's own hook lifecycle is
 * the only thing that proves a turn. A daemon predating the authority
 * field can carry `working` for a harness-less shell — or a launched
 * session's idle repaint — from PTY output alone, so old wire without
 * proof reads `unknown` here, never Working, never a manufactured Idle.
 * A quiet activity clock behind `idle` (`"activity"` or absent) is not
 * proof of idleness either: the turn is simply unknown. `needs_input`
 * (hook wait signals only, on every daemon generation), `exited` and
 * `unknown` pass through; the `unverifiable` rule in `sessionDotState`
 * still applies first.
 */
export function sessionAgentState(session: Session): AgentState {
  const state = sessionDotState(session);
  if (
    (state === "working" || state === "idle") &&
    session.agentStateAuthority !== "hook"
  )
    return "unknown";
  return state;
}

/**
 * The raw wire extraction: `session.agentState ?? "unknown"`, plus the
 * `unverifiable` rule (the daemon holds no child for that id, so a
 * `working`/`idle` state is history, never a live claim — those two map to
 * `unknown`; `needs_input`/`exited` keep their meaning). UI surfaces read
 * `sessionAgentState`, not this; this stays for wire-faithful needs only.
 */
export function sessionDotState(session: Session): AgentState {
  const state = session.agentState ?? "unknown";
  if (
    session.verdict === "unverifiable" &&
    (state === "working" || state === "idle")
  )
    return "unknown";
  return state;
}
