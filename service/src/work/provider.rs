//! External ticket providers for the Work board.
//!
//! The board speaks to one trait, [`WorkProvider`]: list boards, read a
//! board's columns and sprints, list and read issues, change an issue's
//! status, and move it between sprints. Implementations: Jira
//! ([`JiraProvider`], agile REST API over the Tasks page's saved Jira
//! connection), Linear (`linear.rs`: teams, workflow states and cycles over
//! GraphQL) and GitHub (`github.rs`: Projects and repository issues). A new
//! source plugs in by implementing the trait, adding its entry to
//! `sources.rs` and one match arm in `Engine::work_provider`; the board,
//! sync and UI code only ever see [`ExtIssue`].

use std::collections::HashMap;

use serde::Serialize;
use serde_json::{Value, json};

use crate::jira::JiraState;
use crate::jira::client::{HttpRequest, JiraRequestError, api_base_path, jira_request};
use crate::jira::mapping::{as_record, as_string, as_string_or};
use crate::jira::ops::{ClientForSite, encode_path_segment, first_client};
use crate::protocol::RpcError;
use crate::protocol::jira::JiraAuthType;

/// An issue as the board knows it: its key (`APP-128`, `ENG-12`,
/// `owner/repo#12`) and, when imported, the provider's own id for it.
#[derive(Debug, Clone, Copy)]
pub(crate) struct IssueRef<'a> {
    pub key: &'a str,
    pub id: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtBoard {
    pub id: String,
    pub name: String,
    /// `scrum` (has sprints) or `kanban`.
    pub kind: String,
    pub project_key: Option<String>,
    pub project_name: Option<String>,
}

/// Your open assigned issues as they touch one board: the ones on it (in
/// its open sprints, or the whole team for Linear) and, for a Jira board,
/// the ones in its project — shared by every board that project has.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct AssignedOpen {
    pub on_board: u32,
    pub in_project: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtStatus {
    pub id: String,
    pub name: String,
    /// `new`, `indeterminate` or `done`.
    pub category: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtColumn {
    pub name: String,
    pub statuses: Vec<ExtStatus>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtSprint {
    pub id: String,
    pub name: String,
    /// `active`, `closed` or `future`.
    pub state: String,
    pub start: Option<String>,
    pub end: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtIssue {
    pub id: String,
    pub key: String,
    pub url: String,
    pub title: String,
    pub description: String,
    pub issue_type: Option<String>,
    pub priority: Option<String>,
    pub assignee: Option<String>,
    /// The assignee's id in the source (Jira account id, Linear user id,
    /// GitHub login): what "assigned to me" compares with [`WorkProvider::me`].
    pub assignee_id: Option<String>,
    pub status: ExtStatus,
    /// The issue's current (active or future) sprint.
    pub sprint: Option<ExtSprint>,
    /// Closed sprints the issue passed through.
    pub closed_sprints: Vec<ExtSprint>,
    pub project: Option<String>,
    pub updated: String,
}

/// A new issue for [`WorkProvider::create_issue`].
#[derive(Debug, Default)]
pub(crate) struct NewIssue<'a> {
    pub title: &'a str,
    pub description: &'a str,
    /// The status it starts in (`None`: the source's default).
    pub status_id: Option<&'a str>,
    /// The sprint it goes into (`None`: the backlog).
    pub sprint_id: Option<&'a str>,
    pub assign_to_me: bool,
    /// Jira: the issue type id (default: Task, else the first standard one).
    pub issue_type: Option<&'a str>,
    /// GitHub Project: the repository the issue is created in.
    pub repo: Option<&'a str>,
}

/// What a create form must offer for a board.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateOptions {
    /// Jira issue types (`{id, name}`), default first.
    pub issue_types: Vec<Value>,
    /// GitHub Project: repositories an issue can be created in.
    pub repos: Vec<String>,
}

/// Which issues of a board to list for import.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum IssueScope {
    Board,
    Backlog,
    Sprint(String),
    /// What a sync reads: the board's issues among `keys` (already imported)
    /// and, with `mine_open`, your unresolved ones (to auto-import). A source
    /// that cannot narrow its listing reads the whole board.
    Sync {
        keys: Vec<String>,
        mine_open: bool,
    },
}

/// A provider failure: the message is shown to the user as is.
#[derive(Debug, Clone)]
pub(crate) struct ProviderError {
    pub code: String,
    pub message: String,
}

