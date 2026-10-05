#!/usr/bin/env node
// A stand-in for the `orca` CLI the Work board service calls, for engine
// tests: the same `--json` envelopes and fields as Orca 1.4, over a state
// file at $ORCA_USER_DATA_PATH/fake-orca.json that tests read and edit.
// Terminals record the command they were created with and every line sent
// to them; nothing is executed.
//
//   repo list · worktree list · worktree ps · worktree create
//   terminal list · terminal create · terminal send · terminal switch
//   rpc <method> <json>: the runtime methods the board reaches through
//   Orca's own client (projectGroup.list, folderWorkspace.create/list).
//
// Folder projects are `projectGroups` ({id, name, parentPath}) and their
// folder workspaces `folderWorkspaces` ({id, projectGroupId, name,
// folderPath, isArchived}); `worktree ps` lists those as `folder:<id>`,
// as Orca does. `"noRuntime": true` makes every rpc call fail.
//
// A state with `"failing": true` answers every call with an error, like an
// Orca that cannot be reached.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const statePath = join(process.env.ORCA_USER_DATA_PATH ?? ".", "fake-orca.json");
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { repos: [], worktrees: [], terminals: [], agents: {}, calls: [], counter: 0 };
state.terminals ??= [];
state.projectGroups ??= [];
state.folderWorkspaces ??= [];
state.agents ??= {};
state.calls ??= [];

const BOOLEAN = new Set(["json", "enter", "focus", "activate"]);
const argv = process.argv.slice(2);
const words = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg.startsWith("--")) {
    const name = arg.slice(2);
    if (BOOLEAN.has(name)) flags[name] = true;
    else flags[name] = argv[++i];
  } else words.push(arg);
}
const command = words.join(" ");
state.calls.push({ command, flags });

function save() {
  writeFileSync(statePath, JSON.stringify(state, null, 1));
}
function reply(result) {
  save();
  process.stdout.write(JSON.stringify({ id: "fake", ok: true, result }) + "\n");
  process.exit(0);
}
function fail(code, message) {
  save();
  process.stdout.write(JSON.stringify({ id: "fake", ok: false, error: { code, message } }) + "\n");
  process.exit(1);
}
const selected = (selector, prefix = "id:") => (selector?.startsWith(prefix) ? selector.slice(prefix.length) : selector);
const AGENTS = { claude: "claude", codex: "codex", opencode: "opencode", pi: "pi", agy: "antigravity" };

if (state.failing) fail("runtime_unavailable", "Orca is not running");

const folderWorkspaceIds = () => state.folderWorkspaces.map((f) => `folder:${f.id}`);
const agentsIn = (worktreeId) =>
  state.terminals
    .filter((t) => t.live && t.worktreeId === worktreeId && state.agents[`${t.tabId}:${t.leafId}`])
    .map((t) => ({ paneKey: `${t.tabId}:${t.leafId}`, ...state.agents[`${t.tabId}:${t.leafId}`] }));

if (words[0] === "rpc") {
  const method = words[1];
  const params = words[2] ? JSON.parse(words[2]) : {};
  state.calls[state.calls.length - 1] = { command: `rpc ${method}`, flags: params };
  if (state.noRuntime) fail("unsupported", "no runtime client");
  switch (method) {
    case "projectGroup.list":
      reply({ groups: state.projectGroups });
    case "folderWorkspace.list":
      reply({ folderWorkspaces: state.folderWorkspaces });
    case "folderWorkspace.create": {
      const group = state.projectGroups.find((g) => g.id === params.projectGroupId);
      if (!group) fail("invalid_argument", "Folder-backed project group not found.");
      state.counter = (state.counter ?? 0) + 1;
      const folderWorkspace = {
        id: `fw-${state.counter}`,
        projectGroupId: group.id,
        name: params.name ?? "Workspace",
        folderPath: group.parentPath,
        isArchived: false,
        createdAt: Date.now(),
      };
      state.folderWorkspaces.push(folderWorkspace);
      reply({ folderWorkspace });
    }
    default:
      fail("method_not_found", `Unknown method: ${method}`);
  }
}

