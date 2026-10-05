// Work board acceptance against a REAL Orca (the installed Orca.app), run
// isolated: its own HOME and user data, no window, never brought to the
// front. Agents are shell fixtures (tests/fixtures/fake-agent.sh) that emit
// Claude Code's hook events and record every launch and prompt under the
// isolated HOME; Jira, Linear and GitHub are the fake servers on 127.0.0.1.
// No model runs, and nothing touches the developer's Orca or HOME.
//
// It proves, stage by stage:
//  1. The plugin installs through Orca's plugin flow; "Open Work board"
//     opens the board in an Orca browser tab (and reuses it).
//  2. Agents: a ticket links Orca terminals; a column's prompt is typed into
//     every live one; opening a session brings its terminal to the front in
//     Orca; a stopped one resumes its own conversation; the ticket's New
//     session makes its worktree in Orca; a scheduled column sends.
//  3. Sources: Jira connects in Sources and imports a board; Jira changes
//     move cards and fire prompts; pushes and conflicts; sprints; GitHub and
//     Linear import, sync and push; "+" creates the issue in Linear.
//  4. A Drogon board comes over; the plugin's service follows updates,
//     disable and removal, and leaves nothing running.
//
// Usage: node tests/e2e/accept-orca.mjs   (after scripts/package-plugin.sh)
// Set WORK_BOARD_INSTALL_GIT=https://host/repo.git#tag to exercise a
// packaged Git distribution instead of installing the local build.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { attachToPage } from "./cdp-page.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { chromium } = createRequire(path.join(root, "web", "package.json"))("playwright-core");
const ORCA_CLI = "/Applications/Orca.app/Contents/Resources/bin/orca";
const PLUGIN = path.join(root, "dist", "clioo.work-board");
const KEY = "clioo.work-board";
const gitInstall = process.env.WORK_BOARD_INSTALL_GIT;
const installSource = gitInstall
  ? (() => {
      const parsed = new URL(gitInstall);
      assert.equal(parsed.protocol, "https:", "Git acceptance requires HTTPS");
      assert.ok(parsed.hash.length > 1, "Git acceptance requires an explicit #ref");
      const ref = decodeURIComponent(parsed.hash.slice(1));
      parsed.hash = "";
      return { kind: "git", url: parsed.href, ref };
    })()
  : { kind: "local-path", path: PLUGIN };
assert.ok(existsSync(path.join(PLUGIN, "bin", "work-board-svc")), "run scripts/package-plugin.sh first");

const D = realpathSync(mkdtempSync("/tmp/owb-accept-"));
const HOME = path.join(D, "home");
const USER_DATA = path.join(D, "userdata");
const AGENTS = path.join(HOME, ".local", "bin");
const PROJECT = path.join(D, "projects", "Drogon");
const output = path.join(root, ".preflight", "acceptance", `orca-${Date.now()}`);
mkdirSync(output, { recursive: true });
const report = { status: "RUNNING", checks: [], screenshots: [], processes: {}, focus: {} };
const check = (name) => {
  report.checks.push(name);
  process.stderr.write(`ok ${name}\n`);
};

// ------------------------------------------------------------ helpers --

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (result.status !== 0 && !opts.allowFailure) throw new Error(`${cmd} ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function orca(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(ORCA_CLI, [...args, "--json"], { env: { ...process.env, HOME, ORCA_USER_DATA_PATH: USER_DATA }, timeout: 60_000 }, (error, stdout) => {
      let reply = null;
      try {
        reply = JSON.parse(stdout);
      } catch {}
      if (reply?.ok) return resolve(reply.result);
      if (allowFailure) return resolve(null);
      reject(new Error(`orca ${args.join(" ")}: ${reply?.error?.message ?? error?.message}`));
    });
  });
}

async function waitFor(what, fn, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await delay(250);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 400)})`);
}

async function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Every prompt a fixture agent session received. */
function prompts(sessionId) {
  const file = path.join(HOME, "agent-data", `${sessionId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).prompt);
}

function launches() {
  const file = path.join(HOME, "agent-data", "launches.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const ownedPids = new Set();
function startFixture(script, args) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "ignore"] });
  ownedPids.add(child.pid);
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error(`${script} never listened`)), 15000);
    child.stdout.on("data", (bytes) => {
      buffered += bytes.toString();
      const match = buffered.match(/LISTEN (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, url: `http://127.0.0.1:${match[1]}` });
      }
    });
  });
}

