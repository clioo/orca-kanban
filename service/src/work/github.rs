//! GitHub as a Work board source: Projects and repository issues.
//!
//! - A **Project** board (`project:<node id>`): its columns are the
//!   options of the Status single-select field (plus "No Status"); an
//!   Iteration field makes it a sprint board whose sprints are its
//!   iterations; a Priority single-select field feeds the card's priority.
//!   Issues are project items, keyed `owner/repo#12`; a status push sets the
//!   Status field, a sprint move the Iteration field (GraphQL).
//! - A **repository's issues** (`repo:<owner>/<name>`): a kanban board with
//!   two statuses, Open and Closed; a push opens or closes the issue (REST).
//!
//! The token is the `gh` login's, or a pasted one; the API URL defaults to
//! api.github.com and can name a GitHub Enterprise server.

use chrono::{DateTime, Duration as ChronoDuration, NaiveDate};
use serde_json::{Value, json};

use super::provider::{
    CreateOptions, ExtBoard, ExtColumn, ExtIssue, ExtSprint, ExtStatus, IssueRef, IssueScope,
    NewIssue, ProviderError, ProviderResult, WorkProvider,
};
use crate::jira::client::{HttpRequest, JiraRequestError, REQUEST_TIMEOUT, http_json};

pub(crate) const DEFAULT_API_URL: &str = "https://api.github.com";
/// The pseudo status of a project item with no Status value.
pub(crate) const NO_STATUS: &str = "none";

pub(crate) struct GithubProvider {
    token: String,
    api_url: String,
    warnings: std::cell::RefCell<Vec<String>>,
    /// The token's login, read once (issues with several assignees count
    /// as "assigned to me" when the login is among them).
    viewer: std::cell::RefCell<Option<String>>,
}

/// Why Projects could not be listed, and what to do about it.
pub(crate) fn projects_warning(message: &str) -> String {
    if message.contains("scope") {
        "Your GitHub login can't read Projects: it needs the read:project scope. Run `gh auth refresh -s read:project,project` (or use a token with project access), then open this list again. Repositories are listed below.".to_string()
    } else {
        format!("GitHub Projects could not be listed ({message}). Repositories are listed below.")
    }
}

enum BoardRef<'a> {
    Project(&'a str),
    Repo(&'a str),
}

fn board_ref(id: &str) -> ProviderResult<BoardRef<'_>> {
    if let Some(project) = id.strip_prefix("project:") {
        Ok(BoardRef::Project(project))
    } else if let Some(repo) = id.strip_prefix("repo:")
        && repo.split('/').count() == 2
    {
        Ok(BoardRef::Repo(repo))
    } else {
        Err(ProviderError::new(
            "invalid_argument",
            format!("{id} is not a GitHub board (project:<id> or repo:<owner>/<name>)"),
        ))
    }
}

