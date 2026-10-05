// Fake Jira REST server for Drogon's daemon-side Jira tests (R17-A).
//
// HARD RULE: this fixture never contacts a real Atlassian site and never
// reads real credentials. It implements just enough of the Jira Cloud REST
// v3 (and the Server/DC v2 shapes the fork distinguishes) for
// `crates/drogon-core/tests/jira_*.rs`:
//
//   GET  /rest/api/3/myself            GET  /rest/api/2/myself
//   POST /rest/api/3/search/jql        POST /rest/api/2/search   (classic)
//   GET  /rest/api/3/project/search    GET  /rest/api/2/project  (array)
//   GET  /rest/api/{2,3}/issue/createmeta/<project>/issuetypes[/<type>]
//   GET  /rest/api/{2,3}/priority
//   GET  /rest/api/{2,3}/user/search
//   GET  /rest/api/{2,3}/issue/<key>            (detail; failure injection via -404/-429/-400 keys)
//   GET  /rest/api/{2,3}/issue/<key>/transitions
//   GET  /rest/api/{2,3}/issue/<key>/comment    (paged by `comments`, orderBy=created)
//   POST /rest/api/{2,3}/issue                  (create; logs its body; FAIL_CREATE summary → 400)
//   PUT  /rest/api/{2,3}/issue/<key>            (field updates; logs body)
//   PUT  /rest/api/{2,3}/issue/<key>/assignee   (logs the user ref shape)
//   POST /rest/api/{2,3}/issue/<key>/transitions
//   POST /rest/api/{2,3}/issue/<key>/comment    (logs the body shape; returns id 90001)
//
// Auth: `Basic base64(<email>:fixture-token)` or `Bearer fixture-token`
// (the PAT shape). Anything else gets a real 401 body.
//
// Behavior switches ride inside the JQL so individual tests do not need
// extra config: a JQL containing JQL_SLOW (10s delay, for cancellation),
// JQL_RATE_LIMIT (429 + Retry-After: 7), JQL_NOT_FOUND (404) or JQL_BAD
// (400 with Atlassian's errorMessages shape) triggers that path.
//
// The default dataset reproduces Carlos's Tasks-page screenshot shape: 19
// issues in project DROG, 13 of them in "Backlog", priorities High /
// Medium / Not Set, unassigned and un-prioritized rows included. See
// data/screenshot-site.json.
//
// Agile (Work board import, data/agile-site.json with `stateful: true`):
//
//   GET  /rest/agile/1.0/board                       (paged boards)
//   GET  /rest/agile/1.0/board/<id>/configuration     (columns → status ids)
//   GET  /rest/agile/1.0/board/<id>/sprint            (paged sprints)
//   GET  /rest/agile/1.0/board/<id>/sprint/<sid>/issue, /board/<id>/backlog,
//        /board/<id>/issue                            (paged issues)
//   GET  /rest/agile/1.0/issue/<key>                  (issue + sprint fields)
//   POST /rest/agile/1.0/sprint/<sid>/issue, /rest/agile/1.0/backlog/issue
//   GET  /rest/api/{2,3}/status
//
// With `stateful: true` a transition POST really changes the issue's
// status (unknown transition → 400), and sprint/backlog moves change its
// sprint. Tests change "Jira" from the outside through the unauthenticated
// control endpoint `POST /__fixture/issue/<key>` ({status, sprintId,
// summary, assignee, deleted}) and `POST /__fixture/sprint/<id>` ({state}).
//
// Usage: node fake-jira-server.mjs --data <json> --port <n>   (port 0 =
// ephemeral; the chosen port is printed as `LISTEN <port>` on stdout.)

import { createServer } from 'node:http'
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const FIXTURE_TOKEN = 'fixture-token'
const SLOW_JQL_DELAY_MS = 10_000

