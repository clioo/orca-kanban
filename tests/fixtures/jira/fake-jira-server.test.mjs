// The fixture must find its own default dataset from wherever it is
// checked out. It resolved that path with `new URL(...).pathname`, which
// keeps the %20 of a directory containing a space, so every `jira_*` Rust
// test failed in a checkout under a path like "Application Support" —
// which is exactly where Drogon's own worktrees live.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Copies the fixture under `dir`, starts it with no --data, returns its port. */
async function listenFrom(t, dir) {
  mkdirSync(dir, { recursive: true });
  cpSync(path.join(here, 'fake-jira-server.mjs'), path.join(dir, 'fake-jira-server.mjs'));
  cpSync(path.join(here, 'data'), path.join(dir, 'data'), { recursive: true });

  const child = spawn(process.execPath, [path.join(dir, 'fake-jira-server.mjs'), '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Teardown runs on pass, failure and timeout alike.
  t.after(() => {
    child.kill('SIGKILL');
    return new Promise((resolve) => child.on('close', resolve));
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((_, reject) =>
    child.on('exit', (code) => reject(new Error(`fixture exited with ${code}: ${stderr.trim()}`))),
  );
  const listening = (async () => {
    for await (const line of readline.createInterface({ input: child.stdout })) {
      const port = /^LISTEN (\d+)$/.exec(line.trim())?.[1];
      if (port) return Number(port);
    }
    throw new Error(`fixture never printed LISTEN: ${stderr.trim()}`);
  })();
  return Promise.race([listening, exited]);
}

async function myself(port) {
  const response = await fetch(`http://127.0.0.1:${port}/rest/api/3/myself`, {
    headers: { authorization: 'Bearer fixture-token' },
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('serves its default dataset from a directory whose path contains a space', async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), 'fake-jira-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const port = await listenFrom(t, path.join(base, 'Application Support', 'jira fixture'));
  const viewer = await myself(port);
  assert.ok(viewer.accountId, `the default dataset loaded: ${JSON.stringify(viewer)}`);
});

test('still serves its default dataset from a path with no space', async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), 'fake-jira-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const port = await listenFrom(t, path.join(base, 'plain'));
  const viewer = await myself(port);
  assert.ok(viewer.accountId, `the default dataset loaded: ${JSON.stringify(viewer)}`);
});

// The board picker's recommendation query: the field catalog names the
// Sprint field, and the platform search returns it per issue — objects with
// the board id on Cloud (v3), GreenHopper's string form on Server/DC (v2).
async function listenOn(t, data) {
  const child = spawn(process.execPath, [path.join(here, 'fake-jira-server.mjs'), '--port', '0', '--data', data], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGKILL');
    return new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.on('close', resolve)));
  });
  for await (const line of readline.createInterface({ input: child.stdout })) {
    const port = /^LISTEN (\d+)$/.exec(line.trim())?.[1];
    if (port) return Number(port);
  }
  throw new Error('fixture never printed LISTEN');
}

async function call(port, method, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('names its Sprint field and returns it in the v3 and v2 search shapes', async (t) => {
  const port = await listenOn(t, path.join(here, 'data', 'agile-site.json'));
  for (const api of ['2', '3']) {
    const fields = await call(port, 'GET', `/rest/api/${api}/field`);
    const sprint = fields.find((f) => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint');
    assert.equal(sprint.id, 'customfield_10020');
  }
  const jql = 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC';
  const v3 = await call(port, 'POST', '/rest/api/3/search/jql', { jql, maxResults: 100, fields: ['project', 'customfield_10020'] });
  const byKey = Object.fromEntries(v3.issues.map((i) => [i.key, i.fields]));
  assert.deepEqual(Object.keys(byKey).sort(), ['APP-128', 'APP-142']);
  assert.deepEqual(byKey['APP-142'].customfield_10020, [{ id: 25, name: 'Sprint 25', state: 'active', boardId: 7 }]);
  assert.equal(byKey['APP-142'].project.key, 'APP');
  const v2 = await call(port, 'POST', '/rest/api/2/search', { jql, maxResults: 100, fields: ['project', 'customfield_10020'] });
  assert.match(v2.issues[0].fields.customfield_10020[0], /\[id=25,rapidViewId=7,state=ACTIVE,name=Sprint 25\]$/);
  // An issue in no sprint reads null; a search that does not ask gets nothing.
  const all = await call(port, 'POST', '/rest/api/3/search/jql', { jql: 'project = APP', maxResults: 100, fields: ['customfield_10020'] });
  assert.equal(all.issues.find((i) => i.key === 'APP-150').fields.customfield_10020, null);
  const plain = await call(port, 'POST', '/rest/api/3/search/jql', { jql, maxResults: 100, fields: ['project'] });
  assert.ok(plain.issues.every((i) => !('customfield_10020' in i.fields)));
});

test('the board listing honours the JQL a sync sends: imported keys OR your open issues', async (t) => {
  const port = await listenOn(t, path.join(here, 'data', 'agile-site.json'));
  const keys = async (jql) => {
    const query = jql === null ? '' : `?jql=${encodeURIComponent(jql)}`;
    const page = await call(port, 'GET', `/rest/agile/1.0/board/7/issue${query}`);
    return page.issues.map((i) => i.key).sort();
  };
  const all = await keys(null);
  assert.ok(all.length > 5, `no JQL lists the whole board: ${all}`);
  assert.deepEqual(await keys('key in ("APP-146","APP-110")'), ['APP-110', 'APP-146']);
  // Your open issues: APP-142 and APP-128 (none of yours is done here).
  assert.deepEqual(await keys('assignee = currentUser() AND resolution = Unresolved'), ['APP-128', 'APP-142']);
  assert.deepEqual(
    await keys('key in ("APP-146") OR (assignee = currentUser() AND resolution = Unresolved)'),
    ['APP-128', 'APP-142', 'APP-146'],
  );
  assert.deepEqual(await keys('key in ("NOPE-1")'), []);
});