fn request_error(error: JiraRequestError) -> ProviderError {
    let code = match error.status() {
        Some(401) => "github_auth_required",
        Some(404) => "not_found",
        _ => "github_error",
    };
    ProviderError::new(code, crate::jira::client::failure_message(&error))
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

/// The category a status reads as, from its name (GitHub statuses are free
/// text).
pub(crate) fn category_for(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if [
        "done", "closed", "complete", "shipped", "released", "merged",
    ]
    .iter()
    .any(|w| lower.contains(w))
    {
        "done"
    } else if ["progress", "review", "doing", "testing", "qa", "block"]
        .iter()
        .any(|w| lower.contains(w))
    {
        "indeterminate"
    } else {
        "new"
    }
}

fn today() -> NaiveDate {
    DateTime::from_timestamp_millis(crate::now_unix_ms() as i64)
        .map(|d| d.date_naive())
        .unwrap_or_default()
}

/// An iteration as a sprint: completed ones are closed, the one covering
/// today is active, the rest are future.
fn map_iteration(raw: &Value, completed: bool, today: NaiveDate) -> Option<ExtSprint> {
    let id = raw["id"]
        .as_str()
        .or(raw["iterationId"].as_str())?
        .to_string();
    let start = raw["startDate"]
        .as_str()
        .and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
    let duration = raw["duration"].as_i64().unwrap_or(0);
    let end = start.map(|s| s + ChronoDuration::days(duration));
    let state = if completed || end.is_some_and(|e| e <= today) {
        "closed"
    } else if start.is_some_and(|s| s <= today) {
        "active"
    } else {
        "future"
    };
    Some(ExtSprint {
        id,
        name: text(&raw["title"]),
        state: state.into(),
        start: start.map(|d| format!("{d}T00:00:00Z")),
        end: end.map(|d| format!("{d}T00:00:00Z")),
    })
}

struct ProjectFields {
    title: String,
    owner: String,
    status: Option<(String, Vec<(String, String)>)>,
    priority: Option<String>,
    iteration: Option<(String, Vec<ExtSprint>)>,
}

impl GithubProvider {
    pub(crate) fn new(token: String, api_url: Option<String>) -> Self {
        Self {
            token,
            api_url: api_url
                .filter(|u| !u.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_API_URL.to_string())
                .trim_end_matches('/')
                .to_string(),
            warnings: std::cell::RefCell::new(Vec::new()),
            viewer: std::cell::RefCell::new(None),
        }
    }

    /// The assignee a card shows and matches: the connected account when it
    /// is among the assignees, else the first. `(display name, login)`.
    fn pick_assignee(&self, nodes: &Value) -> (Option<String>, Option<String>) {
        let people = nodes.as_array().cloned().unwrap_or_default();
        let viewer = self.viewer.borrow().clone();
        let chosen = people
            .iter()
            .find(|p| viewer.is_some() && p["login"].as_str() == viewer.as_deref())
            .or(people.first());
        match chosen {
            Some(p) => {
                let login = text(&p["login"]);
                let name = p["name"]
                    .as_str()
                    .filter(|n| !n.is_empty())
                    .map(str::to_owned)
                    .unwrap_or(login.clone());
                (Some(name), Some(login))
            }
            None => (None, None),
        }
    }

    /// GraphQL lives beside REST: `<api>/graphql`, or `/api/graphql` for a
    /// GitHub Enterprise server's `/api/v3`.
    fn graphql_url(&self) -> String {
        match self.api_url.strip_suffix("/api/v3") {
            Some(host) => format!("{host}/api/graphql"),
            None => format!("{}/graphql", self.api_url),
        }
    }

    fn rest(&self, method: &str, path: &str, body: Option<Value>) -> ProviderResult<Value> {
        let authorization = format!("Bearer {}", self.token);
        let request = HttpRequest {
            url: format!("{}{path}", self.api_url),
            method,
            authorization: &authorization,
            body: body.map(|b| b.to_string()),
            cancel: None,
            timeout: REQUEST_TIMEOUT,
        };
        http_json(&request, "GitHub").map_err(request_error)
    }

    fn gql(&self, query: &str, variables: Value) -> ProviderResult<Value> {
        let authorization = format!("Bearer {}", self.token);
        let request = HttpRequest {
            url: self.graphql_url(),
            method: "POST",
            authorization: &authorization,
            body: Some(json!({ "query": query, "variables": variables }).to_string()),
            cancel: None,
            timeout: REQUEST_TIMEOUT,
        };
        let value = http_json(&request, "GitHub").map_err(request_error)?;
        if let Some(errors) = value.get("errors").and_then(Value::as_array)
            && !errors.is_empty()
        {
            let message = errors
                .iter()
                .filter_map(|e| e["message"].as_str())
                .collect::<Vec<_>>()
                .join("; ");
            let code = if errors.iter().any(|e| e["type"] == "NOT_FOUND")
                || message.contains("Could not resolve")
            {
                "not_found"
            } else {
                "github_error"
            };
            return Err(ProviderError::new(code, message));
        }
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    }

    /// The login behind the token.
    pub(crate) fn viewer(&self) -> ProviderResult<String> {
        Ok(text(&self.rest("GET", "/user", None)?["login"]))
    }

    fn project(&self, id: &str) -> ProviderResult<ProjectFields> {
        let data = self.gql(
            "query DrogonGhProject($id: ID!) { node(id: $id) { ... on ProjectV2 {
               id number title closed owner { ... on User { login } ... on Organization { login } }
               fields(first: 50) { nodes { __typename
                 ... on ProjectV2Field { id name }
                 ... on ProjectV2SingleSelectField { id name options { id name } }
                 ... on ProjectV2IterationField { id name configuration {
                   iterations { id title startDate duration }
                   completedIterations { id title startDate duration } } }
               } } } } }",
            json!({ "id": id }),
        )?;
        let node = &data["node"];
        if node.is_null() {
            return Err(ProviderError::new(
                "not_found",
                format!("GitHub project {id} not found"),
            ));
        }
        let fields = node["fields"]["nodes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let selects: Vec<&Value> = fields
            .iter()
            .filter(|f| f["__typename"] == "ProjectV2SingleSelectField")
            .collect();
        let named = |name: &str| {
            selects
                .iter()
                .find(|f| text(&f["name"]).eq_ignore_ascii_case(name))
                .copied()
        };
        let status = named("Status").or(selects.first().copied()).map(|f| {
            (
                text(&f["id"]),
                f["options"]
                    .as_array()
                    .map(|o| {
                        o.iter()
                            .map(|x| (text(&x["id"]), text(&x["name"])))
                            .collect()
                    })
                    .unwrap_or_default(),
            )
        });
        let priority = named("Priority").map(|f| text(&f["id"]));
        let today = today();
        let iteration = fields
            .iter()
            .find(|f| f["__typename"] == "ProjectV2IterationField")
            .map(|f| {
                let config = &f["configuration"];
                let mut sprints: Vec<ExtSprint> = config["completedIterations"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|i| map_iteration(i, true, today))
                    .collect();
                sprints.extend(
                    config["iterations"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|i| map_iteration(i, false, today)),
                );
                sprints.sort_by(|a, b| a.start.cmp(&b.start));
                (text(&f["id"]), sprints)
            });
        Ok(ProjectFields {
            title: text(&node["title"]),
            owner: text(&node["owner"]["login"]),
            status,
            priority,
            iteration,
        })
    }

    fn project_statuses(fields: &ProjectFields) -> Vec<ExtStatus> {
        let mut out = vec![ExtStatus {
            id: NO_STATUS.into(),
            name: "No Status".into(),
            category: "new".into(),
        }];
        if let Some((_, options)) = &fields.status {
            out.extend(options.iter().map(|(id, name)| ExtStatus {
                id: id.clone(),
                name: name.clone(),
                category: category_for(name).into(),
            }));
        }
        out
    }

    fn map_item(&self, raw: &Value, fields: &ProjectFields) -> Option<ExtIssue> {
        let content = &raw["content"];
        let kind = content["__typename"].as_str()?;
        if kind != "Issue" && kind != "PullRequest" {
            return None; // drafts have no issue to link or push
        }
        let repo = text(&content["repository"]["nameWithOwner"]);
        let number = content["number"].as_i64()?;
        let values = raw["fieldValues"]["nodes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let field_value = |field: &Option<String>, kind: &str| {
            let field = field.as_ref()?;
            values
                .iter()
                .find(|v| v["__typename"] == kind && v["field"]["id"].as_str() == Some(field))
                .cloned()
        };
        let status_field = fields.status.as_ref().map(|(id, _)| id.clone());
        let status = match field_value(&status_field, "ProjectV2ItemFieldSingleSelectValue") {
            Some(v) => ExtStatus {
                id: text(&v["optionId"]),
                name: text(&v["name"]),
                category: category_for(&text(&v["name"])).into(),
            },
            None => ExtStatus {
                id: NO_STATUS.into(),
                name: "No Status".into(),
                category: "new".into(),
            },
        };
        let priority = field_value(&fields.priority, "ProjectV2ItemFieldSingleSelectValue")
            .map(|v| text(&v["name"]));
        let iteration_field = fields.iteration.as_ref().map(|(id, _)| id.clone());
        let sprint =
            field_value(&iteration_field, "ProjectV2ItemFieldIterationValue").and_then(|v| {
                let id = text(&v["iterationId"]);
                fields
                    .iteration
                    .as_ref()
                    .and_then(|(_, all)| all.iter().find(|s| s.id == id).cloned())
                    .or_else(|| map_iteration(&v, false, today()))
            });
        // A closed iteration is history: the item sits in no open sprint.
        let (sprint, closed_sprints) = match sprint {
            Some(s) if s.state == "closed" => (None, vec![s]),
            other => (other, Vec::new()),
        };
        let (assignee, assignee_id) = self.pick_assignee(&content["assignees"]["nodes"]);
        Some(ExtIssue {
            id: text(&raw["id"]),
            key: format!("{repo}#{number}"),
            url: text(&content["url"]),
            title: text(&content["title"]),
            description: text(&content["body"]),
            issue_type: Some(
                if kind == "PullRequest" {
                    "Pull request"
                } else {
                    "Issue"
                }
                .into(),
            ),
            priority,
            assignee,
            assignee_id,
            status,
            sprint,
            closed_sprints,
            project: Some(repo),
            updated: text(&content["updatedAt"]),
        })
    }

    const ITEM_FIELDS: &str = "id isArchived
      content { __typename
        ... on Issue { id number title body url state updatedAt repository { nameWithOwner }
          assignees(first: 5) { nodes { login name } } labels(first: 10) { nodes { name } } }
        ... on PullRequest { id number title body url state updatedAt repository { nameWithOwner }
          assignees(first: 5) { nodes { login name } } } }
      fieldValues(first: 30) { nodes { __typename
        ... on ProjectV2ItemFieldSingleSelectValue { optionId name field { ... on ProjectV2SingleSelectField { id } } }
        ... on ProjectV2ItemFieldIterationValue { iterationId title startDate duration field { ... on ProjectV2IterationField { id } } } } }";

    fn project_items(&self, id: &str, fields: &ProjectFields) -> ProviderResult<Vec<ExtIssue>> {
        let query = format!(
            "query DrogonGhItems($id: ID!, $after: String) {{ node(id: $id) {{ ... on ProjectV2 {{
               items(first: 100, after: $after) {{ nodes {{ {} }} pageInfo {{ hasNextPage endCursor }} }} }} }} }}",
            Self::ITEM_FIELDS
        );
        let mut out = Vec::new();
        let mut after: Option<String> = None;
        for _ in 0..100 {
            let data = self.gql(&query, json!({ "id": id, "after": after }))?;
            let page = &data["node"]["items"];
            for raw in page["nodes"].as_array().cloned().unwrap_or_default() {
                if raw["isArchived"] == true {
                    continue;
                }
                if let Some(issue) = self.map_item(&raw, fields) {
                    out.push(issue);
                }
            }
            if page["pageInfo"]["hasNextPage"] != true {
                break;
            }
            after = page["pageInfo"]["endCursor"].as_str().map(str::to_owned);
        }
        Ok(out)
    }

    fn map_rest_issue(&self, repo: &str, raw: &Value) -> ExtIssue {
        let (assignee, assignee_id) = self.pick_assignee(&raw["assignees"]);
        let open = raw["state"] == "open";
        let number = raw["number"].as_i64().unwrap_or_default();
        ExtIssue {
            id: number.to_string(),
            key: format!("{repo}#{number}"),
            url: text(&raw["html_url"]),
            title: text(&raw["title"]),
            description: text(&raw["body"]),
            issue_type: raw["labels"]
                .as_array()
                .and_then(|l| l.first())
                .and_then(|l| l["name"].as_str())
                .map(str::to_owned)
                .or(Some("Issue".into())),
            priority: None,
            assignee,
            assignee_id,
            status: repo_status(open),
            sprint: None,
            closed_sprints: Vec::new(),
            project: Some(repo.to_string()),
            updated: text(&raw["updated_at"]),
        }
    }

    fn set_field(
        &self,
        project: &str,
        item: &str,
        field: &str,
        value: Option<Value>,
    ) -> ProviderResult<()> {
        match value {
            Some(value) => self.gql(
                "mutation DrogonGhSetField($project: ID!, $item: ID!, $field: ID!, $value: ProjectV2FieldValue!) {
                   updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: $value }) {
                     projectV2Item { id } } }",
                json!({ "project": project, "item": item, "field": field, "value": value }),
            ),
            None => self.gql(
                "mutation DrogonGhClearField($project: ID!, $item: ID!, $field: ID!) {
                   clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field }) {
                     projectV2Item { id } } }",
                json!({ "project": project, "item": item, "field": field }),
            ),
        }
        .map(|_| ())
    }

    /// The project item for an issue: by the item id recorded at import,
    /// else by looking the key up among the project's items.
    fn item_id(
        &self,
        project: &str,
        issue: IssueRef,
        fields: &ProjectFields,
    ) -> ProviderResult<String> {
        if let Some(id) = issue.id {
            return Ok(id.to_string());
        }
        self.project_items(project, fields)?
            .into_iter()
            .find(|i| i.key == issue.key)
            .map(|i| i.id)
            .ok_or_else(|| {
                ProviderError::new("not_found", format!("{} is not on this project", issue.key))
            })
    }
}

