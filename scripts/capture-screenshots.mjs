// Capture the real UI with synthetic tickets and a fixture CLI. No user
// profiles, provider credentials, running Orca instance, or models are used.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const { chromium } = createRequire(path.join(root, "web/package.json"))("playwright-core");
const temp = await mkdtemp(path.join(tmpdir(), "orca-kanban-screenshots-"));
const home = path.join(temp, "home");
const userData = path.join(temp, "userdata");
const project = path.join(temp, "atlas");
const worktreeId = `repo-atlas::${project}`;
const plugin = path.join(root, "dist/clioo.work-board");
const output = path.join(root, "docs/screenshots");
let child;
let browser;
let exit;
const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

try {
  for (const dir of [home, userData, project, output]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(userData, "fake-orca.json"), JSON.stringify({
    repos: [{ id: "repo-atlas", path: project, displayName: "Atlas", kind: "git" }],
    worktrees: [{ id: worktreeId, repoId: "repo-atlas", path: project, displayName: "main", isMainWorktree: true, isArchived: false, createdAt: 1 }],
    terminals: [1, 2].map((n) => ({ handle: `term_demo${n}`, worktreeId, title: n === 1 ? "API implementation" : "Review accessibility", tabId: `tab-${n}`, leafId: `leaf-${n}`, live: true, inputs: [], command: "", lastOutputAt: Date.now() })),
    agents: { "tab-1:leaf-1": { state: "working", agentType: "claude" }, "tab-2:leaf-2": { state: "done", agentType: "codex" } },
    calls: [], counter: 2,
  }));
  const cli = path.join(temp, "orca-fixture");
  await writeFile(cli, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(path.join(root, "tests/fixtures/fake-orca.mjs"))} "$@"\n`, { mode: 0o700 });
  child = spawn(path.join(plugin, "bin/work-board-svc"), [
    "--state", path.join(temp, "service.json"), "--plugin-root", plugin,
    "--plugin-key", "clioo.work-board", "--user-data", userData,
    "--orca-cli", cli, "--data", path.join(temp, "data"),
  ], { env: { ...process.env, HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  exit = new Promise((resolve) => { child.once("exit", resolve); child.once("error", resolve); });
  let state;
  for (let i = 0; i < 150; i++) {
    try { state = JSON.parse(await readFile(path.join(temp, "service.json"), "utf8")); break; } catch {}
    if (child.exitCode !== null) throw new Error(stderr);
    await delay(100);
  }
  assert.ok(state?.port, `Service did not start: ${stderr}`);
  const base = `http://127.0.0.1:${state.port}`;
  const rpc = async (method, params = {}) => {
    const response = await fetch(`${base}/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) });
    const reply = await response.json();
    assert.equal(reply.ok, true, `${method}: ${JSON.stringify(reply)}`);
    return reply.result;
  };
  await rpc("work.column_update", { columnId: "In progress", message: "Implement {ticket.key}: {ticket.title}.\n\nKeep changes focused, add regression tests, and report what you verified.\n\nWhen ready for review, run:\n{board.cli} ticket move --ticket {ticket.key} --column \"{column.next}\"", sendOnEnter: false });
  await rpc("work.column_update", { columnId: "Review", message: "Review {ticket.key}: {ticket.title}.\n\nCheck correctness, edge cases, and test coverage. Leave actionable feedback and list any blockers.", sendOnEnter: false });
  const tickets = [
    ["Design the activity timeline", "To do", "Group workspace events into a readable history. Keep timestamps and keyboard navigation accessible."],
    ["Add saved board filters", "To do", "Save frequently used project and assignee filters."],
    ["Document the release workflow", "To do", "Write a short guide for preparing and validating a release."],
    ["Build the notifications API", "In progress", "Deliver workspace updates through a typed API with pagination and explicit error handling."],
    ["Add keyboard shortcuts", "In progress", "Navigate tickets and columns without leaving the keyboard."],
    ["Review empty-state accessibility", "Review", "Check screen-reader labels, focus order, contrast, and useful guidance for new users."],
    ["Handle offline reconnection", "Review", "Preserve edits across a network interruption and retry without duplicate requests."],
    ["Verify cross-project search", "QA", "Exercise search with multiple repositories, long titles, and empty results."],
    ["Ship the workspace switcher", "Done", "A faster way to move between projects and active sessions."],
    ["Improve ticket loading states", "Done", "Show stable placeholders while the board refreshes."],
  ];
  for (const [title, columnId, description] of tickets) {
    const ticket = await rpc("work.ticket_create", { title, columnId, description, projectId: "repo-atlas" });
    if (title === "Build the notifications API" || title === "Review empty-state accessibility") {
      await rpc("work.ticket_link_session", { ticketId: ticket.id, sessionId: title.startsWith("Build") ? "term_demo1" : "term_demo2" });
    }
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, colorScheme: "dark" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByRole("article", { name: /Build the notifications API/ }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, "board-dark.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark") && getComputedStyle(document.querySelector("article")).backgroundColor === "rgb(255, 255, 255)");
  await page.screenshot({ path: path.join(output, "board-light.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(() => document.documentElement.classList.contains("dark") && getComputedStyle(document.querySelector("article")).backgroundColor === "rgb(23, 23, 23)");
  await page.getByRole("button", { name: /Open .*: Build the notifications API/ }).click();
  await page.getByRole("button", { name: "Close ticket panel" }).waitFor();
  await page.screenshot({ path: path.join(output, "ticket-details.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Close ticket panel" }).click();
  await page.getByRole("button", { name: "In progress column actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Configure prompt…" }).click();
  await page.getByRole("checkbox", { name: "Ticket enters In progress" }).waitFor();
  await page.screenshot({ path: path.join(output, "column-prompts.png"), animations: "disabled" });
  assert.deepEqual(errors, [], "No browser runtime errors");
  assert.equal((await rpc("work.board")).tickets.length, 10);
  console.log(`Saved four screenshots to ${output}`);
} finally {
  await browser?.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([exit, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exit; }
  }
  // The fixture launches no children; CLI subprocesses must also have exited.
  let survivors = "";
  for (let i = 0; i < 50; i++) {
    const rows = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout;
    survivors = rows.split("\n").filter((line) => line.includes(temp)).join("\n");
    if (!survivors) break;
    await delay(100);
  }
  assert.equal(survivors, "", `Test-owned processes still present; keeping ${temp}: ${survivors}`);
  await rm(temp, { recursive: true, force: true });
  console.log("Cleanup verified: service, browser, and fixture CLI exited.");
}
