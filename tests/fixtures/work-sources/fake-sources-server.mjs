#!/usr/bin/env node
// Stateful fake Linear and GitHub for the Work board's source tests. Never a
// real service: 127.0.0.1 only, fixture credentials only.
//
//   POST /linear/graphql     Linear GraphQL (operations named DrogonLinear*)
//   GET  /github/user, /github/user/repos
//   GET  /github/repos/<owner>/<repo>/issues[/<n>]   PATCH …/issues/<n>
//   POST /github/graphql     GitHub GraphQL (operations named DrogonGh*)
//
// Tests change "Linear"/"GitHub" from the outside (a teammate's edit)
// through the unauthenticated control endpoints:
//
//   POST /__fixture/linear/issue/<identifier>  {state, cycle, title, description, assignee, deleted}
//   POST /__fixture/linear/bulk                {team, count, descriptionBytes}
//        (a real team's size: many issues with long descriptions)
//   POST /__fixture/github/item                {project, key, status, iteration, deleted}
//   POST /__fixture/github/issue               {key, state, title, deleted}
//   POST /__fixture/github/projects-error      {type, message} (null clears): the
//        Projects query fails like a gh login without read:project
//
// Usage: node fake-sources-server.mjs [--data <json>] [--port <n>] [--log <jsonl>]
// Prints `LISTEN <port>` once ready.
import { createServer } from 'node:http'
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: fileURLToPath(new URL('./data/sources-site.json', import.meta.url)) },
    port: { type: 'string', default: '0' },
    log: { type: 'string', default: '' },
  },
})

const data = JSON.parse(readFileSync(values.data, 'utf8'))
const linear = data.linear
const github = data.github
const PAGE = 3

// Iterations are dated relative to today so "active" stays active.
const today = new Date()
today.setUTCHours(0, 0, 0, 0)
for (const project of github.projects) {
  for (const it of project.iteration?.iterations ?? []) {
    const start = new Date(today.getTime() + it.offsetDays * 86_400_000)
    it.startDate = start.toISOString().slice(0, 10)
  }
}

function log(record) {
  if (values.log) appendFileSync(values.log, `${JSON.stringify(record)}\n`)
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

function operation(query) {
  return query.match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? ''
}

// ---------------------------------------------------------------- Linear --

const linearTeam = (id) => linear.teams.find((t) => t.id === id)
const linearIssue = (id) =>
  linear.issues.find((i) => !i.deleted && (i.id === id || i.identifier.toUpperCase() === String(id).toUpperCase()))

function linearCycle(team, id) {
  const c = team.cycles.find((cycle) => cycle.id === id)
  return c ? { ...c } : null
}

function linearIssueJson(issue) {
  const team = linearTeam(issue.team)
  const state = team.states.find((s) => s.id === issue.state)
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    url: `https://linear.app/${linear.organization.urlKey}/issue/${issue.identifier}`,
    priorityLabel: issue.priority,
    updatedAt: issue.updatedAt ?? '2026-09-20T09:00:00.000Z',
    assignee: issue.assignee
      ? {
          id: issue.assignee === linear.viewer.name ? linear.viewer.id : `lin-${issue.assignee.toLowerCase().replace(/\s+/g, '-')}`,
          name: issue.assignee,
          displayName: issue.assignee.split(' ')[0].toLowerCase(),
        }
      : null,
    state: { id: state.id, name: state.name, type: state.type },
    cycle: issue.cycle ? linearCycle(team, issue.cycle) : null,
    labels: { nodes: issue.labels.map((name) => ({ name })) },
    project: issue.project ? { name: issue.project } : null,
    team: { id: team.id, key: team.key, name: team.name },
  }
}

