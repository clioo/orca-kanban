//! Linear as a Work board source (GraphQL, personal API key).
//!
//! A board is a team; its columns are the team's workflow states in
//! Linear's order (backlog, unstarted, started, completed, canceled); a
//! team with cycles enabled is a sprint board whose sprints are its cycles.
//! Issues are keyed by their identifier (`ENG-12`); a status push is an
//! `issueUpdate` of `stateId`, a sprint move one of `cycleId`.

use std::collections::HashMap;

use serde_json::{Value, json};

use super::provider::{
    AssignedOpen, ExtBoard, ExtColumn, ExtIssue, ExtSprint, ExtStatus, IssueRef, IssueScope,
    NewIssue, ProviderError, ProviderResult, WorkProvider,
};
use crate::jira::client::{HttpRequest, JiraRequestError, REQUEST_TIMEOUT, http_json};

pub(crate) const DEFAULT_API_URL: &str = "https://api.linear.app";

pub(crate) struct LinearProvider {
    token: String,
    api_url: String,
    /// The workspace's web URL (`https://linear.app/<urlKey>`).
    site_url: String,
}

const ISSUE_FIELDS: &str = "id identifier title description url priorityLabel updatedAt
  assignee { id name displayName }
  state { id name type }
  cycle { id number name startsAt endsAt completedAt isActive }
  labels { nodes { name } }
  project { name }
  team { id key name }";

fn request_error(error: JiraRequestError) -> ProviderError {
    let code = match error.status() {
        Some(401) | Some(403) => "linear_auth_required",
        _ => "linear_error",
    };
    ProviderError::new(code, crate::jira::client::failure_message(&error))
}

impl LinearProvider {
    pub(crate) fn new(token: String, api_url: Option<String>, site_url: Option<String>) -> Self {
        Self {
            token,
            api_url: api_url
                .filter(|u| !u.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_API_URL.to_string())
                .trim_end_matches('/')
                .to_string(),
            site_url: site_url.unwrap_or_else(|| "https://linear.app".into()),
        }
    }