fn repo_status(open: bool) -> ExtStatus {
    if open {
        ExtStatus {
            id: "open".into(),
            name: "Open".into(),
            category: "new".into(),
        }
    } else {
        ExtStatus {
            id: "closed".into(),
            name: "Closed".into(),
            category: "done".into(),
        }
    }
}

fn split_key(key: &str) -> ProviderResult<(&str, &str)> {
    key.rsplit_once('#')
        .filter(|(repo, n)| repo.contains('/') && n.parse::<u64>().is_ok())
        .ok_or_else(|| {
            ProviderError::new(
                "invalid_argument",
                format!("{key} is not a GitHub issue key (owner/repo#number)"),
            )
        })
}

impl WorkProvider for GithubProvider {
    fn kind(&self) -> &'static str {
        "github"
    }

    fn site(&self) -> (String, String) {
        let web = if self.api_url == DEFAULT_API_URL {
            "https://github.com".to_string()
        } else {
            self.api_url.trim_end_matches("/api/v3").to_string()
        };
        ("default".into(), web)
    }

    fn me(&self) -> ProviderResult<Option<String>> {
        if let Some(login) = self.viewer.borrow().clone() {
            return Ok(Some(login));
        }
        let login = self.viewer()?;
        *self.viewer.borrow_mut() = Some(login.clone());
        Ok(Some(login))
    }

    fn board_warnings(&self) -> Vec<String> {
        self.warnings.borrow().clone()
    }

    fn list_boards(&self) -> ProviderResult<Vec<ExtBoard>> {
        self.warnings.borrow_mut().clear();
        // Projects need a scope a gh login often lacks (read:project), and
        // GraphQL has its own rate limit: either way the repositories are
        // still listed, with the reason Projects are missing.
        let projects = self.gql(
            "query DrogonGhProjects { viewer { login
               projectsV2(first: 50) { nodes { id number title closed owner { ... on User { login } ... on Organization { login } }
                 fields(first: 30) { nodes { __typename } } } }
               organizations(first: 50) { nodes { login
                 projectsV2(first: 50) { nodes { id number title closed owner { ... on User { login } ... on Organization { login } }
                   fields(first: 30) { nodes { __typename } } } } } } } }",
            json!({}),
        );
        let data = match projects {
            Ok(data) => data,
            Err(error) => {
                self.warnings
                    .borrow_mut()
                    .push(projects_warning(&error.message));
                json!({ "viewer": {} })
            }
        };
        let viewer = &data["viewer"];
        let mut projects: Vec<Value> = viewer["projectsV2"]["nodes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for org in viewer["organizations"]["nodes"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            projects.extend(
                org["projectsV2"]["nodes"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
            );
        }
        let mut boards: Vec<ExtBoard> = projects
            .iter()
            .filter(|p| p["closed"] != true)
            .map(|p| {
                let has_iterations = p["fields"]["nodes"].as_array().is_some_and(|f| {
                    f.iter()
                        .any(|x| x["__typename"] == "ProjectV2IterationField")
                });
                ExtBoard {
                    id: format!("project:{}", text(&p["id"])),
                    name: text(&p["title"]),
                    kind: if has_iterations { "scrum" } else { "kanban" }.into(),
                    project_key: p["owner"]["login"].as_str().map(str::to_owned),
                    project_name: Some(format!("Project #{}", p["number"])),
                }
            })
            .collect();
        for page in 1..=5 {
            let repos = self.rest(
                "GET",
                &format!("/user/repos?per_page=100&sort=pushed&page={page}"),
                None,
            )?;
            let repos = repos.as_array().cloned().unwrap_or_default();
            if repos.is_empty() {
                break;
            }
            boards.extend(repos.iter().filter(|r| r["has_issues"] != false).map(|r| {
                let name = text(&r["full_name"]);
                ExtBoard {
                    id: format!("repo:{name}"),
                    name: format!("{name} issues"),
                    kind: "kanban".into(),
                    project_key: Some(name.clone()),
                    project_name: Some("Repository issues".into()),
                }
            }));
            if repos.len() < 100 {
                break;
            }
        }
        Ok(boards)
    }

    fn board(&self, board_id: &str) -> ProviderResult<ExtBoard> {
        match board_ref(board_id)? {
            BoardRef::Project(id) => {
                let fields = self.project(id)?;
                Ok(ExtBoard {
                    id: board_id.to_string(),
                    name: fields.title.clone(),
                    kind: if fields.iteration.is_some() {
                        "scrum"
                    } else {
                        "kanban"
                    }
                    .into(),
                    project_key: Some(fields.owner.clone()),
                    project_name: Some(fields.title),
                })
            }
            BoardRef::Repo(repo) => {
                self.rest("GET", &format!("/repos/{repo}"), None)
                    .or_else(|e| {
                        // Some servers only expose the issues listing; an
                        // unreadable repo still fails on the listing below.
                        if e.code == "not_found" {
                            self.rest("GET", &format!("/repos/{repo}/issues?per_page=1"), None)
                        } else {
                            Err(e)
                        }
                    })?;
                Ok(ExtBoard {
                    id: board_id.to_string(),
                    name: format!("{repo} issues"),
                    kind: "kanban".into(),
                    project_key: Some(repo.to_string()),
                    project_name: Some("Repository issues".into()),
                })
            }
        }
    }

    fn board_columns(&self, board_id: &str) -> ProviderResult<Vec<ExtColumn>> {
        Ok(self
            .list_statuses(board_id)?
            .into_iter()
            .map(|status| ExtColumn {
                name: status.name.clone(),
                statuses: vec![status],
            })
            .collect())
    }

    fn list_statuses(&self, board_id: &str) -> ProviderResult<Vec<ExtStatus>> {
        match board_ref(board_id)? {
            BoardRef::Project(id) => Ok(Self::project_statuses(&self.project(id)?)),
            BoardRef::Repo(_) => Ok(vec![repo_status(true), repo_status(false)]),
        }
    }

    fn list_sprints(&self, board_id: &str) -> ProviderResult<Vec<ExtSprint>> {
        match board_ref(board_id)? {
            BoardRef::Project(id) => Ok(self
                .project(id)?
                .iteration
                .map(|(_, s)| s)
                .unwrap_or_default()),
            BoardRef::Repo(_) => Ok(Vec::new()),
        }
    }

    fn list_issues(&self, board_id: &str, scope: &IssueScope) -> ProviderResult<Vec<ExtIssue>> {
        // Knowing the login first lets an issue with several assignees read
        // as "assigned to me".
        let _ = self.me();
        let all = match board_ref(board_id)? {
            BoardRef::Project(id) => {
                let fields = self.project(id)?;
                self.project_items(id, &fields)?
            }
            BoardRef::Repo(repo) => {
                let mut out = Vec::new();
                for page in 1..=20 {
                    let raw = self.rest(
                        "GET",
                        &format!("/repos/{repo}/issues?state=all&per_page=100&page={page}"),
                        None,
                    )?;
                    let items = raw.as_array().cloned().unwrap_or_default();
                    out.extend(
                        items
                            .iter()
                            .filter(|i| i.get("pull_request").is_none())
                            .map(|i| self.map_rest_issue(repo, i)),
                    );
                    if items.len() < 100 {
                        break;
                    }
                }
                out
            }
        };
        Ok(match scope {
            // Its listing cannot be narrowed: a sync reads the whole board.
            IssueScope::Board | IssueScope::Sync { .. } => all,
            IssueScope::Backlog => all
                .into_iter()
                .filter(|i| i.sprint.is_none() && i.status.category != "done")
                .collect(),
            IssueScope::Sprint(id) => all
                .into_iter()
                .filter(|i| i.sprint.as_ref().is_some_and(|s| s.id == *id))
                .collect(),
        })
    }

    fn get_issue(&self, board_id: &str, issue: IssueRef) -> ProviderResult<Option<ExtIssue>> {
        match board_ref(board_id)? {
            BoardRef::Project(project) => {
                let fields = self.project(project)?;
                let Some(item) = issue.id else {
                    return Ok(self
                        .project_items(project, &fields)?
                        .into_iter()
                        .find(|i| i.key == issue.key));
                };
                let query = format!(
                    "query DrogonGhItem($id: ID!) {{ node(id: $id) {{ ... on ProjectV2Item {{ {} }} }} }}",
                    Self::ITEM_FIELDS
                );
                match self.gql(&query, json!({ "id": item })) {
                    Ok(data) if data["node"].is_null() => Ok(None),
                    Ok(data) => Ok(self.map_item(&data["node"], &fields)),
                    Err(e) if e.code == "not_found" => Ok(None),
                    Err(e) => Err(e),
                }
            }
            BoardRef::Repo(repo) => {
                let (_, number) = split_key(issue.key)?;
                match self.rest("GET", &format!("/repos/{repo}/issues/{number}"), None) {
                    Ok(raw) => Ok(Some(self.map_rest_issue(repo, &raw))),
                    Err(e) if e.code == "not_found" || e.message.contains("410") => Ok(None),
                    Err(e) => Err(e),
                }
            }
        }
    }

    fn set_status(&self, board_id: &str, issue: IssueRef, status_id: &str) -> ProviderResult<()> {
        match board_ref(board_id)? {
            BoardRef::Project(project) => {
                let fields = self.project(project)?;
                let Some((field, options)) = &fields.status else {
                    return Err(ProviderError::new(
                        "github_error",
                        "this project has no Status field",
                    ));
                };
                let item = self.item_id(project, issue, &fields)?;
                if status_id == NO_STATUS {
                    return self.set_field(project, &item, field, None);
                }
                if !options.iter().any(|(id, _)| id == status_id) {
                    return Err(ProviderError::new(
                        "github_error",
                        format!("the project's Status field has no option {status_id}"),
                    ));
                }
                self.set_field(
                    project,
                    &item,
                    field,
                    Some(json!({ "singleSelectOptionId": status_id })),
                )
            }
            BoardRef::Repo(repo) => {
                let (_, number) = split_key(issue.key)?;
                let state = match status_id {
                    "open" | "closed" => status_id,
                    other => {
                        return Err(ProviderError::new(
                            "github_error",
                            format!("repository issues are open or closed, not {other}"),
                        ));
                    }
                };
                self.rest(
                    "PATCH",
                    &format!("/repos/{repo}/issues/{number}"),
                    Some(json!({ "state": state })),
                )
                .map(|_| ())
            }
        }
    }

    fn move_to_sprint(
        &self,
        board_id: &str,
        issue: IssueRef,
        sprint_id: Option<&str>,
    ) -> ProviderResult<()> {
        match board_ref(board_id)? {
            BoardRef::Project(project) => {
                let fields = self.project(project)?;
                let Some((field, _)) = &fields.iteration else {
                    return Err(ProviderError::new(
                        "github_error",
                        "this project has no Iteration field",
                    ));
                };
                let item = self.item_id(project, issue, &fields)?;
                self.set_field(
                    project,
                    &item,
                    field,
                    sprint_id.map(|id| json!({ "iterationId": id })),
                )
            }
            BoardRef::Repo(_) => Err(ProviderError::new(
                "github_error",
                "repository issues have no iterations",
            )),
        }
    }

    fn create_options(&self, board_id: &str) -> ProviderResult<CreateOptions> {
        match board_ref(board_id)? {
            BoardRef::Project(project) => {
                // The repositories the project already tracks issues from.
                let fields = self.project(project)?;
                let mut repos: Vec<String> = self
                    .project_items(project, &fields)?
                    .into_iter()
                    .filter_map(|i| i.project)
                    .collect();
                repos.sort();
                repos.dedup();
                Ok(CreateOptions {
                    issue_types: Vec::new(),
                    repos,
                })
            }
            BoardRef::Repo(_) => Ok(CreateOptions::default()),
        }
    }

    fn create_issue(
        &self,
        board_id: &str,
        new: &NewIssue,
    ) -> ProviderResult<(ExtIssue, Vec<String>)> {
        let repo = match board_ref(board_id)? {
            BoardRef::Repo(repo) => repo.to_string(),
            BoardRef::Project(_) => new.repo.map(str::to_owned).ok_or_else(|| {
                ProviderError::new(
                    "invalid_argument",
                    "choose the repository to create the issue in",
                )
            })?,
        };
        let mut body = json!({ "title": new.title });
        if !new.description.trim().is_empty() {
            body["body"] = json!(new.description.trim());
        }
        if new.assign_to_me
            && let Some(me) = self.me()?
        {
            body["assignees"] = json!([me]);
        }
        let created = self.rest("POST", &format!("/repos/{repo}/issues"), Some(body))?;
        let mut warnings = Vec::new();
        match board_ref(board_id)? {
            BoardRef::Repo(repo) => {
                let issue = self.map_rest_issue(repo, &created);
                if new.status_id == Some("closed") {
                    self.set_status(
                        board_id,
                        IssueRef {
                            key: &issue.key,
                            id: None,
                        },
                        "closed",
                    )?;
                    let closed = self
                        .get_issue(
                            board_id,
                            IssueRef {
                                key: &issue.key,
                                id: None,
                            },
                        )?
                        .unwrap_or(issue);
                    return Ok((closed, warnings));
                }
                Ok((issue, warnings))
            }
            BoardRef::Project(project) => {
                let content = text(&created["node_id"]);
                let added = self.gql(
                    "mutation DrogonGhAddItem($project: ID!, $content: ID!) {
                       addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }",
                    json!({ "project": project, "content": content }),
                )?;
                let item = text(&added["addProjectV2ItemById"]["item"]["id"]);
                let key = format!("{repo}#{}", created["number"].as_i64().unwrap_or_default());
                let issue = IssueRef {
                    key: &key,
                    id: Some(&item),
                };
                if let Some(status) = new.status_id.filter(|s| *s != NO_STATUS)
                    && let Err(error) = self.set_status(board_id, issue, status)
                {
                    warnings.push(format!("Created with no status: {}", error.message));
                }
                if let Some(sprint) = new.sprint_id
                    && let Err(error) = self.move_to_sprint(board_id, issue, Some(sprint))
                {
                    warnings.push(format!("Created with no iteration: {}", error.message));
                }
                let fresh = self.get_issue(board_id, issue)?.ok_or_else(|| {
                    ProviderError::new(
                        "github_error",
                        format!("{key} was added but cannot be read back"),
                    )
                })?;
                Ok((fresh, warnings))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_warnings_name_the_missing_scope() {
        assert!(
            projects_warning("Your token has not been granted the required scopes")
                .contains("gh auth refresh -s read:project,project")
        );
        assert!(
            projects_warning("API rate limit already exceeded")
                .contains("(API rate limit already exceeded)")
        );
    }

    #[test]
    fn board_ids_name_a_project_or_a_repository() {
        assert!(matches!(
            board_ref("project:PVT_1"),
            Ok(BoardRef::Project("PVT_1"))
        ));
        assert!(matches!(
            board_ref("repo:clioo/drogon"),
            Ok(BoardRef::Repo("clioo/drogon"))
        ));
        assert!(board_ref("repo:nope").is_err());
        assert!(board_ref("7").is_err());
    }

    #[test]
    fn iterations_are_closed_active_or_future_by_date() {
        let today = NaiveDate::from_ymd_opt(2026, 9, 20).unwrap();
        let it =
            |start: &str| json!({"id": "i", "title": "It", "startDate": start, "duration": 14});
        assert_eq!(
            map_iteration(&it("2026-09-15"), false, today)
                .unwrap()
                .state,
            "active"
        );
        assert_eq!(
            map_iteration(&it("2026-09-01"), false, today)
                .unwrap()
                .state,
            "closed"
        );
        assert_eq!(
            map_iteration(&it("2026-09-29"), false, today)
                .unwrap()
                .state,
            "future"
        );
        assert_eq!(
            map_iteration(&it("2026-09-15"), true, today).unwrap().state,
            "closed"
        );
        let active = map_iteration(&it("2026-09-15"), false, today).unwrap();
        assert_eq!(active.end.as_deref(), Some("2026-09-29T00:00:00Z"));
    }

    #[test]
    fn free_text_statuses_get_a_category_and_keys_split() {
        assert_eq!(category_for("Done"), "done");
        assert_eq!(category_for("In Review"), "indeterminate");
        assert_eq!(category_for("Todo"), "new");
        assert_eq!(
            split_key("clioo/drogon#12").unwrap(),
            ("clioo/drogon", "12")
        );
        assert!(split_key("drogon#12").is_err());
        assert!(split_key("clioo/drogon#x").is_err());
    }

    #[test]
    fn enterprise_api_urls_find_their_graphql_endpoint() {
        let cloud = GithubProvider::new("t".into(), None);
        assert_eq!(cloud.graphql_url(), "https://api.github.com/graphql");
        assert_eq!(cloud.site().1, "https://github.com");
        let ghe = GithubProvider::new("t".into(), Some("https://ghe.example/api/v3/".into()));
        assert_eq!(ghe.graphql_url(), "https://ghe.example/api/graphql");
        assert_eq!(ghe.site().1, "https://ghe.example");
    }
}