function linearGraphql(op, v) {
  switch (op) {
    case 'DrogonLinearMe':
      return { data: { viewer: { id: linear.viewer.id } } }
    case 'DrogonLinearViewer':
      return { data: { viewer: linear.viewer, organization: linear.organization } }
    case 'DrogonLinearAssigned': {
      // The viewer's open issues (not completed or canceled), with their team.
      const open = linear.issues.filter((i) => {
        if (i.deleted || i.assignee !== linear.viewer.name) return false
        const state = linearTeam(i.team).states.find((s) => s.id === i.state)
        return !['completed', 'canceled'].includes(state?.type)
      })
      return { data: { viewer: { assignedIssues: { nodes: open.map((i) => ({ team: { id: i.team } })) } } } }
    }
    case 'DrogonLinearTeams':
      return { data: { teams: { nodes: linear.teams.map(({ id, key, name, cyclesEnabled }) => ({ id, key, name, cyclesEnabled })) } } }
    case 'DrogonLinearTeam': {
      const team = linearTeam(v.id)
      if (!team) return { data: { team: null }, errors: [{ message: 'Entity not found: Team' }] }
      return {
        data: {
          team: {
            id: team.id,
            key: team.key,
            name: team.name,
            cyclesEnabled: team.cyclesEnabled,
            states: { nodes: team.states },
            cycles: { nodes: team.cycles },
          },
        },
      }
    }
    case 'DrogonLinearIssues': {
      const team = linearTeam(v.id)
      if (!team) return { data: { team: null }, errors: [{ message: 'Entity not found: Team' }] }
      const all = linear.issues.filter((i) => i.team === team.id && !i.deleted)
      const start = v.after ? Number(v.after) : 0
      // Small pages exercise paging; a bulk-seeded team pages like Linear.
      const size = all.length > 50 ? 100 : PAGE
      const page = all.slice(start, start + size)
      const next = start + size < all.length
      return {
        data: {
          team: {
            issues: {
              nodes: page.map(linearIssueJson),
              pageInfo: { hasNextPage: next, endCursor: next ? String(start + size) : null },
            },
          },
        },
      }
    }
    case 'DrogonLinearIssue': {
      const issue = linearIssue(v.id)
      if (!issue) return { data: { issue: null }, errors: [{ message: 'Entity not found: Issue', extensions: { code: 'NOT_FOUND' } }] }
      return { data: { issue: linearIssueJson(issue) } }
    }
    case 'DrogonLinearCreate': {
      const input = v.input ?? {}
      const team = linearTeam(input.teamId)
      if (!team) return { data: null, errors: [{ message: 'Entity not found: Team' }] }
      if (!input.title) return { data: null, errors: [{ message: 'Argument Validation Error: title should not be empty' }] }
      if (input.stateId && !team.states.some((s) => s.id === input.stateId)) {
        return { data: null, errors: [{ message: 'Invalid input: the workflow state does not belong to this team' }] }
      }
      const numbers = linear.issues.filter((i) => i.team === team.id).map((i) => Number(i.identifier.split('-')[1]) || 0)
      const number = Math.max(0, ...numbers) + 1
      const issue = {
        id: `li-new-${linear.issues.length + 1}`,
        identifier: `${team.key}-${number}`,
        team: team.id,
        title: input.title,
        description: input.description ?? '',
        priority: 'No priority',
        assignee: input.assigneeId === linear.viewer.id ? linear.viewer.name : null,
        // Linear's default: the team's first unstarted state.
        state: input.stateId ?? (team.states.find((s) => s.type === 'unstarted') ?? team.states[0]).id,
        cycle: input.cycleId ?? null,
        labels: [],
      }
      linear.issues.push(issue)
      return { data: { issueCreate: { success: true, issue: linearIssueJson(issue) } } }
    }
    case 'DrogonLinearUpdate': {
      const issue = linearIssue(v.id)
      if (!issue) return { data: null, errors: [{ message: 'Entity not found: Issue' }] }
      const team = linearTeam(issue.team)
      const input = v.input ?? {}
      if ('stateId' in input) {
        if (!team.states.some((s) => s.id === input.stateId)) {
          return { data: null, errors: [{ message: 'Invalid input: the workflow state does not belong to this team' }] }
        }
        issue.state = input.stateId
      }
      if ('cycleId' in input) {
        if (input.cycleId !== null) {
          const cycle = team.cycles.find((c) => c.id === input.cycleId)
          if (!cycle) return { data: null, errors: [{ message: 'Invalid input: unknown cycle' }] }
          if (cycle.completedAt) return { data: null, errors: [{ message: 'Cannot move an issue into a completed cycle' }] }
        }
        issue.cycle = input.cycleId
      }
      issue.updatedAt = new Date().toISOString()
      return { data: { issueUpdate: { success: true } } }
    }
    default:
      return { data: null, errors: [{ message: `Fixture has no Linear operation ${op}` }] }
  }
}