    /// One GraphQL call. GraphQL errors come back as the provider's own
    /// message (`Entity not found: Issue`, `Authentication required…`).
    fn gql(&self, query: &str, variables: Value) -> ProviderResult<Value> {
        let body = json!({ "query": query, "variables": variables }).to_string();
        let request = HttpRequest {
            url: format!("{}/graphql", self.api_url),
            method: "POST",
            authorization: &self.token,
            body: Some(body),
            cancel: None,
            timeout: REQUEST_TIMEOUT,
        };
        let value = http_json(&request, "Linear").map_err(|e| {
            let mut mapped = request_error(e);
            if mapped.message.contains("Authentication") {
                mapped.code = "linear_auth_required".into();
            }
            mapped
        })?;
        if let Some(errors) = value.get("errors").and_then(Value::as_array)
            && !errors.is_empty()
        {
            let message = errors
                .iter()
                .filter_map(|e| e.get("message").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("; ");
            let code = if message.contains("not found") {
                "not_found"
            } else if message.contains("Authentication") {
                "linear_auth_required"
            } else {
                "linear_error"
            };
            return Err(ProviderError::new(code, message));
        }
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    }

    /// The account behind the key: `(viewer name, workspace name, url key)`.
    pub(crate) fn viewer(&self) -> ProviderResult<(String, String, String)> {
        let data = self.gql(
            "query DrogonLinearViewer { viewer { id name email } organization { name urlKey } }",
            json!({}),
        )?;
        Ok((
            text(&data["viewer"]["name"]),
            text(&data["organization"]["name"]),
            text(&data["organization"]["urlKey"]),
        ))
    }

    fn team(&self, id: &str) -> ProviderResult<Value> {
        let data = self.gql(
            "query DrogonLinearTeam($id: String!) { team(id: $id) {
               id key name cyclesEnabled
               states(first: 100) { nodes { id name type position } }
               cycles(first: 100) { nodes { id number name startsAt endsAt completedAt isActive } }
             } }",
            json!({ "id": id }),
        )?;
        match data.get("team") {
            Some(team) if !team.is_null() => Ok(team.clone()),
            _ => Err(ProviderError::new(
                "not_found",
                format!("Linear team {id} not found"),
            )),
        }
    }

    fn map_issue(&self, raw: &Value) -> ExtIssue {
        let state = &raw["state"];
        let priority = raw["priorityLabel"]
            .as_str()
            .filter(|p| !p.is_empty() && *p != "No priority")
            .map(str::to_owned);
        let labels: Vec<String> = raw["labels"]["nodes"]
            .as_array()
            .map(|l| {
                l.iter()
                    .filter_map(|x| x["name"].as_str())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        ExtIssue {
            id: text(&raw["id"]),
            key: text(&raw["identifier"]),
            url: text(&raw["url"]),
            title: text(&raw["title"]),
            description: text(&raw["description"]),
            // Linear has no issue types; the first label reads as one.
            issue_type: labels.first().cloned(),
            priority,
            assignee: raw["assignee"]["name"].as_str().map(str::to_owned),
            assignee_id: raw["assignee"]["id"].as_str().map(str::to_owned),
            status: map_state(state),
            sprint: raw.get("cycle").and_then(map_cycle),
            closed_sprints: Vec::new(),
            // A Linear project (a team's issues span several).
            project: raw["project"]["name"].as_str().map(str::to_owned),
            updated: text(&raw["updatedAt"]),
        }
    }
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

/// Linear's state types, in board order, and the category each reads as.
fn type_rank(kind: &str) -> (u8, &'static str) {
    match kind {
        "triage" => (0, "new"),
        "backlog" => (1, "new"),
        "unstarted" => (2, "new"),
        "started" => (3, "indeterminate"),
        "completed" => (4, "done"),
        "canceled" => (5, "done"),
        _ => (6, "undefined"),
    }
}

fn map_state(state: &Value) -> ExtStatus {
    ExtStatus {
        id: text(&state["id"]),
        name: state["name"].as_str().unwrap_or("Unknown").to_string(),
        category: type_rank(state["type"].as_str().unwrap_or_default())
            .1
            .to_string(),
    }
}

pub(crate) fn map_cycle(raw: &Value) -> Option<ExtSprint> {
    if raw.is_null() {
        return None;
    }
    let number = raw["number"].as_i64().unwrap_or_default();
    let state = if !raw["completedAt"].is_null() {
        "closed"
    } else if raw["isActive"] == true {
        "active"
    } else {
        "future"
    };
    Some(ExtSprint {
        id: raw["id"].as_str()?.to_string(),
        name: raw["name"]
            .as_str()
            .filter(|n| !n.is_empty())
            .map(|n| format!("Cycle {number} · {n}"))
            .unwrap_or_else(|| format!("Cycle {number}")),
        state: state.into(),
        start: raw["startsAt"].as_str().map(str::to_owned),
        end: raw["endsAt"].as_str().map(str::to_owned),
    })
}

fn sorted_states(team: &Value) -> Vec<Value> {
    let mut states = team["states"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    states.sort_by(|a, b| {
        let ra = type_rank(a["type"].as_str().unwrap_or_default()).0;
        let rb = type_rank(b["type"].as_str().unwrap_or_default()).0;
        ra.cmp(&rb).then(
            a["position"]
                .as_f64()
                .unwrap_or(0.0)
                .total_cmp(&b["position"].as_f64().unwrap_or(0.0)),
        )
    });
    states
}

/// Open assigned issues per team id in a `DrogonLinearAssigned` reply.
fn team_counts(data: &Value) -> HashMap<String, u32> {
    let mut counts = HashMap::new();
    for issue in data["viewer"]["assignedIssues"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
    {
        if let Some(team) = issue["team"]["id"].as_str().filter(|t| !t.is_empty()) {
            *counts.entry(team.to_string()).or_insert(0) += 1;
        }
    }
    counts
}

impl WorkProvider for LinearProvider {
    fn kind(&self) -> &'static str {
        "linear"
    }

    fn site(&self) -> (String, String) {
        ("default".into(), self.site_url.clone())
    }

    fn list_boards(&self) -> ProviderResult<Vec<ExtBoard>> {
        let data = self.gql(
            "query DrogonLinearTeams { teams(first: 100) { nodes { id key name cyclesEnabled } } }",
            json!({}),
        )?;
        Ok(data["teams"]["nodes"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|team| ExtBoard {
                id: text(&team["id"]),
                name: text(&team["name"]),
                kind: if team["cyclesEnabled"] == true {
                    "scrum"
                } else {
                    "kanban"
                }
                .into(),
                project_key: team["key"].as_str().map(str::to_owned),
                project_name: team["name"].as_str().map(str::to_owned),
            })
            .collect())
    }

    fn assigned_open_counts(
        &self,
        boards: &[ExtBoard],
    ) -> ProviderResult<HashMap<String, AssignedOpen>> {
        let data = self.gql(
            "query DrogonLinearAssigned { viewer { assignedIssues(first: 100, filter: { state: { type: { nin: [\"completed\", \"canceled\"] } } }) { nodes { team { id } } } } }",
            json!({}),
        )?;
        // A Linear board is its team: every open issue there is on it.
        let teams = team_counts(&data);
        Ok(boards
            .iter()
            .filter_map(|b| {
                let on_board = *teams.get(&b.id)?;
                Some((
                    b.id.clone(),
                    AssignedOpen {
                        on_board,
                        in_project: 0,
                    },
                ))
            })
            .collect())
    }

    fn board(&self, board_id: &str) -> ProviderResult<ExtBoard> {
        let team = self.team(board_id)?;
        Ok(ExtBoard {
            id: text(&team["id"]),
            name: text(&team["name"]),
            kind: if team["cyclesEnabled"] == true {
                "scrum"
            } else {
                "kanban"
            }
            .into(),
            project_key: team["key"].as_str().map(str::to_owned),
            project_name: team["name"].as_str().map(str::to_owned),
        })
    }

    fn board_columns(&self, board_id: &str) -> ProviderResult<Vec<ExtColumn>> {
        Ok(sorted_states(&self.team(board_id)?)
            .iter()
            .map(|state| ExtColumn {
                name: text(&state["name"]),
                statuses: vec![map_state(state)],
            })
            .collect())
    }

    fn me(&self) -> ProviderResult<Option<String>> {
        let data = self.gql("query DrogonLinearMe { viewer { id } }", json!({}))?;
        Ok(data["viewer"]["id"].as_str().map(str::to_owned))
    }

    fn list_statuses(&self, board_id: &str) -> ProviderResult<Vec<ExtStatus>> {
        Ok(sorted_states(&self.team(board_id)?)
            .iter()
            .map(map_state)
            .collect())
    }

    fn list_sprints(&self, board_id: &str) -> ProviderResult<Vec<ExtSprint>> {
        let team = self.team(board_id)?;
        if team["cyclesEnabled"] != true {
            return Ok(Vec::new());
        }
        let mut cycles: Vec<Value> = team["cycles"]["nodes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        cycles.sort_by_key(|c| c["number"].as_i64().unwrap_or_default());
        Ok(cycles.iter().filter_map(map_cycle).collect())
    }

    fn list_issues(&self, board_id: &str, scope: &IssueScope) -> ProviderResult<Vec<ExtIssue>> {
        let query = format!(
            "query DrogonLinearIssues($id: String!, $after: String) {{ team(id: $id) {{
               issues(first: 100, after: $after) {{ nodes {{ {ISSUE_FIELDS} }} pageInfo {{ hasNextPage endCursor }} }}
             }} }}"
        );
        let mut out = Vec::new();
        let mut after: Option<String> = None;
        for _ in 0..100 {
            let data = self.gql(&query, json!({ "id": board_id, "after": after }))?;
            let page = &data["team"]["issues"];
            if data["team"].is_null() {
                return Err(ProviderError::new(
                    "not_found",
                    format!("Linear team {board_id} not found"),
                ));
            }
            for raw in page["nodes"].as_array().cloned().unwrap_or_default() {
                out.push(self.map_issue(&raw));
            }
            if page["pageInfo"]["hasNextPage"] != true {
                break;
            }
            after = page["pageInfo"]["endCursor"].as_str().map(str::to_owned);
        }
        Ok(match scope {
            // Its listing cannot be narrowed: a sync reads the whole board.
            IssueScope::Board | IssueScope::Sync { .. } => out,
            IssueScope::Backlog => out
                .into_iter()
                .filter(|i| i.sprint.is_none() && i.status.category != "done")
                .collect(),
            IssueScope::Sprint(id) => out
                .into_iter()
                .filter(|i| i.sprint.as_ref().is_some_and(|s| s.id == *id))
                .collect(),
        })
    }

    fn get_issue(&self, _board_id: &str, issue: IssueRef) -> ProviderResult<Option<ExtIssue>> {
        let query = format!(
            "query DrogonLinearIssue($id: String!) {{ issue(id: $id) {{ {ISSUE_FIELDS} }} }}"
        );
        match self.gql(&query, json!({ "id": issue.id.unwrap_or(issue.key) })) {
            Ok(data) if data["issue"].is_null() => Ok(None),
            Ok(data) => Ok(Some(self.map_issue(&data["issue"]))),
            Err(error) if error.code == "not_found" => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn set_status(&self, _board_id: &str, issue: IssueRef, status_id: &str) -> ProviderResult<()> {
        self.update(issue, json!({ "stateId": status_id }))
    }

    fn move_to_sprint(
        &self,
        _board_id: &str,
        issue: IssueRef,
        sprint_id: Option<&str>,
    ) -> ProviderResult<()> {
        self.update(issue, json!({ "cycleId": sprint_id }))
    }

    fn create_issue(
        &self,
        board_id: &str,
        new: &NewIssue,
    ) -> ProviderResult<(ExtIssue, Vec<String>)> {
        Ok((self.create(board_id, new)?, Vec::new()))
    }
}

impl LinearProvider {
    /// `issueCreate` on the team: its state, cycle and assignee in one call.
    fn create(&self, team: &str, new: &NewIssue) -> ProviderResult<ExtIssue> {
        let mut input = json!({ "teamId": team, "title": new.title });
        if !new.description.trim().is_empty() {
            input["description"] = json!(new.description.trim());
        }
        if let Some(state) = new.status_id {
            input["stateId"] = json!(state);
        }
        if let Some(cycle) = new.sprint_id {
            input["cycleId"] = json!(cycle);
        }
        if new.assign_to_me
            && let Some(me) = self.me()?
        {
            input["assigneeId"] = json!(me);
        }
        let query = format!(
            "mutation DrogonLinearCreate($input: IssueCreateInput!) {{
               issueCreate(input: $input) {{ success issue {{ {ISSUE_FIELDS} }} }} }}"
        );
        let data = self.gql(&query, json!({ "input": input }))?;
        let created = &data["issueCreate"];
        if created["success"] != true || created["issue"].is_null() {
            return Err(ProviderError::new(
                "linear_error",
                "Linear did not create the issue",
            ));
        }
        Ok(self.map_issue(&created["issue"]))
    }
}