const { values } = parseArgs({
  options: {
    // `fileURLToPath`, not `.pathname`: a checkout under a path with a
    // space (Drogon's own worktrees live under "Application Support")
    // keeps the %20 in a URL pathname and the dataset read fails.
    data: {
      type: 'string',
      default: fileURLToPath(new URL('./data/screenshot-site.json', import.meta.url)),
    },
    port: { type: 'string', default: '0' },
    log: { type: 'string', default: '' },
  },
})

const dataset = JSON.parse(readFileSync(values.data, 'utf8'))

// Test-only observability: when --log is given, every handled request
// appends one JSON line so Rust tests can assert exactly which endpoint,
// JQL and field list the daemon sent — without touching the contract.
function logRequest(record) {
  if (!values.log) return
  appendFileSync(values.log, `${JSON.stringify(record)}\n`)
}

function checkAuth(req) {
  const header = req.headers.authorization ?? ''
  if (header === `Bearer ${FIXTURE_TOKEN}`) return true
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
      return decoded.split(':')[1] === FIXTURE_TOKEN
    } catch {
      return false
    }
  }
  return false
}

function authError(res) {
  res.writeHead(401, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ errorMessages: ['You are not authenticated. Authentication required to perform this operation.'], errors: {} }))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > 1024 * 1024) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function page(records, startAt, maxResults) {
  const start = Number.isFinite(startAt) ? startAt : 0
  const size = Number.isFinite(maxResults) && maxResults > 0 ? maxResults : 50
  return {
    startAt: start,
    maxResults: size,
    total: records.length,
    isLast: start + size >= records.length,
    values: records.slice(start, start + size),
  }
}

function jqlFailure(jql, res) {
  if (jql.includes('JQL_RATE_LIMIT')) {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
    res.end(JSON.stringify({ errorMessages: ['Rate limit exceeded.'], errors: {} }))
    return true
  }
  if (jql.includes('JQL_NOT_FOUND')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} }))
    return true
  }
  if (jql.includes('JQL_BAD')) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ errorMessages: ["The value 'NOT_A_FIELD' does not exist for the field 'field'."], errors: {} }))
    return true
  }
  return false
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

function findIssue(key) {
  return (dataset.issues ?? []).find((candidate) => candidate.key === key && !candidate.deleted)
}

function sprintRef(id) {
  const sprint = (dataset.sprints ?? []).find((candidate) => candidate.id === id)
  if (!sprint) return null
  const { boardId, ...rest } = sprint
  return { ...rest, originBoardId: boardId }
}

const SPRINT_FIELD = 'customfield_10020'

// The platform search's Sprint field: Cloud (v3) returns sprint objects with
// their board id; Server/DC (v2) returns GreenHopper's string form.
function sprintFieldValue(issue, api) {
  const sprint = issue.sprintId == null ? null : (dataset.sprints ?? []).find((s) => s.id === issue.sprintId)
  if (!sprint) return null
  if (api === 'v2') {
    return [`com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=${sprint.id},rapidViewId=${sprint.boardId},state=${sprint.state.toUpperCase()},name=${sprint.name}]`]
  }
  return [{ id: sprint.id, name: sprint.name, state: sprint.state, boardId: sprint.boardId }]
}

// An issue as the agile API returns it: its current (non-closed) sprint in
// `fields.sprint`, the closed ones it passed through in `fields.closedSprints`.
function agileIssue(issue) {
  return {
    id: issue.id,
    key: issue.key,
    fields: {
      ...issue.fields,
      sprint: issue.sprintId == null ? null : sprintRef(issue.sprintId),
      closedSprints: (issue.closedSprintIds ?? []).map(sprintRef).filter(Boolean),
    },
  }
}

function boardIssues(board) {
  return (dataset.issues ?? []).filter(
    (issue) => !issue.deleted && issue.fields.project.key === board.location.projectKey,
  )
}

