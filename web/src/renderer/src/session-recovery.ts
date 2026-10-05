// Pure session-recovery helpers for the V2 terminal surface. Encodes the
// AGENTS.md liveness rule at the UI layer: loss of contact is unverifiable,
// never exited; the execution host owns processes, so the renderer never
// auto-respawns and never fabricates a successful retry — a failed refresh
// keeps the unverifiable verdict and the error text.

import type {
  Result,
  Session,
  Verdict,
} from "../../shared/session-contract";

/**
 * R16-AL2 (issue #228): Settings → Terminal kills/closes sessions through
 * the daemon without App's tab handlers, and `close` forgets the record —
 * the strip only drops those tabs on its next session list. The settings
 * pane dispatches this (same renderer window, no IPC) and App bumps its
 * revision, the same lever the notification-focus path uses.
 */
export const SESSIONS_INVALIDATE_EVENT = "drogon:sessions-invalidate";

export type RecoveryAction =
  | { kind: "none" }
  | { kind: "retry-connection" }
  | { kind: "reveal-output+offer-new" };

/**
 * Maps a session verdict to the recovery affordance the tab may offer.
 * - live: nothing to recover.
 * - unverifiable: the transport lost contact (or a read failed) — offer the
 *   existing refresh/reconnect path; this is never proof of exit.
 * - exited: a confirmed close removes the tab, so an exit is "expected" only
 *   in that already-handled flow; an unexpectedly-exited session keeps its
 *   output visible and gets an explicit New terminal offer. Never auto-respawn.
 */
export function recoveryActionFor(
  verdict: Verdict,
  context: { exitExpected: boolean },
): RecoveryAction {
  if (verdict === "live") return { kind: "none" };
  if (verdict === "unverifiable") return { kind: "retry-connection" };
  return context.exitExpected
    ? { kind: "none" }
    : { kind: "reveal-output+offer-new" };
}

/**
 * Tab label during transport loss: keeps the exact session identity visible
 * so the user can confirm the recovered tab is the same id/incarnation (the
 * audit expectation: tab count retained, refresh recovers the same identity).
 * Live and exited tabs keep their plain label.
 */
export function recoveryTabLabel(input: {
  label: string;
  verdict: Verdict;
  id: string;
  incarnation: string;
}): string {
  if (input.verdict !== "unverifiable") return input.label;
  return `${input.label} · ${input.id}:${input.incarnation}`;
}

/** The retry affordance is inert while a refresh is already in flight. */
export function retryAffordanceDisabled(input: {
  refreshInFlight: boolean;
}): boolean {
  return input.refreshInFlight;
}

/**
 * Identity of a session incarnation for the recovery offer: the
 * incarnation is part of the key so a dismissal recorded against a
 * superseded incarnation can never hide the offer on the session that
 * replaced it.
 */
export function recoveryOfferKey(input: {
  id: string;
  incarnation: string;
}): string {
  return `${input.id}:${input.incarnation}`;
}

/**
 * Whether the pane shows the recovery overlay for an `unverifiable`
 * session. The verdict is the daemon's own statement that THIS instance
 * holds no child for the id (a held, running child always reports
 * `live`), so a session is offered the fork's recovery overlay (Restart /
 * Close) as soon as the connection is up and the user has not dismissed
 * this incarnation's offer. Waiting for an explicit Retry click — the
 * pre-fix behaviour — left the owner's dead session as a blank pane with
 * a cursor that looked live; the offer is the honest, non-blank state.
 * While the connection is down the reconnect banner owns the state (loss
 * of contact is never rewritten as exited), and the overlay never asserts
 * an exit.
 */
export function showRecoveryOverlay(input: {
  verdict: Verdict;
  connected: boolean;
  offerKey: string;
  dismissedKey: string | null;
}): boolean {
  return (
    input.verdict === "unverifiable" &&
    input.connected &&
    input.dismissedKey !== input.offerKey
  );
}

/**
 * R16-AL2 (issue #228): validates the service's reply to an explicit,
 * user-initiated `session.close` for the exact session being dismissed.
 * The reply is accepted for ANY honest verdict — `exited` after a
 * confirmed kill, `unverifiable` for a forgotten post-restart stub (loss
 * of contact is never rewritten as exit, and the user — not the liveness
 * oracle — decided to close) — and rejected on any identity mismatch so a
 * dismissal is never recorded against the wrong session.
 */
export function assertCloseReplyFor(
  result: Session,
  target: Session,
): Session {
  if (
    result.id !== target.id ||
    result.incarnation !== target.incarnation ||
    result.hostId !== target.hostId
  )
    throw new Error("The service's response was not for this session.");
  return result;
}

/**
 * Confirms a tab-close result for the exact session the user dismissed.
 * `not_found` is also conclusive: another Drogon client already closed and
 * forgot that identity, so the renderer must drop its stale tab instead of
 * surfacing an error. A reused id with a new incarnation is reported by the
 * daemon as `stale_incarnation` and remains an error, never a blind close.
 */
export function confirmCloseOrAlreadyAbsent(
  result: Result<Session>,
  target: Session,
): "closed" | "already-absent" {
  if (!result.ok) {
    if (result.error.code === "not_found") return "already-absent";
    throw new Error(result.error.message);
  }
  assertCloseReplyFor(result.result, target);
  return "closed";
}

/**
 * Whether a session with this verdict can re-attach when the daemon
 * connection returns. Live and unverifiable sessions keep their tab and
 * scrollback and resume polling; a positively-exited session never comes
 * back, so the daemon banner must not cover its exit overlay — loss of
 * contact is unverifiable, never exited, and a confirmed exit stays final.
 */
export function isRecoverableAfterReconnect(verdict: Verdict): boolean {
  return verdict === "live" || verdict === "unverifiable";
}