// ---------------------------------------------------------------- GitHub --

const ghIssue = (key) => github.issues.find((i) => `${i.repo}#${i.number}` === key && !i.deleted)
const ghProject = (id) => github.projects.find((p) => p.id === id)

function ghIssueRest(issue) {
  const out = {
    id: 1000 + issue.number,
    node_id: `I_${issue.repo}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    html_url: `https://github.com/${issue.repo}/${issue.pullRequest ? 'pull' : 'issues'}/${issue.number}`,
    assignees: issue.assignees.map((login) => ({ login })),
    labels: issue.labels.map((name) => ({ name })),
    updated_at: '2026-09-20T09:00:00Z',
  }
  if (issue.pullRequest) out.pull_request = { url: 'fixture' }
  return out
}

function iterationJson(project, id) {
  const it = project.iteration?.iterations.find((i) => i.id === id)
  if (!it) return null
  return { iterationId: it.id, title: it.title, startDate: it.startDate, duration: it.duration, field: { id: project.iteration.id } }
}

function ghItemJson(item) {
  const project = ghProject(item.project)
  let content
  if (item.draft) {
    content = { __typename: 'DraftIssue', id: `DI_${item.id}`, title: item.draft }
  } else {
    const issue = ghIssue(item.issue)
    if (!issue) return null
    content = {
      __typename: issue.pullRequest ? 'PullRequest' : 'Issue',
      id: `I_${issue.repo}_${issue.number}`,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      url: ghIssueRest(issue).html_url,
      state: issue.state.toUpperCase(),
      repository: { nameWithOwner: issue.repo },
      assignees: { nodes: issue.assignees.map((login) => ({ login, name: login === github.viewer.login ? github.viewer.name : null })) },
      labels: { nodes: issue.labels.map((name) => ({ name })) },
      updatedAt: '2026-09-20T09:00:00Z',
    }
  }
  const values = [{ __typename: 'ProjectV2ItemFieldTextValue', text: content.title, field: { id: 'PVTF_title' } }]
  const option = (field, id) => field?.options.find((o) => o.id === id)
  const status = option(project.status, item.status)
  if (status) values.push({ __typename: 'ProjectV2ItemFieldSingleSelectValue', optionId: status.id, name: status.name, field: { id: project.status.id } })
  const priority = option(project.priority, item.priority)
  if (priority) values.push({ __typename: 'ProjectV2ItemFieldSingleSelectValue', optionId: priority.id, name: priority.name, field: { id: project.priority.id } })
  const iteration = iterationJson(project, item.iteration)
  if (iteration) values.push({ __typename: 'ProjectV2ItemFieldIterationValue', ...iteration })
  return { __typename: 'ProjectV2Item', id: item.id, isArchived: false, project: { id: project.id }, content, fieldValues: { nodes: values } }
}

function ghProjectFields(project) {
  const fields = [{ __typename: 'ProjectV2Field', id: 'PVTF_title', name: 'Title' }]
  if (project.status) fields.push({ __typename: 'ProjectV2SingleSelectField', id: project.status.id, name: 'Status', options: project.status.options })
  if (project.priority) fields.push({ __typename: 'ProjectV2SingleSelectField', id: project.priority.id, name: 'Priority', options: project.priority.options })
  if (project.iteration) {
    const shape = ({ id, title, startDate, duration }) => ({ id, title, startDate, duration })
    fields.push({
      __typename: 'ProjectV2IterationField',
      id: project.iteration.id,
      name: 'Iteration',
      configuration: {
        iterations: project.iteration.iterations.filter((i) => !i.completed).map(shape),
        completedIterations: project.iteration.iterations.filter((i) => i.completed).map(shape),
      },
    })
  }
  return fields
}