async function control(base, pathname, body) {
  const response = await fetch(`${base}/__fixture/${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.ok(response.ok, `fixture control ${pathname}`);
}

/** The frontmost app's pid, sampled through the run. */
function frontPid() {
  const asn = run("/usr/bin/lsappinfo", ["front"], { allowFailure: true }).trim();
  const out = run("/usr/bin/lsappinfo", ["info", "-only", "pid", asn], { allowFailure: true });
  return Number(/"pid"=(\d+)/.exec(out)?.[1] ?? 0);
}

// -------------------------------------------------------------- setup --

let orcaPid = null;
let main = null;
let orcaTab = null;
let browser = null;
let page = null;
let base = null;
let jira = null;
let sources = null;
let focusTimer = null;

async function rpc(method, params = {}) {
  const response = await fetch(`${base}rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
  const reply = await response.json();
  if (!reply.ok) throw new Error(`${method}: ${reply.error.message}`);
  return reply.result;
}
const ticket = (id) => rpc("work.ticket_show", { ticketId: id });
const api = (fn, ...args) => main.evaluate(fn, ...args);
const service = () => JSON.parse(readFileSync(path.join(USER_DATA, "plugins-data", KEY, "service.json"), "utf8"));
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function shot(name) {
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(output, file), animations: "disabled" });
  report.screenshots.push(file);
}