async function agile(req, res, url, path) {
  const startAt = Number(url.searchParams.get('startAt') ?? 0)
  const maxResults = Number(url.searchParams.get('maxResults') ?? 50)
  const issuePage = (records) => {
    logRequest({ path, method: req.method })
    const window = records.slice(startAt, startAt + maxResults)
    return json(res, 200, { startAt, maxResults, total: records.length, issues: window.map(agileIssue) })
  }
  if (req.method === 'GET' && path === '/rest/agile/1.0/board') {
    logRequest({ path, method: req.method })
    const boards = (dataset.boards ?? []).map(({ columns, ...board }) => board)
    return json(res, 200, page(boards, startAt, maxResults))
  }
  const boardMatch = path.match(/^\/rest\/agile\/1\.0\/board\/(\d+)(\/.*)?$/)
  if (req.method === 'GET' && boardMatch) {
    const board = (dataset.boards ?? []).find((candidate) => candidate.id === Number(boardMatch[1]))
    if (!board) return json(res, 404, { errorMessages: ['Board does not exist.'], errors: {} })
    const rest = boardMatch[2] ?? ''
    if (rest === '') {
      logRequest({ path, method: req.method })
      const { columns, ...summary } = board
      return json(res, 200, summary)
    }
    if (rest === '/configuration') {
      logRequest({ path, method: req.method })
      return json(res, 200, {
        id: board.id,
        name: board.name,
        type: board.type,
        columnConfig: {
          columns: board.columns.map((column) => ({
            name: column.name,
            statuses: column.statuses.map((id) => ({ id, self: `https://fixture.local/rest/api/2/status/${id}` })),
          })),
        },
      })
    }
    if (rest === '/sprint') {
      logRequest({ path, method: req.method, state: url.searchParams.get('state') })
      if (board.type !== 'scrum') return json(res, 400, { errorMessages: ['The board does not support sprints'], errors: {} })
      const states = (url.searchParams.get('state') ?? 'active,closed,future').split(',')
      const sprints = (dataset.sprints ?? [])
        .filter((sprint) => sprint.boardId === board.id && states.includes(sprint.state))
        .map(({ boardId, ...sprint }) => ({ ...sprint, originBoardId: boardId }))
      return json(res, 200, page(sprints, startAt, maxResults))
    }
    const sprintIssues = rest.match(/^\/sprint\/(\d+)\/issue$/)
    if (sprintIssues) {
      const id = Number(sprintIssues[1])
      return issuePage(boardIssues(board).filter((issue) => issue.sprintId === id || (issue.sprintId == null && (issue.closedSprintIds ?? []).includes(id))))
    }
    if (rest === '/backlog') {
      return issuePage(boardIssues(board).filter((issue) => issue.sprintId == null && issue.fields.status.statusCategory.key !== 'done'))
    }
    if (rest === '/issue') {
      const jql = url.searchParams.get('jql')
      if (jql !== null) logRequest({ path, method: req.method, jql })
      return issuePage(jql === null ? boardIssues(board) : boardIssues(board).filter((issue) => matchesBoardJql(issue, jql)))
    }
  }
  const agileIssueMatch = path.match(/^\/rest\/agile\/1\.0\/issue\/([^/]+)$/)
  if (req.method === 'GET' && agileIssueMatch) {
    const key = decodeURIComponent(agileIssueMatch[1])
    logRequest({ path, method: req.method, key })
    const issue = findIssue(key)
    if (!issue) return json(res, 404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} })
    return json(res, 200, agileIssue(issue))
  }
  const moveMatch = path.match(/^\/rest\/agile\/1\.0\/(?:sprint\/(\d+)|backlog)\/issue$/)
  if (req.method === 'POST' && moveMatch) {
    const body = await readBody(req)
    logRequest({ path, method: req.method, body })
    const target = moveMatch[1] ? Number(moveMatch[1]) : null
    if (target !== null) {
      const sprint = (dataset.sprints ?? []).find((candidate) => candidate.id === target)
      if (!sprint || sprint.state === 'closed') {
        return json(res, 400, { errorMessages: ['Issues can only be moved to an open sprint.'], errors: {} })
      }
    }
    for (const key of body.issues ?? []) {
      const issue = findIssue(key)
      if (!issue) return json(res, 400, { errorMessages: [`Issue ${key} does not exist.`], errors: {} })
      issue.sprintId = target
    }
    return json(res, 204)
  }
  return json(res, 404, { errorMessages: [`Fixture has no agile handler for ${req.method} ${path}.`], errors: {} })
}

