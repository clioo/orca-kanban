/* MIT Copyright (c) 2026 Lovecast Inc. Ported from Orca's
   src/shared/tab-title-resolution.ts (resolveTerminalTabTitle: a custom
   rename wins and live process titles never become the tab label) and
   src/renderer/src/store/slices/tabs/tabs-create-actions.ts (new
   terminals are labeled `Terminal ${existingTabs.length + 1}`).
   Adapter: Drogon sessions carry no live PTY title or agent-title feed,
   so the strip resolves custom rename (tab-order.ts resolveTabTitle)
   over this stable "Terminal N" default; the shell process name stays on
   the session-details surface, never the tab. Numbering is the 1-based
   position among session tabs in strip order, so labels stay dense
   ("Terminal 1", "Terminal 2", ...) after closes. */

/** Default label for a terminal tab: "Terminal 1", "Terminal 2", ... */
export function defaultTerminalTabTitle(index: number): string {
  return `Terminal ${index}`;
}