impl LinearProvider {
    fn update(&self, issue: IssueRef, input: Value) -> ProviderResult<()> {
        let data = self.gql(
            "mutation DrogonLinearUpdate($id: String!, $input: IssueUpdateInput!) {
               issueUpdate(id: $id, input: $input) { success } }",
            json!({ "id": issue.id.unwrap_or(issue.key), "input": input }),
        )?;
        if data["issueUpdate"]["success"] == true {
            Ok(())
        } else {
            Err(ProviderError::new(
                "linear_error",
                "Linear did not apply the update",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assigned_issues_count_per_team() {
        let data = json!({"viewer": {"assignedIssues": {"nodes": [
            {"team": {"id": "team-eng"}},
            {"team": {"id": "team-eng"}},
            {"team": {"id": "team-ops"}},
            {"team": null},
            {"team": {"id": ""}}
        ]}}});
        let counts = team_counts(&data);
        assert_eq!(counts.len(), 2);
        assert_eq!(counts["team-eng"], 2);
        assert_eq!(counts["team-ops"], 1);
        assert!(team_counts(&json!({})).is_empty());
    }

    #[test]
    fn cycles_read_as_sprints_with_their_state() {
        let closed = map_cycle(
            &json!({"id": "c", "number": 11, "name": null, "completedAt": "x", "isActive": false}),
        )
        .unwrap();
        assert_eq!(
            (closed.name.as_str(), closed.state.as_str()),
            ("Cycle 11", "closed")
        );
        let active = map_cycle(&json!({"id": "c", "number": 12, "name": "Polish", "completedAt": null, "isActive": true})).unwrap();
        assert_eq!(
            (active.name.as_str(), active.state.as_str()),
            ("Cycle 12 · Polish", "active")
        );
        let future =
            map_cycle(&json!({"id": "c", "number": 13, "completedAt": null, "isActive": false}))
                .unwrap();
        assert_eq!(future.state, "future");
        assert!(map_cycle(&Value::Null).is_none());
    }

    #[test]
    fn states_order_by_type_then_position_and_map_categories() {
        let team = json!({"states": {"nodes": [
            {"id": "d", "name": "Done", "type": "completed", "position": 0},
            {"id": "p", "name": "In Progress", "type": "started", "position": 1},
            {"id": "b", "name": "Backlog", "type": "backlog", "position": 5},
            {"id": "r", "name": "In Review", "type": "started", "position": 2},
        ]}});
        let names: Vec<String> = sorted_states(&team)
            .iter()
            .map(|s| text(&s["name"]))
            .collect();
        assert_eq!(names, ["Backlog", "In Progress", "In Review", "Done"]);
        assert_eq!(
            map_state(&json!({"id": "x", "name": "Canceled", "type": "canceled"})).category,
            "done"
        );
    }

    #[test]
    fn the_api_url_defaults_and_loses_a_trailing_slash() {
        assert_eq!(
            LinearProvider::new("k".into(), None, None).api_url,
            DEFAULT_API_URL
        );
        assert_eq!(
            LinearProvider::new("k".into(), Some("http://127.0.0.1:9/linear/".into()), None)
                .api_url,
            "http://127.0.0.1:9/linear"
        );
    }
}
