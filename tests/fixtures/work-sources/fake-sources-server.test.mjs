// The fake sources server answers the Linear operations the daemon sends;
// here the board picker's recommendation query (`DrogonLinearAssigned`):
// the viewer's open assigned issues with their team, never a completed,
// canceled, deleted or someone else's issue.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Starts the fixture on `data`, returns its port; teardown on any outcome. */
async function listen(t, data) {
  const dir = mkdtempSync(path.join(tmpdir(), "dsrc-"));
  const file = path.join(dir, "site.json");
  writeFileSync(file, JSON.stringify(data));
  const child = spawn(
    process.execPath,
    [path.join(here, "fake-sources-server.mjs"), "--data", file, "--port", "0"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(async () => {
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null)
      await new Promise((resolve) => child.on("close", resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((_, reject) =>
    child.on("exit", (code) =>
      reject(new Error(`fixture exited with ${code}: ${stderr.trim()}`)),
    ),
  );
  const listening = (async () => {
    for await (const line of readline.createInterface({
      input: child.stdout,
    })) {
      const match = /^LISTEN (\d+)$/.exec(line);
      if (match) return Number(match[1]);
    }
    throw new Error("fixture closed stdout before listening");
  })();
  return Promise.race([listening, exited]);
}

async function linear(port, apiKey, query) {
  const res = await fetch(`http://127.0.0.1:${port}/linear/graphql`, {
    method: "POST",
    headers: { authorization: apiKey, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: {} }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

test("DrogonLinearAssigned lists the viewer's open assigned issues with their team", async (t) => {
  const data = JSON.parse(
    readFileSync(path.join(here, "data", "sources-site.json"), "utf8"),
  );
  const eng = data.linear.teams.find((team) => team.id === "team-eng");
  const done = eng.states.find((state) => state.type === "completed");
  const canceled = eng.states.find((state) => state.type === "canceled");
  const open = eng.states.find(
    (state) => !["completed", "canceled"].includes(state.type),
  );
  const me = data.linear.viewer.name;
  // Only ENG-A counts: done, canceled, deleted and someone else's do not.
  data.linear.issues = [
    ...data.linear.issues.filter((issue) => issue.team !== "team-eng"),
    {
      ...data.linear.issues[0],
      id: "a",
      identifier: "ENG-A",
      team: "team-eng",
      assignee: me,
      state: open.id,
    },
    {
      ...data.linear.issues[0],
      id: "b",
      identifier: "ENG-B",
      team: "team-eng",
      assignee: me,
      state: done.id,
    },
    ...(canceled
      ? [
          {
            ...data.linear.issues[0],
            id: "c",
            identifier: "ENG-C",
            team: "team-eng",
            assignee: me,
            state: canceled.id,
          },
        ]
      : []),
    {
      ...data.linear.issues[0],
      id: "d",
      identifier: "ENG-D",
      team: "team-eng",
      assignee: me,
      state: open.id,
      deleted: true,
    },
    {
      ...data.linear.issues[0],
      id: "e",
      identifier: "ENG-E",
      team: "team-eng",
      assignee: "Ana Lopez",
      state: open.id,
    },
  ];
  const port = await listen(t, data);
  const reply = await linear(
    port,
    data.linear.apiKey,
    "query DrogonLinearAssigned { viewer { assignedIssues(first: 100) { nodes { team { id } } } } }",
  );
  const teams = reply.data.viewer.assignedIssues.nodes
    .map((node) => node.team.id)
    .sort();
  assert.deepEqual(teams, ["team-eng", "team-ops"]);
});
