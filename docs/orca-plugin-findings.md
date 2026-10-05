# Spike: the Work board as an Orca plugin + service

Validated on Orca 1.4.209 (macOS arm64), in an isolated windowless Orca
(`tests/e2e/isolated-orca.sh`: own HOME and userData, `--use-mock-keychain`,
clean PATH). The agent was a shell fixture that emits Claude Code's hook
events; no model ran.

| # | Question | Result |
|---|----------|--------|
| 1 | Resume a stopped agent session | Yes. The board picks the id (`claude --session-id <uuid>`) and relaunches with `orca terminal create --command "claude --resume <uuid>"`; the conversation continues in the same transcript. |
| 2 | Know when an agent is working or waiting | Yes. `orca worktree ps --json` → `agents[].state` goes `done → working → done` with the prompt, about 1 s behind. The plugin event `agent.status.changed` carries `{worktreeId, paneKey, state}`; `paneKey` is `tabId:leafId` from `orca terminal show`. `terminal wait --for tui-idle` does not detect a non-TUI fixture, but it is not needed. |
| 3 | Ticket ↔ terminal link survives an Orca restart | Yes. The terminal handle and the agent process survive a normal quit (Orca's daemon keeps them); send and state tracking work after restart. The tab title is lost (the board keeps its own names) and the terminal reads `orphaned` until `terminal switch` adopts it. |
| 4 | UI in Orca's embedded browser | Yes. `orca tab create --url http://127.0.0.1:<port>` loads the page, its JS runs, and `orca terminal switch` opens a linked session. |
| 5 | Bundled native binary runs after Orca installs the plugin | Yes. Installs go to `<userData>/plugins/<publisher.id>/<contentHash>/` (plus `current`); the exec bit is kept, there is no quarantine attribute, and the ad-hoc signature verifies. Limits: 50 MB, 2000 files. |
| 6 | Service outlives the reaped worker | Yes. The worker was reaped about 5 min after its last use; the service (spawned `detached`, own process group) kept serving, reparented to launchd. A new worker reuses it via `plugins-data/<key>/service.json`. |
| 7 | Disable/remove stops the service | Yes. `deactivate()` also runs on idle reap, so the service watches its own signals: plugin root gone (remove) or `pluginSystemEnabled:false` / key in `disabledPlugins` in `<userData>/profiles/*/orca-data.json` (disable). Measured: it stopped within about 1 s in both cases, with no orphans left. |

## Constraints the design must respect

- Orca's plugin system is experimental (`pluginApi: 1`, "no compatibility promises") and **off by default** (`pluginSystemEnabled: false`); the user enables it in Settings → Plugins.
- Panels are sandboxed iframes with a strict CSP and only three actions (`workspace.readContext`, `terminal.sendText`, `notifications.show`), so the board UI lives in a browser tab, not a panel.
- The worker is short-lived: commands and the three events only, a 30 s invoke timeout, and reaping after 5 idle minutes.
- Disable detection reads Orca's internal settings file (`orca-data.json`), and update detection must follow `current`; both are internal formats to re-check on every Orca update.
- Terminals inherit the developer's real HOME and login-shell PATH even in an isolated Orca. Agents must be launched by absolute path in tests, and fixtures must write only inside the test directory.
- A force-killed Orca leaves `Singleton*` and `orca-runtime.json` behind and the next start stays in `starting`; a normal quit does not.
- A plugin update with unchanged capabilities keeps the user's consent; the previous version dir stays for rollback.