impl ProviderError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl From<ProviderError> for RpcError {
    fn from(error: ProviderError) -> Self {
        RpcError::new(&error.code, error.message)
    }
}

pub(crate) type ProviderResult<T> = Result<T, ProviderError>;

pub(crate) trait WorkProvider {
    fn kind(&self) -> &'static str;
    /// The account/site boards are imported from: an id (stable across
    /// reconnects) and the site's web URL.
    fn site(&self) -> (String, String);
    fn list_boards(&self) -> ProviderResult<Vec<ExtBoard>>;
    /// What the last `list_boards` could not list, in the owner's words
    /// (a missing permission, a rate limit); the rest was listed.
    fn board_warnings(&self) -> Vec<String> {
        Vec::new()
    }
    fn board(&self, board_id: &str) -> ProviderResult<ExtBoard>;
    /// The connected account's open assigned issues as they touch each of
    /// `boards`, keyed by board id (boards with none are absent), from one
    /// bounded query. It only ranks the board picker, so a source without
    /// the notion answers empty.
    fn assigned_open_counts(
        &self,
        _boards: &[ExtBoard],
    ) -> ProviderResult<HashMap<String, AssignedOpen>> {
        Ok(HashMap::new())
    }
    fn board_columns(&self, board_id: &str) -> ProviderResult<Vec<ExtColumn>>;
    /// Every status the site knows (what a column can be mapped to).
    fn list_statuses(&self, board_id: &str) -> ProviderResult<Vec<ExtStatus>>;
    /// The connected account's id, as issues carry it in `assignee_id`.
    fn me(&self) -> ProviderResult<Option<String>>;
    /// Every sprint of a scrum board (empty for a kanban board).
    fn list_sprints(&self, board_id: &str) -> ProviderResult<Vec<ExtSprint>>;
    fn list_issues(&self, board_id: &str, scope: &IssueScope) -> ProviderResult<Vec<ExtIssue>>;
    /// `Ok(None)` when the issue no longer exists (or is no longer visible).
    fn get_issue(&self, board_id: &str, issue: IssueRef) -> ProviderResult<Option<ExtIssue>>;
    /// Move the issue to `status_id`; refuses when the provider's workflow
    /// does not allow it.
    fn set_status(&self, board_id: &str, issue: IssueRef, status_id: &str) -> ProviderResult<()>;
    /// Put the issue in `sprint_id`, or in the backlog for `None`.
    fn move_to_sprint(
        &self,
        board_id: &str,
        issue: IssueRef,
        sprint_id: Option<&str>,
    ) -> ProviderResult<()>;
    /// What creating an issue on this board needs chosen.
    fn create_options(&self, _board_id: &str) -> ProviderResult<CreateOptions> {
        Ok(CreateOptions::default())
    }
    /// Creates an issue on the board; the second value lists what could
    /// not be applied (a status the workflow refused), in the owner's words.
    fn create_issue(
        &self,
        board_id: &str,
        new: &NewIssue,
    ) -> ProviderResult<(ExtIssue, Vec<String>)>;
}

// ------------------------------------------------------------------ Jira --

pub(crate) struct JiraProvider<'a> {
    state: &'a JiraState,
    client: ClientForSite,
}

const AGILE: &str = "/rest/agile/1.0";
/// Your open work, for the board picker's recommendations: one page of at
/// most `ASSIGNED_OPEN_LIMIT` issues, only their project.
const ASSIGNED_OPEN_JQL: &str =
    "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC";
const ASSIGNED_OPEN_LIMIT: u32 = 100;
const ISSUE_FIELDS: &str =
    "summary,description,issuetype,priority,status,assignee,project,updated,sprint,closedSprints";

fn jira_error(error: &JiraRequestError) -> ProviderError {
    let rpc = crate::jira::client::to_rpc_error(error);
    ProviderError::new(&rpc.code, rpc.message)
}

impl<'a> JiraProvider<'a> {
    pub(crate) fn new(state: &'a JiraState, site: Option<&str>) -> ProviderResult<Self> {
        let client = first_client(state, site)
            .map_err(|e| ProviderError::new(&e.code, e.message))?
            .ok_or_else(|| {
                ProviderError::new(
                    "jira_not_connected",
                    "Jira is not connected. Connect it in Work → Sources with your site, email and API token.",
                )
            })?;
        Ok(Self { state, client })
    }