async function control(req, res, path) {
  const body = await readBody(req)
  const issueMatch = path.match(/^\/__fixture\/issue\/([^/]+)$/)
  if (issueMatch) {
    const issue = (dataset.issues ?? []).find((candidate) => candidate.key === decodeURIComponent(issueMatch[1]))
    if (!issue) return json(res, 404, { error: 'no such issue' })
    if (body.status) {
      const status = (dataset.statuses ?? []).find((candidate) => candidate.id === body.status || candidate.name === body.status)
      if (!status) return json(res, 400, { error: 'no such status' })
      issue.fields.status = status
    }
    if ('sprintId' in body) issue.sprintId = body.sprintId
    if (Array.isArray(body.closedSprintIds)) issue.closedSprintIds = body.closedSprintIds
    if (typeof body.summary === 'string') issue.fields.summary = body.summary
    if ('assignee' in body) issue.fields.assignee = body.assignee
    if (typeof body.deleted === 'boolean') issue.deleted = body.deleted
    issue.fields.updated = new Date().toISOString()
    return json(res, 200, agileIssue(issue))
  }
  const sprintMatch = path.match(/^\/__fixture\/sprint\/(\d+)$/)
  if (sprintMatch) {
    const sprint = (dataset.sprints ?? []).find((candidate) => candidate.id === Number(sprintMatch[1]))
    if (!sprint) return json(res, 404, { error: 'no such sprint' })
    if (body.state) sprint.state = body.state
    return json(res, 200, sprint)
  }
  return json(res, 404, { error: 'no such control' })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.local')
  const path = url.pathname
  // Test control (fixture-only, never a Jira path): lets a test change
  // "Jira" from the outside, the way a teammate would.
  if (path.startsWith('/__fixture/') && req.method === 'POST') return control(req, res, path)
  if (!checkAuth(req)) return authError(res)
  if (path.startsWith('/rest/agile/1.0/')) return agile(req, res, url, path)
  const api = path.startsWith('/rest/api/2') ? 'v2' : path.startsWith('/rest/api/3') ? 'v3' : null

  // /myself (both versions share the fixture viewer).
  if (api && path.endsWith('/myself')) {
    logRequest({ path, method: req.method })
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(dataset.myself))
  }

  // Issue search: POST /search/jql (Cloud) or POST /search (classic).
  if (api && req.method === 'POST' && (path.endsWith('/search/jql') || path.endsWith('/search'))) {
    const body = await readBody(req)
    const jql = typeof body.jql === 'string' ? body.jql : ''
    logRequest({ path, method: req.method, jql, maxResults: body.maxResults ?? null, fields: Array.isArray(body.fields) ? body.fields : null })
    if (jqlFailure(jql, res)) return
    if (jql.includes('JQL_SLOW')) await new Promise((resolve) => setTimeout(resolve, SLOW_JQL_DELAY_MS))
    const matching = dataset.issues.filter((issue) => matchesJql(issue, jql))
    const startAt = Number(body.startAt ?? 0)
    const maxResults = Number(body.maxResults ?? 50)
    const window = matching.slice(startAt, startAt + maxResults)
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        issues: window.map((issue) => {
          const picked = pickFields(issue, body.fields)
          if (Array.isArray(body.fields) && body.fields.includes(SPRINT_FIELD)) picked.fields[SPRINT_FIELD] = sprintFieldValue(issue, api)
          return picked
        }),
        startAt,
        maxResults,
        total: matching.length,
        isLast: startAt + maxResults >= matching.length,
      }),
    )
  }

  // Field catalog: where the site keeps its Sprint custom field.
  if (api && req.method === 'GET' && path.endsWith('/field')) {
    logRequest({ path, method: req.method })
    return json(res, 200, [
      { id: 'summary', name: 'Summary', custom: false, schema: { type: 'string', system: 'summary' } },
      { id: SPRINT_FIELD, name: 'Sprint', custom: true, schema: { type: 'array', items: 'json', custom: 'com.pyxis.greenhopper.jira:gh-sprint', customId: 10020 } },
      { id: 'customfield_10016', name: 'Story point estimate', custom: true, schema: { type: 'number', custom: 'com.pyxis.greenhopper.jira:jsw-story-points' } },
    ])
  }

  // Project picker: paged search (Cloud) or the plain array (Server/DC).
  if (api && path.endsWith('/project/search')) {
    logRequest({ path, method: req.method })
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(page(dataset.projects, Number(url.searchParams.get('startAt')), Number(url.searchParams.get('maxResults')))))
  }
  if (api && path.endsWith('/project')) {
    logRequest({ path, method: req.method })
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(dataset.projects))
  }

  // Create metadata: issuetypes (paged) and per-type fields (paged).
  const createmeta = path.match(/^\/rest\/api\/[23]\/issue\/createmeta\/([^/]+)\/issuetypes(?:\/([^/]+))?$/)
  if (api && createmeta) {
    logRequest({ path, method: req.method })
    const issueTypes = dataset.createmeta.issueTypes ?? []
    if (createmeta[2] === undefined) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ...page(issueTypes, Number(url.searchParams.get('startAt')), Number(url.searchParams.get('maxResults'))), issueTypes: undefined }))
    }
    const fields = dataset.createmeta.fieldsByType?.[createmeta[2]] ?? []
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(page(fields, Number(url.searchParams.get('startAt')), Number(url.searchParams.get('maxResults')))))
  }

  if (api && req.method === 'GET' && path.endsWith('/status')) {
    logRequest({ path, method: req.method })
    return json(res, 200, dataset.statuses ?? [])
  }

  if (api && path.endsWith('/priority')) {
    logRequest({ path, method: req.method })
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(dataset.priorities ?? []))
  }

  if (api && path.endsWith('/user/search')) {
    logRequest({ path, method: req.method })
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(dataset.users ?? []))
  }

  // --- R17-C: issue detail, comments, transitions, mutations --------------

  // Issue detail: dataset lookup by key; failure injection via magic keys
  // (DROG-404 / DROG-429 / DROG-400) keeps every other test config-free.
  const issueMatch = path.match(/^\/rest\/api\/[23]\/issue\/([^/]+)$/)
  if (api && req.method === 'GET' && issueMatch) {
    const key = decodeURIComponent(issueMatch[1])
    logRequest({ path, method: req.method, key, fields: url.searchParams.get('fields'), expand: url.searchParams.get('expand') })
    if (key.endsWith('-404')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} }))
    }
    if (key.endsWith('-429')) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' })
      return res.end(JSON.stringify({ errorMessages: ['Rate limit exceeded.'], errors: {} }))
    }
    if (key.endsWith('-400')) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ errorMessages: ["The value 'NOT_A_FIELD' does not exist for the field 'field'."], errors: {} }))
    }
    const issue = (dataset.issues ?? []).find((candidate) => candidate.key === key)
    if (!issue) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} }))
    }
    // Honor a `fields` list the way Jira does (the daemon asks for its
    // detail field set, description/attachment included).
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(pickFields(issue, url.searchParams.get('fields')?.split(',') ?? null)))
  }

  if (api && req.method === 'GET' && path.endsWith('/transitions')) {
    const key = decodeURIComponent(path.split('/issue/')[1].split('/')[0])
    logRequest({ path, method: req.method, key })
    if (key.endsWith('-404') || key.endsWith('-429') || key.endsWith('-400')) {
      res.writeHead(Number(key.split('-').pop()), { 'content-type': 'application/json', ...(key.endsWith('-429') ? { 'retry-after': '7' } : {}) })
      return res.end(JSON.stringify({ errorMessages: ['Transition lookup failed (fixture switch).'], errors: {} }))
    }
    const issue = (dataset.issues ?? []).find((candidate) => candidate.key === key)
    const from = issue?.fields.status
    if (dataset.stateful) {
      // Like Jira: a gone issue has no transitions, and none leads to the
      // status it already has.
      if (!findIssue(key)) return json(res, 404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} })
      const offered = (dataset.transitions ?? []).filter((transition) => transition.to.id !== from.id)
      return json(res, 200, { transitions: offered.map((transition) => ({ ...transition, from })) })
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ transitions: (dataset.transitions ?? []).map((transition) => ({ ...transition, from })) }))
  }

  const commentListMatch = path.match(/^\/rest\/api\/[23]\/issue\/([^/]+)\/comment$/)
  if (api && req.method === 'GET' && commentListMatch) {
    const key = decodeURIComponent(commentListMatch[1])
    logRequest({ path, method: req.method, key, orderBy: url.searchParams.get('orderBy') })
    const comments = (dataset.comments ?? {})[key] ?? []
    const start = Number(url.searchParams.get('startAt') ?? 0)
    const size = Number(url.searchParams.get('maxResults') ?? 50)
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({
      startAt: start,
      maxResults: size,
      total: comments.length,
      isLast: start + size >= comments.length,
      comments: comments.slice(start, start + size),
    }))
  }

  if (api && req.method === 'POST' && path.endsWith('/issue')) {
    const body = await readBody(req)
    logRequest({ path, method: req.method, body })
    const summary = body?.fields?.summary ?? ''
    if (typeof summary === 'string' && summary.includes('FAIL_CREATE')) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ errorMessages: ['The issue could not be created (fixture FAIL_CREATE switch).'], errors: {} }))
    }
    if (dataset.stateful) {
      // Work creates issues on an imported board: keep them, like Jira.
      const projectKey = body?.fields?.project?.key
      const project = (dataset.projects ?? []).find((p) => p.key === projectKey)
      if (!project) return json(res, 400, { errorMessages: [], errors: { project: 'valid project is required' } })
      const type = (dataset.createmeta?.issueTypes ?? []).find((t) => t.id === body?.fields?.issuetype?.id)
      if (!type) return json(res, 400, { errorMessages: [], errors: { issuetype: 'valid issue type is required' } })
      const numbers = (dataset.issues ?? []).filter((i) => i.key.startsWith(`${projectKey}-`)).map((i) => Number(i.key.split('-')[1]) || 0)
      const key = `${projectKey}-${Math.max(0, ...numbers) + 1}`
      const assigneeId = body?.fields?.assignee?.accountId
      const issue = {
        id: String(40000 + dataset.issues.length),
        key,
        sprintId: null,
        closedSprintIds: [],
        fields: {
          summary,
          project,
          issuetype: { id: type.id, name: type.name },
          priority: { id: '3', name: 'Medium' },
          status: dataset.statuses[0],
          assignee: assigneeId === dataset.myself.accountId ? { accountId: assigneeId, displayName: dataset.myself.displayName } : null,
          labels: [],
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
          description: body?.fields?.description ?? null,
        },
      }
      dataset.issues.push(issue)
      return json(res, 201, { id: issue.id, key, self: `https://fixture.local/rest/api/3/issue/${key}` })
    }
    const maxNumber = Math.max(0, ...(dataset.issues ?? []).map((issue) => Number(issue.key.split('-')[1]) || 0))
    const key = `DROG-${maxNumber + 1}`
    res.writeHead(201, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ id: String(10000 + maxNumber + 1), key, self: `https://fixture.local/rest/api/3/issue/${key}` }))
  }

  const issueWriteMatch = path.match(/^\/rest\/api\/[23]\/issue\/([^/]+)(\/assignee|\/transitions|\/comment)?$/)
  if (api && (req.method === 'PUT' || req.method === 'POST') && issueWriteMatch) {
    const key = decodeURIComponent(issueWriteMatch[1])
    const sub = issueWriteMatch[2] ?? ''
    const body = await readBody(req)
    logRequest({ path, method: req.method, key, sub, body })
    if (key.endsWith('-400')) {
      res.writeHead(400, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ errorMessages: ['The value is invalid (fixture -400 switch).'], errors: {} }))
    }
    if (sub === '/transitions' && dataset.stateful) {
      const transition = (dataset.transitions ?? []).find((candidate) => candidate.id === body?.transition?.id)
      const issue = findIssue(key)
      if (!issue) return json(res, 404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} })
      if (!transition) {
        return json(res, 400, { errorMessages: [`Transition id '${body?.transition?.id}' is not valid for this issue.`], errors: {} })
      }
      issue.fields.status = transition.to
      issue.fields.updated = new Date().toISOString()
      return json(res, 204)
    }
    if (sub === '/comment') {
      res.writeHead(201, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id: '90001', self: `https://fixture.local/rest/api/3/issue/${key}/comment/90001` }))
    }
    res.writeHead(204, { 'content-type': 'application/json' })
    return res.end()
  }

  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ errorMessages: [`Fixture has no handler for ${req.method} ${path}.`], errors: {} }))
})

