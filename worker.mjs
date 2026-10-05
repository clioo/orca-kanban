// The Work board plugin's worker. Orca runs it on demand (the "Open Work
// board" command, or an event) and reaps it after five idle minutes, so it
// only makes sure the Work board service runs and opens the board's tab.
// The service runs in its own session: it keeps the board's schedules, PR
// watches and syncs going between activations, and stops by itself when the
// plugin is disabled or removed (and hands over to a newer version).
import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_KEY = "clioo.work-board";
const root = dirname(fileURLToPath(import.meta.url));

// Installed plugins live in <userData>/plugins/<publisher.id>/<contentHash>.
function userDataOf(dir) {
  for (let d = dir; d !== dirname(d); d = dirname(d)) {
    if (basename(d) === "plugins") return dirname(d);
  }
  throw new Error(`plugin root ${dir} is not inside an Orca plugins directory`);
}
const userData = userDataOf(root);
const dataDir = join(userData, "plugins-data", PLUGIN_KEY);
const statePath = join(dataDir, "service.json");

/** The CLI of the Orca running this worker (its Helper lives inside Orca.app). */
function orcaCli() {
  const at = process.execPath.indexOf(".app/");
  if (at < 0) throw new Error(`cannot find Orca.app from ${process.execPath}`);
  return join(process.execPath.slice(0, at + 4), "Contents", "Resources", "bin", "orca");
}

function orca(args) {
  return new Promise((resolve, reject) => {
    execFile(
      orcaCli(),
      [...args, "--json"],
      { env: { ...process.env, ORCA_USER_DATA_PATH: userData }, timeout: 20_000 },
      (error, stdout) => {
        let reply = null;
        try {
          reply = JSON.parse(stdout);
        } catch {}
        if (reply?.ok) return resolve(reply.result);
        reject(new Error(reply?.error?.message ?? error?.message ?? `orca ${args[0]} failed`));
      },
    );
  });
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/** The running service of THIS version, starting it (and retiring one
 *  left from an older version) when needed. */
async function ensureService() {
  const state = readState();
  if (state && alive(state.pid)) {
    if (state.root === root) return state;
    // Another version's service (e.g. 0.1, which predates handover).
    process.kill(state.pid, "SIGTERM");
    for (let i = 0; i < 50 && alive(state.pid); i++) await sleep(100);
  }
  mkdirSync(dataDir, { recursive: true });
  const args = [
    "--state", statePath,
    "--plugin-root", root,
    "--plugin-key", PLUGIN_KEY,
    "--user-data", userData,
    "--orca-cli", orcaCli(),
    "--data", dataDir,
  ];
  if (state?.port) args.push("--port", String(state.port));
  // The service's own messages go to a log beside its data.
  const log = openSync(join(dataDir, "service.log"), "a");
  const child = spawn(join(root, "bin", "work-board-svc"), args, { detached: true, stdio: ["ignore", "ignore", log] });
  closeSync(log);
  let failed = null;
  child.on("error", (error) => {
    failed = error;
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    if (failed) throw new Error(`The Work board service could not start: ${failed.message}`);
    const started = readState();
    if (started && started.root === root && alive(started.pid)) return started;
    await sleep(100);
  }
  let tail = "";
  try {
    tail = readFileSync(join(dataDir, "service.log"), "utf8").trim().split("\n").slice(-3).join(" ");
  } catch {}
  throw new Error(`The Work board service did not start.${tail ? ` ${tail}` : ""}`);
}

/** Reuses the board's tab when one is open, otherwise opens it. */
async function openBoard() {
  const service = await ensureService();
  const url = `http://127.0.0.1:${service.port}/`;
  const { tabs = [] } = await orca(["tab", "list"]);
  const open = tabs.find((tab) => tab.url?.startsWith(url));
  if (open) {
    await orca(["tab", "switch", "--page", open.browserPageId]);
    return { url, page: open.browserPageId, reused: true };
  }
  let created;
  try {
    created = await orca(["tab", "create", "--url", url]);
  } catch (error) {
    // Nothing is selected in Orca yet: open the board in the first
    // worktree there is (a browser tab lives in a worktree).
    if (!/active worktree/i.test(error.message)) throw error;
    const { worktrees = [] } = await orca(["worktree", "list"]);
    const first = worktrees.find((w) => !w.isArchived);
    if (!first) throw new Error("Add a project to Orca first: the Work board opens beside your worktrees.");
    created = await orca(["tab", "create", "--url", url, "--worktree", `id:${first.id}`]);
  }
  return { url, page: created.browserPageId, reused: false };
}

async function forward(path, payload) {
  const service = await ensureService();
  await fetch(`http://127.0.0.1:${service.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  }).catch(() => {});
}

export default async function activate(ctx) {
  ctx.commands.register("open", openBoard);
  // Any Orca activity brings the service up, so column schedules and syncs
  // run without the board being opened first.
  ctx.events.on("agent.status.changed", (payload) => forward("/events/agent-status", payload));
  ctx.events.on("worktree.created", () => forward("/events/worktrees"));
  ctx.events.on("worktree.removed", () => forward("/events/worktrees"));
}

export function deactivate() {
  // Runs on idle reap as well as on disable: the service must outlive it.
}