    fn api(&self) -> &'static str {
        api_base_path(self.client.site.auth_type)
    }

    fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, JiraRequestError> {
        let queue = self.state.site_queue(&self.client.site.id);
        let _permit = queue.lock().unwrap();
        let request = HttpRequest {
            url: format!("{}{path}", self.client.site.site_url),
            method,
            authorization: &self.client.authorization,
            body: body.map(|b| b.to_string()),
            cancel: None,
            timeout: crate::jira::client::REQUEST_TIMEOUT,
        };
        let result = jira_request(&request);
        if let Err(error) = &result
            && error.status() == Some(401)
        {
            crate::jira::ops::clear_token_for(self.state, &self.client.site.id);
        }
        result
    }

    fn get(&self, path: &str) -> ProviderResult<Value> {
        self.call("GET", path, None).map_err(|e| jira_error(&e))
    }

    /// Walks a paged agile collection (`values` or `issues`).
    fn paged(&self, path: &str, key: &str) -> ProviderResult<Vec<Value>> {
        let mut out = Vec::new();
        let separator = if path.contains('?') { '&' } else { '?' };
        for _ in 0..50 {
            let page = self.get(&format!(
                "{path}{separator}startAt={}&maxResults=50",
                out.len()
            ))?;
            let items = page
                .get(key)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let got = items.len();
            out.extend(items);
            let total = page.get("total").and_then(Value::as_u64);
            let last = page.get("isLast").and_then(Value::as_bool).unwrap_or(false);
            if got == 0 || last || total.is_some_and(|t| out.len() as u64 >= t) {
                break;
            }
        }
        Ok(out)
    }

    /// The site's Sprint custom field (`customfield_10020` on most Cloud
    /// sites, but it varies); `None` when it cannot be read.
    fn sprint_field_id(&self) -> Option<String> {
        let raw = self.get(&format!("{}/field", self.api())).ok()?;
        raw.as_array()?.iter().find_map(|field| {
            (field.pointer("/schema/custom").and_then(Value::as_str)
                == Some("com.pyxis.greenhopper.jira:gh-sprint"))
            .then(|| field.get("id").and_then(Value::as_str).map(str::to_owned))
            .flatten()
        })
    }

    /// The project's standard issue types as `{id, name}`, Task first
    /// (the Tasks page's createmeta reader, with its envelope handling).
    fn issue_types(&self, project: &str) -> ProviderResult<Vec<Value>> {
        let mut types: Vec<Value> =
            crate::jira::ops::list_issue_types(self.state, project, Some(&self.client.site.id))
                .map_err(|e| ProviderError::new(&e.code, e.message))?
                .into_iter()
                .filter(|t| t.subtask != Some(true))
                .map(|t| json!({ "id": t.id, "name": t.name }))
                .collect();
        types.sort_by_key(|t| t["name"] != "Task");
        Ok(types)
    }

    fn statuses(&self) -> ProviderResult<Vec<ExtStatus>> {
        let raw = self.get(&format!("{}/status", self.api()))?;
        Ok(raw
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|s| map_status(Some(s)))
            .collect())
    }

    fn map_issue(&self, raw: &Value) -> ExtIssue {
        let fields = as_record(raw.get("fields"));
        let key = as_string(raw.get("key"));
        let named = |field: &str| {
            fields
                .get(field)
                .and_then(|v| v.get("name").or_else(|| v.get("displayName")))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let description = match fields.get("description") {
            Some(Value::String(text)) => text.clone(),
            other => crate::jira::adf::adf_to_markdown_text(other),
        };
        ExtIssue {
            id: as_string_or(raw.get("id"), &key),
            url: format!("{}/browse/{key}", self.client.site.site_url),
            title: as_string(fields.get("summary")),
            description,
            issue_type: named("issuetype"),
            priority: named("priority"),
            assignee: fields
                .get("assignee")
                .and_then(|v| v.get("displayName"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            // Cloud names people by accountId; Server/DC by name or key.
            assignee_id: fields.get("assignee").and_then(|v| {
                ["accountId", "name", "key"]
                    .iter()
                    .find_map(|f| v.get(*f).and_then(Value::as_str).filter(|s| !s.is_empty()))
                    .map(str::to_owned)
            }),
            status: map_status(fields.get("status")),
            sprint: fields.get("sprint").and_then(map_sprint),
            closed_sprints: fields
                .get("closedSprints")
                .and_then(Value::as_array)
                .map(|all| all.iter().filter_map(map_sprint).collect())
                .unwrap_or_default(),
            project: fields
                .get("project")
                .and_then(|v| v.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            updated: as_string(fields.get("updated")),
            key,
        }
    }

    fn map_board(raw: &Value) -> ExtBoard {
        let location = raw.get("location");
        let text = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_owned);
        ExtBoard {
            id: match raw.get("id") {
                Some(Value::Number(n)) => n.to_string(),
                other => as_string(other),
            },
            name: as_string(raw.get("name")),
            kind: as_string_or(raw.get("type"), "kanban"),
            project_key: text(location.and_then(|l| l.get("projectKey"))),
            project_name: text(location.and_then(|l| l.get("projectName"))),
        }
    }
}

/// Imported keys per sync query: short enough for a URL, few enough queries.
const SYNC_KEYS_PER_QUERY: usize = 100;
const MINE_OPEN_JQL: &str = "assignee = currentUser() AND resolution = Unresolved";

/// The JQL a sync asks a board with: the imported keys in batches, your open
/// issues with the first batch (or alone); none when there is nothing to ask.
fn sync_jqls(keys: &[String], mine_open: bool) -> Vec<String> {
    let mut queries: Vec<String> = keys
        .chunks(SYNC_KEYS_PER_QUERY)
        .map(|chunk| {
            let quoted: Vec<String> = chunk
                .iter()
                .map(|k| format!("\"{}\"", k.replace(['\\', '"'], "")))
                .collect();
            format!("key in ({})", quoted.join(","))
        })
        .collect();
    if mine_open {
        match queries.first_mut() {
            Some(first) => *first = format!("{first} OR ({MINE_OPEN_JQL})"),
            None => queries.push(MINE_OPEN_JQL.to_string()),
        }
    }
    queries
}

/// The boards an issue's Sprint field puts it on, open sprints only (an
/// open issue in a closed sprint was carried over; that board is history).
/// Cloud returns sprint objects; Server/DC GreenHopper's string form
/// (`…Sprint@1a[id=25,rapidViewId=7,state=ACTIVE,…]`).
fn sprint_boards(value: Option<&Value>) -> Vec<String> {
    let mut boards: Vec<String> = Vec::new();
    for sprint in value.and_then(Value::as_array).into_iter().flatten() {
        let (board, state) = match sprint {
            Value::Object(_) => (
                match sprint
                    .get("boardId")
                    .or_else(|| sprint.get("originBoardId"))
                {
                    Some(Value::Number(n)) => Some(n.to_string()),
                    Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
                    _ => None,
                },
                sprint
                    .get("state")
                    .and_then(Value::as_str)
                    .map(str::to_lowercase),
            ),
            Value::String(text) => {
                let attr = |name: &str| {
                    let start = text.find(&format!("{name}="))? + name.len() + 1;
                    let rest = &text[start..];
                    Some(rest[..rest.find([',', ']']).unwrap_or(rest.len())].to_string())
                };
                (
                    attr("rapidViewId").filter(|b| !b.is_empty() && b != "<null>"),
                    attr("state").map(|s| s.to_lowercase()),
                )
            }
            _ => (None, None),
        };
        if let Some(board) = board
            && state.as_deref() != Some("closed")
            && !boards.contains(&board)
        {
            boards.push(board);
        }
    }
    boards
}

/// Spreads a Jira search reply of your open issues onto `boards`: each
/// board's own (through open sprints) and its project's.
fn jira_assigned_by_board(
    boards: &[ExtBoard],
    raw: &Value,
    sprint_field: Option<&str>,
) -> HashMap<String, AssignedOpen> {
    let mut by_project: HashMap<String, u32> = HashMap::new();
    let mut by_board: HashMap<String, u32> = HashMap::new();
    for issue in raw
        .get("issues")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(key) = issue
            .pointer("/fields/project/key")
            .and_then(Value::as_str)
            .filter(|k| !k.is_empty())
        {
            *by_project.entry(key.to_string()).or_insert(0) += 1;
        }
        if let Some(field) = sprint_field {
            for board in sprint_boards(issue.get("fields").and_then(|f| f.get(field))) {
                *by_board.entry(board).or_insert(0) += 1;
            }
        }
    }
    boards
        .iter()
        .filter_map(|board| {
            let counts = AssignedOpen {
                on_board: by_board.get(&board.id).copied().unwrap_or(0),
                in_project: board
                    .project_key
                    .as_deref()
                    .and_then(|key| by_project.get(key))
                    .copied()
                    .unwrap_or(0),
            };
            (counts != AssignedOpen::default()).then(|| (board.id.clone(), counts))
        })
        .collect()
}

fn map_status(value: Option<&Value>) -> ExtStatus {
    let status = as_record(value);
    let category = as_record(status.get("statusCategory"));
    ExtStatus {
        id: as_string(status.get("id")),
        name: as_string_or(status.get("name"), "Unknown"),
        category: as_string_or(category.get("key"), "undefined"),
    }
}

fn map_sprint(raw: &Value) -> Option<ExtSprint> {
    if raw.is_null() {
        return None;
    }
    let id = match raw.get("id") {
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::String(s)) => s.clone(),
        _ => return None,
    };
    let text = |f: &str| raw.get(f).and_then(Value::as_str).map(str::to_owned);
    Some(ExtSprint {
        id,
        name: text("name").unwrap_or_default(),
        state: text("state")
            .unwrap_or_else(|| "future".into())
            .to_lowercase(),
        start: text("startDate"),
        end: text("endDate"),
    })
}