function ghGraphql(op, v) {
  switch (op) {
    case 'DrogonGhViewer':
      return { data: { viewer: github.viewer } }
    case 'DrogonGhProjects':
      if (github.projectsError) return { data: { viewer: null }, errors: [github.projectsError] }
      return {
        data: {
          viewer: {
            login: github.viewer.login,
            projectsV2: {
              nodes: github.projects.map((p) => ({
                id: p.id,
                number: p.number,
                title: p.title,
                closed: p.closed,
                owner: { login: p.owner },
                fields: { nodes: ghProjectFields(p).map(({ __typename }) => ({ __typename })) },
              })),
            },
            organizations: { nodes: [] },
          },
        },
      }
    case 'DrogonGhProject': {
      const p = ghProject(v.id)
      if (!p) return { data: { node: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a node with the global id of '${v.id}'` }] }
      return { data: { node: { __typename: 'ProjectV2', id: p.id, number: p.number, title: p.title, closed: p.closed, owner: { login: p.owner }, fields: { nodes: ghProjectFields(p) } } } }
    }
    case 'DrogonGhItems': {
      const p = ghProject(v.id)
      if (!p) return { data: { node: null }, errors: [{ message: `Could not resolve to a node with the global id of '${v.id}'` }] }
      const all = github.items.filter((i) => i.project === p.id && !i.deleted)
      const start = v.after ? Number(v.after) : 0
      const page = all.slice(start, start + PAGE)
      const next = start + PAGE < all.length
      return {
        data: {
          node: {
            items: {
              nodes: page.map(ghItemJson).filter(Boolean),
              pageInfo: { hasNextPage: next, endCursor: next ? String(start + PAGE) : null },
            },
          },
        },
      }
    }
    case 'DrogonGhItem': {
      const item = github.items.find((i) => i.id === v.id && !i.deleted)
      const json = item ? ghItemJson(item) : null
      if (!json) return { data: { node: null }, errors: [{ type: 'NOT_FOUND', message: `Could not resolve to a node with the global id of '${v.id}'` }] }
      return { data: { node: json } }
    }
    case 'DrogonGhAddItem': {
      const p = ghProject(v.project)
      const match = String(v.content ?? '').match(/^I_(.+)_(\d+)$/)
      const issue = match && ghIssue(`${match[1]}#${match[2]}`)
      if (!p || !issue) return { data: null, errors: [{ message: 'Could not resolve the content to add' }] }
      const item = { id: `PVTI_new_${github.items.length + 1}`, project: p.id, issue: `${issue.repo}#${issue.number}`, status: null, priority: null, iteration: null }
      github.items.push(item)
      return { data: { addProjectV2ItemById: { item: { id: item.id } } } }
    }
    case 'DrogonGhSetField':
    case 'DrogonGhClearField': {
      const p = ghProject(v.project)
      const item = github.items.find((i) => i.id === v.item && i.project === v.project && !i.deleted)
      if (!p || !item) return { data: null, errors: [{ message: 'Could not resolve the project item' }] }
      const clear = op === 'DrogonGhClearField'
      if (p.status && v.field === p.status.id) {
        const id = clear ? null : v.value?.singleSelectOptionId
        if (!clear && !p.status.options.some((o) => o.id === id)) return { data: null, errors: [{ message: 'The single select option Id does not belong to the field' }] }
        item.status = id
      } else if (p.iteration && v.field === p.iteration.id) {
        const id = clear ? null : v.value?.iterationId
        if (!clear && !p.iteration.iterations.some((i) => i.id === id)) return { data: null, errors: [{ message: 'The iteration Id does not belong to the field' }] }
        item.iteration = id
      } else {
        return { data: null, errors: [{ message: 'Unknown field' }] }
      }
      const key = clear ? 'clearProjectV2ItemFieldValue' : 'updateProjectV2ItemFieldValue'
      return { data: { [key]: { projectV2Item: { id: item.id } } } }
    }
    default:
      return { data: null, errors: [{ message: `Fixture has no GitHub operation ${op}` }] }
  }
}

async function githubRest(req, res, path, url) {
  if (req.method === 'GET' && path === '/github/user') return send(res, 200, github.viewer)
  if (req.method === 'GET' && path === '/github/user/repos') {
    const page = Number(url.searchParams.get('page') ?? 1)
    const repos = page > 1 ? [] : github.repos.map((r) => ({ full_name: r.full_name, name: r.full_name.split('/')[1], owner: { login: r.full_name.split('/')[0] }, has_issues: r.has_issues }))
    return send(res, 200, repos)
  }
  const repoMatch = path.match(/^\/github\/repos\/([^/]+)\/([^/]+)$/)
  if (req.method === 'GET' && repoMatch) {
    const repo = github.repos.find((r) => r.full_name === `${repoMatch[1]}/${repoMatch[2]}`)
    if (!repo) return send(res, 404, { message: 'Not Found' })
    return send(res, 200, { full_name: repo.full_name, has_issues: repo.has_issues })
  }
  const list = path.match(/^\/github\/repos\/([^/]+)\/([^/]+)\/issues$/)
  if (req.method === 'GET' && list) {
    const repo = `${list[1]}/${list[2]}`
    if (!github.repos.some((r) => r.full_name === repo)) return send(res, 404, { message: 'Not Found' })
    const page = Number(url.searchParams.get('page') ?? 1)
    const perPage = Number(url.searchParams.get('per_page') ?? 30)
    const all = github.issues.filter((i) => i.repo === repo && !i.deleted)
    return send(res, 200, all.slice((page - 1) * perPage, page * perPage).map(ghIssueRest))
  }
  if (req.method === 'POST' && list) {
    const repo = `${list[1]}/${list[2]}`
    if (!github.repos.some((r) => r.full_name === repo)) return send(res, 404, { message: 'Not Found' })
    const body = await readBody(req)
    log({ path, method: req.method, body })
    if (!body.title) return send(res, 422, { message: 'Validation Failed', errors: [{ field: 'title', code: 'missing_field' }] })
    const number = Math.max(0, ...github.issues.filter((i) => i.repo === repo).map((i) => i.number)) + 1
    const issue = { repo, number, title: body.title, body: body.body ?? '', state: 'open', assignees: body.assignees ?? [], labels: [] }
    github.issues.push(issue)
    return send(res, 201, ghIssueRest(issue))
  }
  const one = path.match(/^\/github\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/)
  if (one) {
    const issue = ghIssue(`${one[1]}/${one[2]}#${one[3]}`)
    if (!issue) return send(res, 404, { message: 'Not Found' })
    if (req.method === 'GET') return send(res, 200, ghIssueRest(issue))
    if (req.method === 'PATCH') {
      const body = await readBody(req)
      log({ path, method: req.method, body })
      if (body.state && !['open', 'closed'].includes(body.state)) return send(res, 422, { message: 'Validation Failed' })
      if (body.state) issue.state = body.state
      return send(res, 200, ghIssueRest(issue))
    }
  }
  return send(res, 404, { message: `Fixture has no GitHub handler for ${req.method} ${path}` })
}

// --------------------------------------------------------------- control --

async function control(req, res, path) {
  const body = await readBody(req)
  const linearMatch = path.match(/^\/__fixture\/linear\/issue\/([^/]+)$/)
  if (linearMatch) {
    const issue = linear.issues.find((i) => i.identifier === decodeURIComponent(linearMatch[1]))
    if (!issue) return send(res, 404, { error: 'no such issue' })
    const team = linearTeam(issue.team)
    if (body.state) {
      const state = team.states.find((s) => s.name === body.state || s.id === body.state)
      if (!state) return send(res, 400, { error: 'no such state' })
      issue.state = state.id
    }
    if ('cycle' in body) issue.cycle = body.cycle === null ? null : team.cycles.find((c) => c.number === body.cycle)?.id ?? null
    if (typeof body.title === 'string') issue.title = body.title
    if (typeof body.description === 'string') issue.description = body.description
    if ('assignee' in body) issue.assignee = body.assignee
    if (typeof body.deleted === 'boolean') issue.deleted = body.deleted
    return send(res, 200, { ok: true })
  }
  if (path === '/__fixture/linear/bulk') {
    const team = linearTeam(body.team)
    if (!team) return send(res, 404, { error: 'no such team' })
    const states = team.states.map((s) => s.id)
    const text = 'Context for the agent. '.repeat(Math.ceil((body.descriptionBytes ?? 0) / 23)).slice(0, body.descriptionBytes ?? 0)
    for (let n = 0; n < (body.count ?? 0); n += 1) {
      const number = 1000 + linear.issues.length
      linear.issues.push({
        id: `bulk-${number}`,
        identifier: `${team.key}-${number}`,
        team: team.id,
        title: `Bulk issue ${number}`,
        description: text,
        priority: 'Medium',
        assignee: null,
        state: states[n % states.length],
        cycle: null,
        labels: [],
      })
    }
    return send(res, 200, { ok: true, issues: linear.issues.length })
  }
  if (path === '/__fixture/github/item') {
    const item = github.items.find((i) => i.project === body.project && i.issue === body.key)
    if (!item) return send(res, 404, { error: 'no such item' })
    const project = ghProject(item.project)
    if ('status' in body) item.status = body.status === null ? null : project.status.options.find((o) => o.name === body.status)?.id
    if ('iteration' in body) item.iteration = body.iteration === null ? null : project.iteration.iterations.find((i) => i.title === body.iteration)?.id
    if (typeof body.deleted === 'boolean') item.deleted = body.deleted
    return send(res, 200, { ok: true })
  }
  if (path === '/__fixture/github/projects-error') {
    github.projectsError = body.message ? { type: body.type ?? 'INSUFFICIENT_SCOPES', message: body.message } : null
    return send(res, 200, { ok: true })
  }
  if (path === '/__fixture/github/issue') {
    const issue = github.issues.find((i) => `${i.repo}#${i.number}` === body.key)
    if (!issue) return send(res, 404, { error: 'no such issue' })
    if (body.state) issue.state = body.state
    if (typeof body.title === 'string') issue.title = body.title
    if (typeof body.deleted === 'boolean') issue.deleted = body.deleted
    return send(res, 200, { ok: true })
  }
  return send(res, 404, { error: 'no such control' })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.local')
  const path = url.pathname
  try {
    if (path.startsWith('/__fixture/') && req.method === 'POST') return await control(req, res, path)
    const auth = req.headers.authorization ?? ''
    if (path.startsWith('/linear/')) {
      if (auth !== linear.apiKey && auth !== `Bearer ${linear.apiKey}`) {
        return send(res, 400, { errors: [{ message: 'Authentication required, not authenticated', extensions: { code: 'AUTHENTICATION_ERROR' } }] })
      }
      if (req.method === 'POST' && path === '/linear/graphql') {
        const body = await readBody(req)
        const op = operation(body.query ?? '')
        log({ service: 'linear', op, variables: body.variables })
        return send(res, 200, linearGraphql(op, body.variables ?? {}))
      }
      return send(res, 404, { errors: [{ message: 'not found' }] })
    }
    if (path.startsWith('/github/')) {
      if (auth !== `Bearer ${github.token}` && auth !== `token ${github.token}`) {
        return send(res, 401, { message: 'Bad credentials' })
      }
      if (req.method === 'POST' && path === '/github/graphql') {
        const body = await readBody(req)
        const op = operation(body.query ?? '')
        log({ service: 'github', op, variables: body.variables })
        return send(res, 200, ghGraphql(op, body.variables ?? {}))
      }
      log({ service: 'github', method: req.method, path })
      return await githubRest(req, res, path, url)
    }
    return send(res, 404, { message: 'unknown service' })
  } catch (error) {
    return send(res, 500, { message: String(error) })
  }
})

server.listen(Number(values.port), '127.0.0.1', () => {
  process.stdout.write(`LISTEN ${server.address().port}\n`)
})
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)))