/** The terminal Orca shows in front: its tab id. */
async function activeTabId() {
  // Orca keeps other worktrees' tab strips mounted but hidden: the visible
  // active tab is the one in front.
  return api(
    () =>
      [...document.querySelectorAll('[data-active="true"][data-tab-id]')]
        .find((el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
        ?.getAttribute("data-tab-id") ?? null,
  );
}

async function terminalOf(handle) {
  return (await orca(["terminal", "show", "--terminal", handle])).terminal;
}

async function approvePlugin() {
  const list = await api(() => window.api.plugins.list());
  const entry = list.find((p) => p.pluginKey === "clioo.work-board");
  await api((k, f) => window.api.plugins.consent({ pluginKey: k, reviewedFingerprint: f, decision: "approve" }), KEY, entry.consentFingerprint);
}

const openBoard = () => api((k) => window.api.plugins.invokeCommand({ pluginKey: k, commandId: "open" }), KEY);

try {
  // Fixture agents first: Orca installs its Claude hooks at start when it
  // finds `claude`.
  mkdirSync(AGENTS, { recursive: true });
  for (const name of ["claude", "codex", "pi", "opencode"]) cpSync(path.join(root, "tests/fixtures/fake-agent.sh"), path.join(AGENTS, name));
  mkdirSync(PROJECT, { recursive: true });
  for (const args of [["init", "-q", "-b", "main"], ["-c", "user.email=f@x", "-c", "user.name=f", "commit", "-q", "--allow-empty", "-m", "init"]]) {
    run("git", args, { cwd: PROJECT });
  }
  const cdp = await freePort();
  const frontBefore = frontPid();
  const started = run(path.join(root, "tests/e2e/isolated-orca.sh"), ["start", D], { env: { ...process.env, CDP_PORT: String(cdp) } });
  orcaPid = Number(/pid=(\d+)/.exec(started)[1]);
  report.processes.orca = orcaPid;
  // Orca must never come to the front during the run.
  report.focus.samples = 0;
  report.focus.orcaFront = 0;
  focusTimer = setInterval(() => {
    report.focus.samples += 1;
    if (frontPid() === orcaPid) report.focus.orcaFront += 1;
  }, 500);
  main = await attachToPage(cdp, (u) => u.startsWith("file:"));
  await main.waitFor(() => Boolean(window.api?.plugins), [], { what: "Orca's window api" });
  await api(
    (agents) =>
      window.api.settings.set({
        pluginSystemEnabled: true,
        defaultTuiAgent: "claude",
        agentCmdOverrides: { claude: `${agents}/claude`, codex: `${agents}/codex`, pi: `${agents}/pi`, opencode: `${agents}/opencode` },
      }),
    AGENTS,
  );
  await orca(["repo", "add", "--path", PROJECT]);
  const mainWorktree = (await orca(["worktree", "list"])).worktrees[0].id;

  // ------------------------------------------------ 1. install + open --
  const installed = await api((source) => window.api.plugins.install(source), installSource);
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const pending = (await api(() => window.api.plugins.list())).find((p) => p.pluginKey === KEY);
  assert.equal(pending.status, "pending", "nothing runs before consent");
  assert.deepEqual(pending.commands.map((c) => c.title), ["Open Work board"]);
  await approvePlugin();
  const opened = await openBoard();
  base = opened.url;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const tabs = (await orca(["tab", "list"])).tabs;
  assert.ok(tabs.some((t) => t.url === base && t.title === "Work board"), JSON.stringify(tabs));
  orcaTab = await attachToPage(cdp, (u) => u.startsWith(base));
  await orcaTab.waitFor(() => document.body.innerText.includes("In progress") && document.body.innerText.includes("Import board"), [], { what: "the board in Orca's tab" });
  const again = await openBoard();
  assert.equal(again.reused, true);
  assert.equal((await orca(["tab", "list"])).tabs.filter((t) => t.url === base).length, 1);
  assert.equal((await rpc("board.status")).version, "0.2.0");
  check("the-plugin-installs-through-orca-and-open-work-board-opens-its-tab");
  if (gitInstall) {
    report.installSource = installSource;
    const provenance = JSON.parse(readFileSync(path.join(service().root, "distribution.json"), "utf8"));
    assert.equal(provenance.platform, "darwin");
    assert.equal(provenance.arch, process.arch);
    check("the-pinned-git-distribution-installs-and-runs-without-a-build-step");
  }

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(base);
  for (const name of ["To do", "In progress", "Review", "QA", "Done"]) await page.getByRole("region", { name: `${name} column` }).waitFor();
  const syncCard = page.getByTestId("work-sync-card");
  await syncCard.getByRole("button", { name: /Import a Jira board/ }).waitFor();
  await shot("board-dark");
  await syncCard.getByRole("button", { name: "Dismiss" }).click();
  await syncCard.waitFor({ state: "detached" });
  check("the-board-opens-with-its-default-columns");

  // ------------------------------------------------------ 2. agents --
  await page.getByRole("button", { name: "Review column actions" }).click();
  await page.getByRole("menuitem", { name: "Configure prompt…" }).click();
  const columnPanel = page.getByRole("complementary", { name: "Review prompt" });
  await columnPanel.getByRole("checkbox", { name: "Ticket enters Review" }).click();
  await columnPanel.getByRole("textbox", { name: "Message to sessions" }).fill("Review {ticket.pr} for {ticket.id}: {ticket.title}");
  await columnPanel.getByRole("heading", { name: "Recipients" }).click();
  await waitFor("column saved", async () => {
    const review = (await rpc("work.board")).columns.find((c) => c.name === "Review");
    return review.sendOnEnter && review.message === "Review {ticket.pr} for {ticket.id}: {ticket.title}";
  });
  await columnPanel.getByRole("button", { name: "Close prompt panel" }).click();
  check("a-columns-prompt-is-configured-in-its-panel");

  // Two agents the user started in Orca.
  const sidA = crypto.randomUUID();
  const sidB = crypto.randomUUID();
  const agentA = (await orca(["terminal", "create", "--worktree", `id:${mainWorktree}`, "--title", "Agent A", "--command", `${AGENTS}/claude --session-id ${sidA}; exit`])).terminal.handle;
  const agentB = (await orca(["terminal", "create", "--worktree", `id:${mainWorktree}`, "--title", "Agent B", "--command", `${AGENTS}/claude --session-id ${sidB}; exit`])).terminal.handle;
  await waitFor("both agents tracked by Orca", async () => {
    const ps = await orca(["worktree", "ps"]);
    return ps.worktrees.flatMap((w) => w.agents).filter((a) => a.agentType === "claude").length >= 2;
  });

  await page.getByRole("button", { name: "New ticket in In progress" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Title" }).fill("Improve Jira resume");
  await dialog.getByRole("combobox", { name: "Project" }).selectOption({ label: "Drogon" });
  await dialog.getByRole("textbox", { name: "Pull request" }).fill("#648");
  await dialog.getByRole("textbox", { name: "Source link" }).fill("https://jira.example.com/browse/DRG-9");
  await dialog.getByRole("button", { name: "Create ticket" }).click();
  await dialog.waitFor({ state: "detached" });
  const created = await ticket("DRG-1");
  assert.equal(created.prNumber, 648);
  assert.equal(created.projectName, "Drogon");
  const ticketPanel = page.getByRole("complementary", { name: "Ticket DRG-1" });
  await ticketPanel.waitFor();
  await ticketPanel.getByRole("tab", { name: "sessions" }).click();
  await ticketPanel.getByRole("button", { name: /Link a session/ }).click();
  const picker = ticketPanel.getByRole("combobox", { name: "Session to link" });
  await picker.selectOption(agentA);
  await ticketPanel.getByRole("button", { name: "Link", exact: true }).click();
  await waitFor("UI link", async () => (await ticket("DRG-1")).sessions.some((s) => s.id === agentA));
  await rpc("work.ticket_link_session", { ticketId: "DRG-1", sessionId: agentB });
  const card = page.getByRole("article", { name: "DRG-1 Improve Jira resume" });
  await card.getByText("2 linked sessions").waitFor({ timeout: 15000 });
  const linked = await ticket("DRG-1");
  assert.deepEqual(linked.sessions.map((s) => [s.harnessId, s.verdict, s.title]), [["claude", "live", "Agent A"], ["claude", "live", "Agent B"]]);
  check("a-ticket-links-orca-terminals-from-the-ui-and-the-rpc");

  await card.dragTo(page.getByRole("region", { name: "Review column" }));
  const expected = "Review PR #648 for DRG-1: Improve Jira resume";
  await waitFor("prompt typed into both agents", async () => prompts(sidA).includes(expected) && prompts(sidB).includes(expected));
  const sends = await rpc("work.sends", { ticketId: "DRG-1" });
  assert.deepEqual(sends.sends[0].results.map((r) => r.action), ["sent", "sent"]);
  // Orca tracked the turn the prompt started and its end.
  await waitFor("agent A back to idle", async () => (await ticket("DRG-1")).sessions[0].agentState === "idle");
  await shot("board-after-drag");
  check("dragging-into-a-column-types-its-prompt-into-every-live-orca-terminal");

  await page.getByRole("button", { name: "Open DRG-1: Improve Jira resume" }).click();
  await ticketPanel.waitFor();
  await shot("ticket-panel");
  const tabA = (await terminalOf(agentA)).tabId;
  await ticketPanel.getByRole("button", { name: new RegExp(`Open .* session ${agentA.slice(0, 8)}`) }).click();
  await waitFor("agent A in front in Orca", async () => (await activeTabId()) === tabA);
  check("opening-a-linked-session-brings-its-terminal-to-the-front-in-orca");

  await orca(["terminal", "send", "--terminal", agentB, "--text", "/exit", "--enter"]);
  await waitFor("agent B's terminal closed", async () => !(await orca(["terminal", "list"])).terminals.some((t) => t.handle === agentB));
  await ticketPanel.locator("li").filter({ has: page.getByRole("button", { name: new RegExp(`session ${agentB.slice(0, 8)}`) }) }).getByText("Exited").waitFor({ timeout: 15000 });
  await ticketPanel.getByRole("button", { name: new RegExp(`Open .* session ${agentB.slice(0, 8)}`) }).click();
  const replacement = await waitFor("replacement linked", async () => {
    const ids = (await ticket("DRG-1")).sessions.map((s) => s.id);
    return !ids.includes(agentB) && ids.length === 2 ? ids.find((id) => id !== agentA) : false;
  });
  // A Claude session the user started continues its folder's latest
  // conversation (Orca keeps the conversation id to itself).
  // Linking the new terminal precedes its shell actually launching the agent.
  await waitFor("the replacement agent launched in continue mode", async () =>
    launches().some((l) => l.agent === "claude" && l.mode === "continue"),
  );
  const replacementTab = (await terminalOf(replacement)).tabId;
  await waitFor("replacement in front", async () => (await activeTabId()) === replacementTab);
  check("a-stopped-session-is-resumed-by-its-click-and-replaces-the-old-link");

  await page.getByRole("button", { name: "Review column actions" }).click();
  await page.getByRole("menuitem", { name: "Configure prompt…" }).click();
  await columnPanel.getByRole("textbox", { name: "Message to sessions" }).fill("Status check for {ticket.id}");
  await columnPanel.getByRole("button", { name: "Preview" }).click();
  await columnPanel.getByTestId("work-column-preview").getByText("Status check for DRG-1").waitFor();
  await columnPanel.getByRole("button", { name: "Send now" }).click();
  const replacementSession = (await rpc("orca.sessions")).sessions.find((s) => s.id === replacement);
  assert.ok(replacementSession, "the replacement is a live Orca terminal");
  await waitFor("send now reached both", async () => {
    const replacementPrompts = (await orca(["terminal", "read", "--terminal", replacement])).terminal.tail.join("\n");
    return prompts(sidA).includes("Status check for DRG-1") && replacementPrompts.includes("DONE: Status check for DRG-1");
  });
  await columnPanel.getByTestId("work-column-last-sent").getByText(/Last sent .* · 2 sessions/).waitFor({ timeout: 15000 });
  await columnPanel.getByRole("button", { name: "Close prompt panel" }).click();
  check("send-now-reaches-every-linked-session");

  // An agent moves its ticket with the command its prompt names: the
  // rendered {board.cli} line, run in an Orca terminal.
  const rendered = (await rpc("work.column_preview", { columnId: "Review", message: '{board.cli} ticket move --ticket {ticket.key} --column "{column.next}"' })).previews[0].message;
  assert.match(rendered, /^'.*\/work-board' ticket move --ticket DRG-1 --column "QA"$/);
  await orca(["terminal", "create", "--worktree", `id:${mainWorktree}`, "--title", "board cli", "--command", `${rendered}; exit`]);
  await page.getByRole("region", { name: "QA column" }).getByRole("article", { name: "DRG-1 Improve Jira resume" }).waitFor({ timeout: 20000 });
  await rpc("work.ticket_move", { ticketId: "DRG-1", columnId: "Review" });
  check("an-agent-moves-its-ticket-with-the-board-command-its-prompt-names");

  // A scheduled column (every minute) on the next tick.
  await rpc("work.column_update", { columnId: "Review", cron: "*/1 * * * *", message: "Scheduled check for {ticket.id}" });
  // The send is recorded once every linked session has it.
  const scheduled = await waitFor("scheduled send", async () => (await rpc("work.sends", { columnId: "Review" })).sends.find((x) => x.trigger === "schedule"), 110_000);
  assert.deepEqual(scheduled.results.map((r) => r.action), ["sent", "sent"]);
  assert.ok(prompts(sidA).includes("Scheduled check for DRG-1"));
  await rpc("work.column_update", { columnId: "Review", cron: null });
  check("a-scheduled-column-sends-on-its-schedule");

  // ------------------------------------------------------ 3. sources --
  jira = await startFixture(path.join(root, "tests/fixtures/jira/fake-jira-server.mjs"), ["--port", "0", "--data", path.join(root, "tests/fixtures/jira/data/agile-site.json"), "--log", path.join(D, "jira.jsonl")]);
  // What Jira itself says about an issue (status, sprint), read through the
  // board's import preview of the board.
  const jiraIssue = async (key) => (await rpc("work.import_preview", { provider: "jira", externalBoardId: "7" })).issues.find((i) => i.key === key);
  await page.getByRole("tab", { name: "sources" }).click();
  const panel = page.getByTestId("work-sync-sources");
  const row = (name) => panel.getByRole("listitem", { name });
  await row("Jira").getByRole("button", { name: "Connect" }).click();
  await row("Jira").getByLabel("Jira site URL").fill(jira.url);
  await row("Jira").getByLabel("Jira email").fill("carlos@example.com");
  await row("Jira").getByLabel("Jira API token").fill("fixture-token");
  await shot("sources-connect-jira");
  await row("Jira").getByRole("button", { name: "Connect", exact: true }).last().click();
  await row("Jira").getByTestId("work-source-status").getByText(/Connected as 127\.0\.0\.1/).waitFor();
  await page.getByRole("tab", { name: "board" }).click();
  check("jira-connects-in-sources-with-site-email-and-token");

  await page.getByRole("button", { name: "Import board", exact: true }).click();
  await page.getByRole("menuitem", { name: /Import a Jira board/ }).click();
  const importDialog = page.getByTestId("work-import-dialog");
  await importDialog.getByRole("button", { name: "Choose Platform Delivery" }).click();
  await importDialog.getByTestId("work-import-columns").getByText("Columns: To Do · In Progress · Review · QA · Done").waitFor();
  await importDialog.getByRole("combobox", { name: "Assigned to" }).selectOption("any");
  await importDialog.getByRole("checkbox", { name: "Import APP-130" }).waitFor();
  await importDialog.getByRole("checkbox", { name: "All of Sprint 25 · Active" }).click();
  await importDialog.getByRole("checkbox", { name: "Import APP-122" }).click();
  await importDialog.getByRole("combobox", { name: "Agents work in" }).selectOption({ label: "Drogon" });
  await importDialog.getByRole("button", { name: "Import 7 issues" }).click();
  await importDialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Sprint", exact: true }).getByText("Sprint 25 · Active").waitFor();
  const carried = page.getByRole("article", { name: "APP-128 Handle session resume after PR review" });
  await carried.getByTestId("work-carried").getByText("Carried from Sprint 24").waitFor();
  await shot("jira-board");
  check("a-jira-board-and-chosen-issues-import");

  await page.getByRole("button", { name: "Review column actions" }).click();
  await page.getByRole("menuitem", { name: "Configure prompt…" }).click();
  const jiraReview = page.getByRole("complementary", { name: "Review prompt" });
  await jiraReview.getByRole("checkbox", { name: "Ticket enters Review" }).click();
  await jiraReview.getByRole("textbox", { name: "Message to sessions" }).fill("Jira moved {ticket.key} to {ticket.status}");
  await jiraReview.getByRole("heading", { name: "Recipients" }).click();
  const jiraBoardId = (await rpc("work.board", { boardId: "7" })).board.id;
  await waitFor("Jira review prompt saved", async () => (await rpc("work.board", { boardId: jiraBoardId })).columns.find((c) => c.name === "Review")?.message === "Jira moved {ticket.key} to {ticket.status}");
  await jiraReview.getByRole("button", { name: "Close prompt panel" }).click();
  await control(jira.url, "issue/APP-130", { status: "In Review" });
  await page.getByRole("button", { name: "Sync Platform Delivery" }).click();
  await page.getByRole("region", { name: "Review column" }).getByRole("article", { name: /APP-130/ }).waitFor({ timeout: 20000 });
  const moved = await ticket("APP-130");
  assert.equal(moved.sends[0].results[0].action, "started");
  const startedFor130 = moved.sessions[0];
  assert.equal(startedFor130.verdict, "live");
  await waitFor("the started agent got the prompt", async () => prompts(startedFor130.agentSessionId).includes("Jira moved APP-130 to In Review"));
  assert.equal((await terminalOf(startedFor130.id)).title, "APP-130 · claude");
  check("a-jira-status-change-moves-the-card-and-starts-an-agent-with-the-prompt");

  await page.getByRole("article", { name: /APP-142/ }).dragTo(page.getByRole("region", { name: "QA column" }));
  const pendingCard = page.getByRole("region", { name: "QA column" }).getByRole("article", { name: /APP-142/ });
  await pendingCard.getByText("Not synced to Jira").waitFor();
  assert.equal((await jiraIssue("APP-142")).status.name, "To Do");
  await pendingCard.getByRole("button", { name: "Push to Jira" }).click();
  await waitFor("Jira transitioned APP-142", async () => (await jiraIssue("APP-142")).status.name === "QA");
  await page.getByRole("article", { name: /APP-149/ }).dragTo(page.getByRole("region", { name: "Review column" }));
  // The board's move is recorded (waiting for push) before Jira changes.
  await waitFor("APP-149 waits for push", async () => (await ticket("APP-149")).sync === "pending");
  await control(jira.url, "issue/APP-149", { status: "Done" });
  await page.getByRole("button", { name: "Sync Platform Delivery" }).click();
  const conflict = page.getByRole("article", { name: /APP-149/ });
  await conflict.getByText("Jira: Done").waitFor({ timeout: 20000 });
  await conflict.getByRole("button", { name: "Use Jira's" }).click();
  await page.getByRole("region", { name: "Done column" }).getByRole("article", { name: /APP-149/ }).waitFor();
  check("a-board-move-waits-for-push-and-a-conflict-takes-jiras-status");

  await page.getByRole("button", { name: "Open APP-128: Handle session resume after PR review" }).click();
  const jiraPanel = page.getByRole("complementary", { name: "Ticket APP-128" });
  await jiraPanel.getByRole("region", { name: "Jira details" }).getByText("Jon Doe").waitFor();
  await jiraPanel.getByRole("button", { name: "New session" }).click();
  await page.getByRole("menuitem", { name: "Claude Code" }).click();
  const newSession = await waitFor("new session linked", async () => (await ticket("APP-128")).sessions[0] ?? false);
  const ownWorktree = (await orca(["worktree", "list"])).worktrees.find((w) => w.id === newSession.workspaceId);
  assert.ok(ownWorktree && /^app-128-/.test(ownWorktree.displayName), JSON.stringify(ownWorktree));
  assert.ok(existsSync(ownWorktree.path), "Orca made a real git worktree");
  const newTab = (await terminalOf(newSession.id)).tabId;
  await waitFor("the new session in front", async () => (await activeTabId()) === newTab);
  check("new-session-on-a-ticket-makes-its-worktree-in-orca-and-opens-there");

  if (await page.getByRole("button", { name: "Close ticket panel" }).count()) await page.getByRole("button", { name: "Close ticket panel" }).click();
  await page.getByRole("button", { name: "Sprint", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sprint 24 · Closed" }).click();
  await page.getByTestId("work-closed-banner").getByText("Historical snapshot · prompts paused").waitFor();
  await page.getByTestId("work-closed-banner").getByRole("button", { name: "Sprint summary" }).click();
  const summaryView = page.getByTestId("work-sprint-summary");
  await summaryView.getByRole("button", { name: "Carry over to Sprint 25" }).click();
  await waitFor("carried over", async () => (await ticket("APP-122")).sprintPending === true);
  await page.getByRole("button", { name: "Back to active sprint" }).click();
  await page.getByRole("button", { name: "Sync options" }).click();
  await page.getByRole("menuitem", { name: /Push all pending moves/ }).click();
  await waitFor("APP-122 in Sprint 25 on Jira", async () => (await jiraIssue("APP-122")).sprint?.name === "Sprint 25");
  check("a-closed-sprint-is-read-only-and-its-summary-carries-a-ticket-over");

  sources = await startFixture(path.join(root, "tests/fixtures/work-sources/fake-sources-server.mjs"), ["--port", "0", "--log", path.join(D, "sources.jsonl")]);
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByRole("menuitem", { name: "My work" }).click();
  await page.getByRole("tab", { name: "sources" }).click();
  await row("Jira").getByRole("switch", { name: "Allow Jira" }).click();
  await row("Jira").getByTestId("work-source-status").getByText("Off: not imported, synced or pushed").waitFor();
  await row("Jira").getByRole("switch", { name: "Allow Jira" }).click();
  await row("GitHub").getByRole("button", { name: "Connect" }).click();
  await row("GitHub").getByRole("button", { name: "GitHub Enterprise?" }).click();
  await row("GitHub").getByLabel("GitHub Enterprise API URL").fill(`${sources.url}/github`);
  await row("GitHub").getByLabel("GitHub token").fill("ghp_fixture");
  await row("GitHub").getByRole("button", { name: "Connect", exact: true }).last().click();
  await row("GitHub").getByTestId("work-source-status").getByText("Connected as octo-fixture").waitFor();
  await page.getByRole("tab", { name: "board" }).click();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByRole("menuitem", { name: /Import a GitHub project or repository/ }).click();
  const ghDialog = page.getByTestId("work-import-dialog");
  await ghDialog.getByRole("button", { name: "Choose Drogon Roadmap" }).click();
  await ghDialog.getByTestId("work-import-columns").getByText("Columns: No Status · Todo · In Progress · Done").waitFor();
  await ghDialog.getByRole("region", { name: "Iteration 2 · Active" }).waitFor();
  await ghDialog.getByRole("combobox", { name: "Assigned to" }).selectOption("any");
  await ghDialog.getByRole("checkbox", { name: "Import clioo/drogon#11" }).waitFor();
  await ghDialog.getByRole("checkbox", { name: "All of Iteration 2 · Active" }).click();
  await ghDialog.getByRole("button", { name: /^Import \d+ issues?$/ }).click();
  await ghDialog.waitFor({ state: "detached" });
  const ghCard = page.getByRole("article", { name: /drogon#11 Iteration picker/ });
  await ghCard.dragTo(page.getByRole("region", { name: "Done column" }));
  const ghPending = page.getByRole("region", { name: "Done column" }).getByRole("article", { name: /drogon#11/ });
  await ghPending.getByRole("button", { name: "Push to GitHub" }).click();
  await waitFor("GitHub item status Done", async () => {
    const preview = await rpc("work.import_preview", { provider: "github", externalBoardId: "project:PVT_roadmap" });
    return preview.issues.find((i) => i.key === "clioo/drogon#11")?.status.name === "Done";
  });
  check("github-connects-from-the-ui-and-a-project-round-trips-a-status");

  await rpc("work.source_connect", { provider: "linear", apiKey: "lin_api_fixture", apiUrl: `${sources.url}/linear` });
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByRole("menuitem", { name: /Import a Linear team/ }).click();
  const linDialog = page.getByTestId("work-import-dialog");
  await linDialog.getByRole("button", { name: "Choose Engineering" }).click();
  await linDialog.getByRole("region", { name: "Cycle 12 · Resume polish · Active" }).waitFor();
  await linDialog.getByRole("combobox", { name: "Assigned to" }).selectOption("any");
  await linDialog.getByRole("checkbox", { name: "Import ENG-2" }).waitFor();
  await linDialog.getByRole("checkbox", { name: "All of Cycle 12 · Resume polish · Active" }).click();
  await linDialog.getByRole("button", { name: /^Import \d+ issues?$/ }).click();
  await linDialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Cycle", exact: true }).getByText("Cycle 12 · Resume polish · Active").waitFor();
  const linearBoard = (await rpc("work.board", {})).boards.find((b) => b.provider === "linear");
  if (!linearBoard.projectId) {
    await page.getByTestId("work-board-no-project").getByRole("combobox", { name: "Agents work in" }).selectOption({ label: "Drogon" });
    await waitFor("board project", async () => Boolean((await rpc("work.board", {})).boards.find((b) => b.provider === "linear").projectId));
  }
  await control(sources.url, "linear/issue/ENG-2", { state: "In Progress" });
  await page.getByRole("button", { name: "Sync Engineering" }).click();
  await page.getByRole("region", { name: "In Progress column" }).getByRole("article", { name: /ENG-2/ }).waitFor({ timeout: 20000 });
  await control(sources.url, "linear/issue/ENG-5", { assignee: "Jon Doe", cycle: 12 });
  await page.getByRole("button", { name: "Sync Engineering" }).click();
  await page.getByRole("region", { name: "Backlog column" }).getByRole("article", { name: /ENG-5/ }).waitFor({ timeout: 20000 });
  await shot("linear-board");
  check("a-linear-team-imports-in-cycles-and-follows-linear-on-sync");

  await page.getByRole("button", { name: "New ticket in In Progress" }).click();
  const create = page.getByTestId("work-create-issue-dialog");
  await create.getByText("It starts in Linear as In Progress.").waitFor();
  await create.getByRole("textbox", { name: "Title" }).fill("Created from the board");
  await create.getByRole("button", { name: "Create in Linear" }).click();
  await create.waitFor({ state: "detached" });
  await page.getByRole("region", { name: "In Progress column" }).getByRole("article", { name: /Created from the board/ }).waitFor({ timeout: 20000 });
  const inLinear = await rpc("work.import_preview", { provider: "linear", externalBoardId: "team-eng", query: "Created from the board" });
  assert.equal(inLinear.issues.length, 1);
  assert.equal(inLinear.issues[0].status.name, "In Progress");
  check("plus-on-a-column-creates-the-issue-in-linear-in-that-status");

  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByRole("menuitem", { name: "My work" }).click();
  await page.getByRole("region", { name: "Review column" }).getByRole("article", { name: "DRG-1 Improve Jira resume" }).waitFor();
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  await shot("board-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
  check("the-board-follows-the-light-and-dark-appearance");

  // ------------------------------------------- 4. migration + lifecycle --
  run(path.join(root, "tests/fixtures/drogon/make-drogon-db.sh"), [path.join(HOME, "Library", "Application Support", "Drogon"), PROJECT]);
  await page.reload();
  const banner = page.getByRole("region", { name: "Bring your Drogon board" });
  await banner.getByText(/Drogon has a Work board with 3 tickets/).waitFor();
  await shot("migration-banner");
  await banner.getByRole("button", { name: "Bring my Drogon board" }).click();
  await banner.waitFor({ state: "detached", timeout: 20000 });
  await page.getByRole("region", { name: "Doing column" }).getByRole("article", { name: "DRG-41 Carry the board over" }).waitFor({ timeout: 20000 });
  const brought = await ticket("DRG-41");
  assert.equal(brought.projectName, "Drogon");
  assert.equal(brought.workspaceId, mainWorktree);
  assert.equal(brought.sessions[0].label, "Main agent");
  assert.equal(brought.sessions[0].verdict, "exited");
  const reopened = await rpc("work.session_open", { ticketId: "DRG-41", sessionId: brought.sessions[0].id });
  assert.equal(reopened.action, "resumed");
  await waitFor("the Drogon conversation resumed in Orca", async () => launches().some((l) => l.mode === "resume" && l.session === "11111111-2222-3333-4444-555555555555"));
  assert.equal((await rpc("work.ticket_create", { title: "After the move", projectId: "Drogon" })).key, "DRG-44");
  check("a-drogon-board-comes-over-and-its-sessions-resume-in-orca");

  // A new version takes over on the same port; the page keeps working.
  const before = service();
  const v2 = path.join(D, "plugin-next");
  cpSync(PLUGIN, v2, { recursive: true });
  appendFileSync(path.join(v2, "worker.mjs"), "\n// next build\n");
  assert.equal((await api((p) => window.api.plugins.install({ kind: "local-path", path: p }), v2)).ok, true);
  const after = await waitFor("handover", async () => {
    const s = service();
    return s.pid !== before.pid && s.root !== before.root && alive(s.pid) ? s : false;
  });
  assert.equal(after.port, before.port, "same port: the open tab keeps working");
  assert.equal(alive(before.pid), false);
  assert.equal((await ticket("DRG-41")).key, "DRG-41");
  check("an-update-hands-over-to-the-new-version-on-the-same-port");

  await api((k) => window.api.plugins.setEnabled({ pluginKey: k, enabled: false }), KEY);
  await waitFor("service stops when disabled", async () => !alive(after.pid));
  await api((k) => window.api.plugins.setEnabled({ pluginKey: k, enabled: true }), KEY);
  const back = await openBoard();
  assert.equal(back.url, base, "the same address again");
  const running = service();
  assert.ok(alive(running.pid));
  await api((k) => window.api.plugins.remove({ pluginKey: k }), KEY);
  await waitFor("service stops when removed", async () => !alive(running.pid));
  check("disabling-or-removing-the-plugin-stops-its-service");

  report.status = "PASSED";
} catch (error) {
  report.status = "FAILED";
  report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => {});
} finally {
  clearInterval(focusTimer);
  try {
    for (const t of (await orca(["terminal", "list"], { allowFailure: true }))?.terminals ?? []) {
      await orca(["terminal", "close", "--terminal", t.handle], { allowFailure: true });
    }
    orcaTab?.close();
    main?.close();
    if (browser) await browser.close().catch(() => {});
    for (const fixture of [jira, sources]) fixture?.child.kill();
    run(path.join(root, "tests/e2e/isolated-orca.sh"), ["stop", D], { allowFailure: true });
    await delay(1000);
    const ps = run("/bin/ps", ["-axo", "pid=,command="]);
    report.processes.survivors = ps.split("\n").filter((line) => line.includes(D) || [...ownedPids].some((pid) => line.trim().startsWith(`${pid} `)));
    report.focus.orcaPid = orcaPid;
    if (report.focus.orcaFront > 0) {
      process.exitCode = 1;
      report.focusError = "the isolated Orca came to the front";
    }
    if (existsSync(path.join(process.env.HOME, ".claude", "projects", "fixture"))) {
      process.exitCode = 1;
      report.homeError = "a fixture wrote into the real HOME";
    }
    if (report.processes.survivors.length > 0) {
      process.exitCode = 1;
      report.cleanupError = "processes of this run survived";
    } else {
      rmSync(D, { recursive: true, force: true });
    }
  } catch (cleanupError) {
    process.exitCode = 1;
    report.cleanupError = String(cleanupError);
  }
  writeFileSync(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: report.status, checks: report.checks.length, error: report.error?.split("\n").slice(0, 4).join("\n"), focus: report.focus, survivors: report.processes.survivors, output }, null, 2)}\n`);
}