impl WorkProvider for JiraProvider<'_> {
    fn kind(&self) -> &'static str {
        "jira"
    }

    fn site(&self) -> (String, String) {
        (
            self.client.site.id.clone(),
            self.client.site.site_url.clone(),
        )
    }

    fn list_boards(&self) -> ProviderResult<Vec<ExtBoard>> {
        Ok(self
            .paged(&format!("{AGILE}/board"), "values")?
            .iter()
            .map(Self::map_board)
            .collect())
    }

    fn assigned_open_counts(
        &self,
        boards: &[ExtBoard],
    ) -> ProviderResult<HashMap<String, AssignedOpen>> {
        // A board's own share comes from the sprints your issues are in; the
        // site names its Sprint field, so look it up (none: projects only).
        let sprint_field = self.sprint_field_id();
        let mut fields = vec!["project".to_string()];
        fields.extend(sprint_field.clone());
        // Server/DC only has the classic `/search`; `/search/jql` is Cloud's.
        let path = match self.client.site.auth_type {
            JiraAuthType::Server => format!("{}/search", self.api()),
            JiraAuthType::Cloud => "/rest/api/3/search/jql".to_string(),
        };
        let body = json!({
            "jql": ASSIGNED_OPEN_JQL,
            "maxResults": ASSIGNED_OPEN_LIMIT,
            "fields": fields,
        });
        let raw = self
            .call("POST", &path, Some(body))
            .map_err(|e| jira_error(&e))?;
        Ok(jira_assigned_by_board(
            boards,
            &raw,
            sprint_field.as_deref(),
        ))
    }

    fn board(&self, board_id: &str) -> ProviderResult<ExtBoard> {
        let raw = self.get(&format!("{AGILE}/board/{}", encode_path_segment(board_id)));
        match raw {
            Ok(raw) => Ok(Self::map_board(&raw)),
            // Some sites answer the board collection but not the item; fall
            // back to the collection.
            Err(_) => self
                .list_boards()?
                .into_iter()
                .find(|b| b.id == board_id)
                .ok_or_else(|| {
                    ProviderError::new("not_found", format!("Jira board {board_id} not found"))
                }),
        }
    }

    fn board_columns(&self, board_id: &str) -> ProviderResult<Vec<ExtColumn>> {
        let config = self.get(&format!(
            "{AGILE}/board/{}/configuration",
            encode_path_segment(board_id)
        ))?;
        let names = self.statuses().unwrap_or_default();
        let columns = config
            .get("columnConfig")
            .and_then(|c| c.get("columns"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(columns
            .iter()
            .map(|column| ExtColumn {
                name: as_string(column.get("name")),
                statuses: column
                    .get("statuses")
                    .and_then(Value::as_array)
                    .map(|all| {
                        all.iter()
                            .map(|s| {
                                let id = as_string(s.get("id"));
                                names
                                    .iter()
                                    .find(|n| n.id == id)
                                    .cloned()
                                    .unwrap_or(ExtStatus {
                                        name: id.clone(),
                                        id,
                                        category: "undefined".into(),
                                    })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
            .collect())
    }

    fn me(&self) -> ProviderResult<Option<String>> {
        Ok(Some(self.client.site.account_id.clone()).filter(|id| !id.is_empty()))
    }

    fn list_statuses(&self, _board_id: &str) -> ProviderResult<Vec<ExtStatus>> {
        self.statuses()
    }

    fn list_sprints(&self, board_id: &str) -> ProviderResult<Vec<ExtSprint>> {
        let board = self.board(board_id)?;
        if board.kind != "scrum" {
            return Ok(Vec::new());
        }
        Ok(self
            .paged(
                &format!(
                    "{AGILE}/board/{}/sprint?state=active,closed,future",
                    encode_path_segment(board_id)
                ),
                "values",
            )?
            .iter()
            .filter_map(map_sprint)
            .collect())
    }

    fn list_issues(&self, board_id: &str, scope: &IssueScope) -> ProviderResult<Vec<ExtIssue>> {
        let board = encode_path_segment(board_id);
        if let IssueScope::Sync { keys, mine_open } = scope {
            // A big board's whole history is thousands of issues; a sync only
            // needs the imported ones and your open work, asked by JQL.
            let mut out: Vec<ExtIssue> = Vec::new();
            for jql in sync_jqls(keys, *mine_open) {
                let path = format!(
                    "{AGILE}/board/{board}/issue?fields={ISSUE_FIELDS}&jql={}",
                    url::form_urlencoded::byte_serialize(jql.as_bytes()).collect::<String>()
                );
                for raw in self.paged(&path, "issues")? {
                    let issue = self.map_issue(&raw);
                    if !out.iter().any(|i| i.key == issue.key) {
                        out.push(issue);
                    }
                }
            }
            return Ok(out);
        }
        let path = match scope {
            IssueScope::Sync { .. } => unreachable!("handled above"),
            IssueScope::Board => format!("{AGILE}/board/{board}/issue?fields={ISSUE_FIELDS}"),
            IssueScope::Backlog => format!("{AGILE}/board/{board}/backlog?fields={ISSUE_FIELDS}"),
            IssueScope::Sprint(id) => format!(
                "{AGILE}/board/{board}/sprint/{}/issue?fields={ISSUE_FIELDS}",
                encode_path_segment(id)
            ),
        };
        Ok(self
            .paged(&path, "issues")?
            .iter()
            .map(|raw| self.map_issue(raw))
            .collect())
    }

    fn get_issue(&self, _board_id: &str, issue: IssueRef) -> ProviderResult<Option<ExtIssue>> {
        let key = issue.key;
        match self.call(
            "GET",
            &format!(
                "{AGILE}/issue/{}?fields={ISSUE_FIELDS}",
                encode_path_segment(key)
            ),
            None,
        ) {
            Ok(raw) => Ok(Some(self.map_issue(&raw))),
            Err(error) if error.status() == Some(404) => Ok(None),
            Err(error) => Err(jira_error(&error)),
        }
    }

    fn set_status(&self, _board_id: &str, issue: IssueRef, status_id: &str) -> ProviderResult<()> {
        let key = issue.key;
        let listed = self.get(&format!(
            "{}/issue/{}/transitions",
            self.api(),
            encode_path_segment(key)
        ))?;
        let transitions = listed
            .get("transitions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let Some(transition) = transitions
            .iter()
            .find(|t| t.get("to").map(|to| as_string(to.get("id"))).as_deref() == Some(status_id))
        else {
            let reachable: Vec<String> = transitions
                .iter()
                .filter_map(|t| {
                    t.get("to")
                        .and_then(|to| to.get("name"))
                        .and_then(Value::as_str)
                })
                .map(str::to_owned)
                .collect();
            return Err(ProviderError::new(
                "jira_transition_refused",
                format!(
                    "Jira's workflow has no transition from this issue's status to that one (reachable: {})",
                    if reachable.is_empty() {
                        "none".to_string()
                    } else {
                        reachable.join(", ")
                    }
                ),
            ));
        };
        self.call(
            "POST",
            &format!(
                "{}/issue/{}/transitions",
                self.api(),
                encode_path_segment(key)
            ),
            Some(json!({ "transition": { "id": as_string(transition.get("id")) } })),
        )
        .map(|_| ())
        .map_err(|e| jira_error(&e))
    }

    fn move_to_sprint(
        &self,
        _board_id: &str,
        issue: IssueRef,
        sprint_id: Option<&str>,
    ) -> ProviderResult<()> {
        let key = issue.key;
        let path = match sprint_id {
            Some(id) => format!("{AGILE}/sprint/{}/issue", encode_path_segment(id)),
            None => format!("{AGILE}/backlog/issue"),
        };
        self.call("POST", &path, Some(json!({ "issues": [key] })))
            .map(|_| ())
            .map_err(|e| jira_error(&e))
    }

    fn create_options(&self, board_id: &str) -> ProviderResult<CreateOptions> {
        let board = self.board(board_id)?;
        let Some(project) = board.project_key else {
            return Ok(CreateOptions::default());
        };
        Ok(CreateOptions {
            issue_types: self.issue_types(&project)?,
            repos: Vec::new(),
        })
    }

    fn create_issue(
        &self,
        board_id: &str,
        new: &NewIssue,
    ) -> ProviderResult<(ExtIssue, Vec<String>)> {
        let board = self.board(board_id)?;
        let project = board.project_key.ok_or_else(|| {
            ProviderError::new(
                "invalid_argument",
                "this Jira board has no project to create issues in",
            )
        })?;
        let issue_type = match new.issue_type {
            Some(id) => id.to_string(),
            None => self
                .issue_types(&project)?
                .first()
                .and_then(|t| t["id"].as_str().map(str::to_owned))
                .ok_or_else(|| {
                    ProviderError::new(
                        "jira_error",
                        format!("{project} has no issue type to create"),
                    )
                })?,
        };
        let mut fields = json!({
            "project": { "key": project },
            "issuetype": { "id": issue_type },
            "summary": new.title,
        });
        if !new.description.trim().is_empty() {
            fields["description"] =
                crate::jira::adf::to_body_text(self.client.site.auth_type, new.description.trim());
        }
        if new.assign_to_me && !self.client.site.account_id.is_empty() {
            fields["assignee"] = match self.client.site.auth_type {
                crate::protocol::jira::JiraAuthType::Cloud => {
                    json!({ "accountId": self.client.site.account_id })
                }
                crate::protocol::jira::JiraAuthType::Server => {
                    json!({ "name": self.client.site.account_id })
                }
            };
        }
        let created = self
            .call(
                "POST",
                &format!("{}/issue", self.api()),
                Some(json!({ "fields": fields })),
            )
            .map_err(|e| jira_error(&e))?;
        let key = as_string(created.get("key"));
        let issue = IssueRef {
            key: &key,
            id: None,
        };
        let mut warnings = Vec::new();
        if let Some(sprint) = new.sprint_id
            && let Err(error) = self.move_to_sprint(board_id, issue, Some(sprint))
        {
            warnings.push(format!("Created in the backlog: {}", error.message));
        }
        let fresh = self.get_issue(board_id, issue)?.ok_or_else(|| {
            ProviderError::new(
                "jira_error",
                format!("{key} was created but cannot be read back"),
            )
        })?;
        if let Some(status) = new.status_id
            && fresh.status.id != status
        {
            if let Err(error) = self.set_status(board_id, issue, status) {
                warnings.push(format!(
                    "Created in {}: {}",
                    fresh.status.name, error.message
                ));
                return Ok((fresh, warnings));
            }
            let moved = self.get_issue(board_id, issue)?.unwrap_or(fresh);
            return Ok((moved, warnings));
        }
        Ok((fresh, warnings))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sprints_map_numeric_and_string_ids_and_lowercase_states() {
        let sprint = map_sprint(
            &json!({"id": 25, "name": "Sprint 25", "state": "ACTIVE", "startDate": "s"}),
        )
        .unwrap();
        assert_eq!(sprint.id, "25");
        assert_eq!(sprint.state, "active");
        assert_eq!(sprint.start.as_deref(), Some("s"));
        assert!(map_sprint(&Value::Null).is_none());
        assert!(map_sprint(&json!({"name": "no id"})).is_none());
    }

    #[test]
    fn boards_map_location_and_kind() {
        let board = JiraProvider::map_board(&json!({"id": 7, "name": "P", "type": "scrum",
            "location": {"projectKey": "APP", "projectName": "Platform"}}));
        assert_eq!(board.id, "7");
        assert_eq!(board.kind, "scrum");
        assert_eq!(board.project_key.as_deref(), Some("APP"));
    }

    fn board(id: &str, key: Option<&str>) -> ExtBoard {
        ExtBoard {
            id: id.into(),
            name: id.into(),
            kind: "kanban".into(),
            project_key: key.map(str::to_owned),
            project_name: None,
        }
    }

    #[test]
    fn sprint_boards_read_cloud_objects_and_server_strings_open_sprints_only() {
        let cloud = json!([
            {"id": 24, "state": "closed", "boardId": 7},
            {"id": 25, "state": "active", "boardId": 7},
            {"id": 40, "state": "future", "boardId": 12},
            {"id": 41, "state": "active", "boardId": 12},
            {"id": 42, "state": "active"}
        ]);
        assert_eq!(sprint_boards(Some(&cloud)), ["7", "12"]);
        let server = json!([
            "com.atlassian.greenhopper.service.sprint.Sprint@1a[id=24,rapidViewId=7,state=CLOSED,name=S24]",
            "com.atlassian.greenhopper.service.sprint.Sprint@1b[id=25,rapidViewId=9,state=ACTIVE,name=S25]",
            "com.atlassian.greenhopper.service.sprint.Sprint@1c[id=26,rapidViewId=<null>,state=FUTURE]"
        ]);
        assert_eq!(sprint_boards(Some(&server)), ["9"]);
        assert!(sprint_boards(None).is_empty());
        assert!(sprint_boards(Some(&Value::Null)).is_empty());
    }

    #[test]
    fn assigned_issues_split_into_each_boards_own_and_its_projects() {
        let reply = json!({"issues": [
            {"key": "FT-1", "fields": {"project": {"key": "FT"}, "cf": [{"state": "active", "boardId": 7}]}},
            {"key": "FT-2", "fields": {"project": {"key": "FT"}, "cf": [{"state": "active", "boardId": 7}]}},
            {"key": "FT-3", "fields": {"project": {"key": "FT"}, "cf": null}},
            {"key": "OPS-1", "fields": {"project": {"key": "OPS"}}},
            {"key": "X-1", "fields": {}}
        ]});
        let boards = [
            board("7", Some("FT")),
            board("8", Some("FT")),
            board("20", Some("OPS")),
            board("30", Some("ZZZ")),
            board("31", None),
        ];
        let counts = jira_assigned_by_board(&boards, &reply, Some("cf"));
        assert_eq!(counts.len(), 3);
        assert_eq!(
            counts["7"],
            AssignedOpen {
                on_board: 2,
                in_project: 3
            }
        );
        assert_eq!(
            counts["8"],
            AssignedOpen {
                on_board: 0,
                in_project: 3
            }
        );
        assert_eq!(
            counts["20"],
            AssignedOpen {
                on_board: 0,
                in_project: 1
            }
        );
        // Without a known Sprint field only the projects count.
        let projects_only = jira_assigned_by_board(&boards, &reply, None);
        assert_eq!(
            projects_only["7"],
            AssignedOpen {
                on_board: 0,
                in_project: 3
            }
        );
        assert!(jira_assigned_by_board(&boards, &json!({}), Some("cf")).is_empty());
    }

    #[test]
    fn a_sync_asks_for_the_imported_keys_in_batches_and_your_open_work_once() {
        assert!(sync_jqls(&[], false).is_empty());
        assert_eq!(sync_jqls(&[], true), [MINE_OPEN_JQL]);
        let keys = vec!["FT-1".to_string(), "FT-2".to_string()];
        assert_eq!(sync_jqls(&keys, false), [r#"key in ("FT-1","FT-2")"#]);
        assert_eq!(
            sync_jqls(&keys, true),
            [format!(r#"key in ("FT-1","FT-2") OR ({MINE_OPEN_JQL})"#)]
        );
        let many: Vec<String> = (0..250).map(|n| format!("FT-{n}")).collect();
        let queries = sync_jqls(&many, true);
        assert_eq!(queries.len(), 3);
        assert!(queries[0].ends_with(&format!("OR ({MINE_OPEN_JQL})")));
        assert!(!queries[1].contains("currentUser"));
        assert_eq!(queries[2].matches("\"FT-").count(), 50);
        // A key cannot break out of its quotes.
        assert_eq!(
            sync_jqls(&[r#"X-1") OR ("Y"#.to_string()], false),
            [r#"key in ("X-1) OR (Y")"#]
        );
    }

    #[test]
    fn jira_without_a_connection_says_where_to_connect() {
        let dir = tempfile::tempdir().unwrap();
        let jira = JiraState::new(dir.path());
        let error = JiraProvider::new(&jira, None).err().unwrap();
        assert_eq!(error.code, "jira_not_connected");
    }
}