// A deliberately small JQL subset: the daemon's own filter JQLs plus
// `project = X`. Anything else matches everything (the tests that need
// filtering use these forms).
function matchesJql(issue, jql) {
  const trimmed = jql.trim()
  const project = /project\s*=\s*([A-Za-z0-9_-]+)/.exec(trimmed)
  if (project && issue.fields.project.key !== project[1]) return false
  if (trimmed.startsWith('assignee = currentUser()') && issue.fields.assignee?.accountId !== dataset.myself.accountId) return false
  if (trimmed.startsWith('reporter = currentUser()') && issue.fields.reporter?.accountId !== dataset.myself.accountId) return false
  if (/resolution IS NOT EMPTY/.test(trimmed) && issue.fields.resolution == null) return false
  if (/resolution = Unresolved/.test(trimmed) && issue.fields.resolution != null) return false
  return true
}

// The board listing's JQL as a sync sends it: clauses joined by OR, each
// `key in ("A","B")` or a parenthesised `assignee = currentUser() AND
// resolution = Unresolved`.
function matchesBoardJql(issue, jql) {
  return jql.split(/\s+OR\s+(?![^(]*\))/).some((clause) => {
    const keys = /^key in \((.*)\)$/.exec(clause.trim())
    if (keys) return keys[1].split(',').map((k) => k.trim().replace(/^"|"$/g, '')).includes(issue.key)
    const inner = clause.trim().replace(/^\((.*)\)$/, '$1')
    return matchesJql(issue, inner) && (!/resolution = Unresolved/.test(inner) || issue.fields.status.statusCategory.key !== 'done')
  })
}

// Mirrors the daemon's ISSUE_LIST_FIELDS so a "fields" request is honored
// the way Jira honors it (description etc. simply absent).
function pickFields(issue, fields) {
  if (!Array.isArray(fields)) return issue
  const allowed = new Set(['id', 'key', ...fields])
  const picked = { id: issue.id, key: issue.key, fields: {} }
  for (const [name, value] of Object.entries(issue.fields)) {
    if (allowed.has(name)) picked.fields[name] = value
  }
  return picked
}

server.listen(Number(values.port), '127.0.0.1', () => {
  const address = server.address()
  process.stdout.write(`LISTEN ${address.port}\n`)
})