switch (command) {
  case "repo list":
    reply({ repos: state.repos });
  case "worktree list":
    reply({ worktrees: state.worktrees, totalCount: state.worktrees.length, truncated: false });
  case "worktree ps":
    reply({
      worktrees: [
        ...state.worktrees.map((w) => ({ workspaceKind: "git", worktreeId: w.id, agents: agentsIn(w.id) })),
        ...state.folderWorkspaces.map((f) => {
          const group = state.projectGroups.find((g) => g.id === f.projectGroupId);
          return {
            workspaceKind: "folder-workspace",
            worktreeId: `folder:${f.id}`,
            repoId: `folder-workspace:${f.projectGroupId}`,
            repo: group?.name ?? "",
            path: f.folderPath,
            displayName: f.name,
            isArchived: f.isArchived === true,
            createdAt: f.createdAt ?? 0,
            agents: agentsIn(`folder:${f.id}`),
          };
        }),
      ],
    });
  case "worktree create": {
    const repo = state.repos.find((r) => r.id === selected(flags.repo));
    if (!repo) fail("selector_not_found", "selector_not_found");
    const path = `${repo.path}-worktrees/${flags.name}`;
    // Like git: a branch/folder that exists (even archived) is refused.
    if (state.worktrees.some((w) => w.path === path)) fail("invalid_argument", `A worktree named ${flags.name} already exists`);
    const worktree = {
      id: `${repo.id}::${path}`,
      repoId: repo.id,
      path,
      displayName: flags.name,
      comment: flags.comment ?? "",
      isMainWorktree: false,
      isArchived: false,
      createdAt: Date.now(),
    };
    state.worktrees.push(worktree);
    reply({ worktree });
  }
  case "terminal list":
    reply({ terminals: state.terminals.filter((t) => t.live).map(({ inputs, command, live, ...t }) => t) });
  case "terminal create": {
    const worktreeId = selected(flags.worktree);
    if (!state.worktrees.some((w) => w.id === worktreeId) && !folderWorkspaceIds().includes(worktreeId)) fail("selector_not_found", "selector_not_found");
    state.counter = (state.counter ?? 0) + 1;
    const n = state.counter;
    const terminal = {
      handle: `term_${String(n).padStart(4, "0")}`,
      worktreeId,
      title: flags.title ?? null,
      tabId: `tab-${n}`,
      leafId: `leaf-${n}`,
      lastOutputAt: Date.now(),
      command: flags.command ?? "",
      inputs: [],
      live: true,
    };
    state.terminals.push(terminal);
    const first = (flags.command ?? "").trim().split(/\s+/)[0]?.replace(/^'|'$/g, "").split("/").pop();
    if (AGENTS[first]) state.agents[`${terminal.tabId}:${terminal.leafId}`] = { state: "working", agentType: AGENTS[first], prompt: "", updatedAt: Date.now() };
    reply({ terminal: { handle: terminal.handle, tabId: terminal.tabId, worktreeId, title: terminal.title, surface: "visible" } });
  }
  case "terminal send": {
    const terminal = state.terminals.find((t) => t.handle === flags.terminal && t.live);
    if (!terminal) fail("terminal_not_found", `terminal ${flags.terminal} is not live`);
    terminal.inputs.push(flags.text + (flags.enter ? "\n" : ""));
    reply({ send: { handle: terminal.handle, accepted: true, bytesWritten: flags.text.length } });
  }
  case "terminal switch": {
    const terminal = state.terminals.find((t) => t.handle === flags.terminal && t.live);
    if (!terminal) fail("terminal_not_found", `terminal ${flags.terminal} is not live`);
    state.focused = terminal.handle;
    reply({ focus: { handle: terminal.handle, tabId: terminal.tabId, worktreeId: terminal.worktreeId } });
  }
  default:
    fail("invalid_argument", `Unknown command: ${command}`);
}
