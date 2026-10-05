//! Jira operations (R17-A): connect/disconnect/status, issue search with
//! the fork's filter JQL, paged project picker queries and issue-create
//! metadata. Ported from the fork's `src/main/jira/client.ts`,
//! `jira-issue-search.ts`, `jira-project-queries.ts`,
//! `jira-issue-create-metadata.ts` and `jira-read-failure.ts`.
//! MIT Copyright (c) 2026 Lovecast Inc.

use crate::protocol::RpcError;
use crate::protocol::jira::*;

use super::JiraState;
use super::client::{
    CancelFlag, HttpRequest, JiraRequestError, auth_header, jira_request, to_rpc_error,
};
use super::identity::{get_site_id, normalize_jira_site_url, to_viewer};
use super::mapping::{
    ISSUE_LIST_FIELDS, get_create_field_records, map_create_field, map_issue_type, map_jira_issue,
    map_priority, map_project, map_user,
};
use super::sites::{JiraSiteFile, JiraSiteRecord, SiteSelection, SiteStore};

/// One resolved site plus its Authorization header — the fork's
/// `JiraClientForSite`.
pub struct ClientForSite {
    pub site: JiraSiteRecord,
    pub authorization: String,
}

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new("invalid_argument", message)
}

// --- client resolution ------------------------------------------------------

/// The fork's `getClients`: resolve the persisted selection (explicit
/// `all`, the file's selectedSiteId, or the active site), skip sites with
/// no usable token, and downgrade per-site decrypt failures to a skip when
/// the selection fans out — one bad site must not collapse reads for the
/// healthy ones.
pub fn get_clients(
    store: &SiteStore,
    selection: Option<SiteSelection>,
) -> Result<Vec<ClientForSite>, RpcError> {
    let file = store.read_site_file();
    let selected: Option<String> = match selection {
        Some(SiteSelection::All) => Some("all".to_string()),
        Some(SiteSelection::Site(id)) => Some(id),
        None => file
            .selected_site_id
            .clone()
            .or_else(|| file.active_site_id.clone()),
    };
    let is_all = selected.as_deref() == Some("all");
    let sites: Vec<JiraSiteRecord> = if is_all {
        file.sites.clone()
    } else {
        let wanted = selected.as_deref().or(file.active_site_id.as_deref());
        file.sites
            .iter()
            .filter(|site| Some(site.id.as_str()) == wanted)
            .cloned()
            .collect()
    };
    let mut clients = Vec::new();
    for site in sites {
        match store.read_token(&site.id) {
            Ok(Some(token)) => clients.push(ClientForSite {
                authorization: auth_header(&site.email, &token, site.auth_type),
                site,
            }),
            Ok(None) => {}
            Err(error) => {
                if is_all {
                    // Already recorded in credential_errors for status.
                    continue;
                }
                return Err(RpcError::new("jira_credential_error", error.0));
            }
        }
    }
    Ok(clients)
}

/// The fork's `clearToken`: an auth failure removes the site entirely.
fn clear_token(state: &JiraState, site_id: &str) {
    state.sites.delete_token(site_id);
    let file = state.sites.read_site_file();
    let sites: Vec<JiraSiteRecord> = file
        .sites
        .iter()
        .filter(|site| site.id != site_id)
        .cloned()
        .collect();
    let _ = state.sites.write_site_file(&JiraSiteFile {
        version: 1,
        active_site_id: file.active_site_id,
        selected_site_id: file.selected_site_id,
        sites,
    });
}

// --- connect / disconnect / status ------------------------------------------

pub fn connect(state: &JiraState, params: &JiraConnectParams) -> Result<JiraViewer, RpcError> {
    let site_url = normalize_jira_site_url(&params.site_url).map_err(invalid)?;
    let auth_type = params.auth_type.unwrap_or(JiraAuthType::Cloud);
    let email = params.email.trim().to_string();
    let api_token = params.api_token.trim().to_string();
    if auth_type == JiraAuthType::Server {
        if api_token.is_empty() {
            return Err(invalid(if email.is_empty() {
                "Personal access token is required."
            } else {
                "Password is required."
            }));
        }
    } else if email.is_empty() || api_token.is_empty() {
        return Err(invalid("Email and API token are required."));
    }

    // The fork serializes connect through the shared request queue; Drogon
    // serializes it through its own lock (no site exists to key on yet).
    let _permit = state.connect_lock().lock().unwrap();
    let myself_path = format!("{}/myself", super::client::api_base_path(auth_type));
    let request = HttpRequest {
        url: format!("{site_url}{myself_path}"),
        method: "GET",
        authorization: &auth_header(&email, &api_token, auth_type),
        body: None,
        cancel: None,
        timeout: super::client::REQUEST_TIMEOUT,
    };
    let response = jira_request(&request).map_err(|error| to_rpc_error(&error))?;
    let viewer = to_viewer(&response, if email.is_empty() { &site_url } else { &email });
    // PAT sites have no email, so keying on it alone would collide every PAT
    // connection to the same host into one id; fall back to the verified
    // viewer identity (the fork's connect comment).
    let id = get_site_id(
        &site_url,
        if email.is_empty() {
            &viewer.account_id
        } else {
            &email
        },
    );
    let site = JiraSiteRecord {
        id: id.clone(),
        site_url: site_url.clone(),
        email,
        display_name: viewer.display_name.clone(),
        account_id: viewer.account_id.clone(),
        auth_type,
    };
    state
        .sites
        .save_token(&id, &api_token)
        .map_err(|e| RpcError::new("io_error", e))?;
    let file = state.sites.read_site_file();
    let mut sites = vec![site];
    sites.extend(file.sites.into_iter().filter(|entry| entry.id != id));
    state
        .sites
        .write_site_file(&JiraSiteFile {
            version: 1,
            active_site_id: Some(id.clone()),
            selected_site_id: Some(id),
            sites,
        })
        .map_err(|e| RpcError::new("io_error", e))?;
    Ok(viewer)
}

pub fn disconnect(state: &JiraState, site_id: Option<&str>) {
    let file = state.sites.read_site_file();
    let ids: Vec<String> = match site_id {
        Some(id) => vec![id.to_string()],
        None => file.sites.iter().map(|site| site.id.clone()).collect(),
    };
    for id in &ids {
        state.sites.delete_token(id);
    }
    let sites: Vec<JiraSiteRecord> = file
        .sites
        .iter()
        .filter(|site| !ids.contains(&site.id))
        .cloned()
        .collect();
    let _ = state.sites.write_site_file(&JiraSiteFile {
        version: 1,
        active_site_id: file.active_site_id,
        selected_site_id: file.selected_site_id,
        sites,
    });
}

pub fn select_site(state: &JiraState, site_id: &str) -> JiraConnectionStatus {
    let file = state.sites.read_site_file();
    if site_id != "all" && !file.sites.iter().any(|site| site.id == site_id) {
        return status(state);
    }
    let _ = state.sites.write_site_file(&JiraSiteFile {
        version: 1,
        active_site_id: if site_id == "all" {
            file.active_site_id.clone()
        } else {
            Some(site_id.to_string())
        },
        selected_site_id: Some(site_id.to_string()),
        sites: file.sites,
    });
    status(state)
}

/// The fork's `getStatus`: sites with stored tokens, the active site as
/// activeSiteId match-or-first, and the first recorded credential error.
pub fn status(state: &JiraState) -> JiraConnectionStatus {
    let file = state.sites.read_site_file();
    let sites: Vec<JiraSiteRecord> = file
        .sites
        .iter()
        .filter(|site| state.sites.has_stored_token(&site.id))
        .cloned()
        .collect();
    let active = sites
        .iter()
        .find(|site| Some(site.id.as_str()) == file.active_site_id.as_deref())
        .or(sites.first());
    let credential_error = sites
        .iter()
        .find_map(|site| state.sites.credential_error(&site.id));
    JiraConnectionStatus {
        connected: !sites.is_empty(),
        viewer: active.map(|site| JiraViewer {
            account_id: site.account_id.clone(),
            display_name: site.display_name.clone(),
            email: if site.email.is_empty() {
                None
            } else {
                Some(site.email.clone())
            },
            avatar_url: None,
        }),
        sites: sites.iter().map(Into::into).collect(),
        active_site_id: active.map(|site| site.id.clone()),
        selected_site_id: file
            .selected_site_id
            .clone()
            .or_else(|| active.map(|site| site.id.clone())),
        credential_error,
    }
}

/// The fork's `testConnection`: re-validate the saved credential against
/// `/myself` (`jira.myself`).
pub fn test_connection(state: &JiraState, site_id: Option<&str>) -> Result<JiraViewer, RpcError> {
    let clients = get_clients(
        &state.sites,
        site_id.map(|id| {
            if id == "all" {
                SiteSelection::All
            } else {
                SiteSelection::Site(id.to_string())
            }
        }),
    )?;
    let Some(client) = clients.first() else {
        return Err(RpcError::new(
            "jira_not_connected",
            "Not connected to Jira.",
        ));
    };
    let myself_path = format!(
        "{}/myself",
        super::client::api_base_path(client.site.auth_type)
    );
    let request = HttpRequest {
        url: format!("{}{myself_path}", client.site.site_url),
        method: "GET",
        authorization: &client.authorization,
        body: None,
        cancel: None,
        timeout: super::client::REQUEST_TIMEOUT,
    };
    let response = jira_request(&request).map_err(|error| to_rpc_error(&error))?;
    Ok(to_viewer(&response, &client.site.email))
}

// --- issue search -----------------------------------------------------------

/// The fork's `filterToJql` (jira-issue-search.ts): the four Tasks-page
/// tabs. `all` is the "All Open" tab — resolution-based, exactly as the
/// fork builds it (the `statusCategory != Done` form is only the JQL
/// input's placeholder copy).
pub fn filter_to_jql(filter: JiraIssueFilter) -> &'static str {
    match filter {
        JiraIssueFilter::Assigned => {
            "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC"
        }
        JiraIssueFilter::Reported => {
            "reporter = currentUser() AND resolution = Unresolved ORDER BY updated DESC"
        }
        JiraIssueFilter::Done => {
            "assignee = currentUser() AND resolution IS NOT EMPTY ORDER BY updated DESC"
        }
        JiraIssueFilter::All => "resolution = Unresolved ORDER BY updated DESC",
    }
}

fn clamp_limit(limit: Option<u32>) -> u32 {
    let limit = limit.unwrap_or(30);
    limit.clamp(1, 100)
}

/// Same-site visibility for the R17-C read/mutation module.
pub(crate) fn clear_token_for(state: &JiraState, site_id: &str) {
    clear_token(state, site_id);
}

/// The fork's `shouldFetchNextPage` for `isLast`-style paged responses.
pub(crate) fn should_fetch_next_page(
    response: &serde_json::Value,
    start_at: u64,
    items: usize,
    requested_max: u64,
) -> bool {
    if response.get("isLast").and_then(serde_json::Value::as_bool) == Some(true) || items == 0 {
        return false;
    }
    let total = response.get("total").and_then(serde_json::Value::as_u64);
    let page_size = response
        .get("maxResults")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(requested_max);
    if let Some(total) = total {
        return start_at + (items as u64) < total && page_size > 0;
    }
    if response.get("isLast").and_then(serde_json::Value::as_bool) == Some(false) {
        return page_size > 0;
    }
    page_size != 0 && items as u64 >= page_size
}

/// One search call against one site. Server/DC only has the classic
/// `/search` resource; `/search/jql` is Cloud-only — the fork's only
/// v2 fallback, keyed on the site's auth type.
fn search_issues_for_client(
    client: &ClientForSite,
    jql: &str,
    limit: u32,
    start_at: Option<u32>,
    cancel: Option<&CancelFlag>,
) -> Result<serde_json::Value, JiraRequestError> {
    let search_path = match client.site.auth_type {
        JiraAuthType::Server => format!(
            "{}/search",
            super::client::api_base_path(client.site.auth_type)
        ),
        JiraAuthType::Cloud => "/rest/api/3/search/jql".to_string(),
    };
    let mut body = serde_json::json!({
        "jql": jql,
        "maxResults": limit,
        "fields": ISSUE_LIST_FIELDS,
    });
    if let Some(start_at) = start_at {
        body["startAt"] = serde_json::json!(start_at);
    }
    let request = HttpRequest {
        url: format!("{}{search_path}", client.site.site_url),
        method: "POST",
        authorization: &client.authorization,
        body: Some(body.to_string()),
        cancel,
        timeout: super::client::ISSUE_SEARCH_TIMEOUT_MS,
    };
    jira_request(&request)
}

fn map_search_response(client: &ClientForSite, response: &serde_json::Value) -> JiraSearchResult {
    let site: JiraSite = (&client.site).into();
    let issues: Vec<JiraIssue> = response
        .get("issues")
        .and_then(serde_json::Value::as_array)
        .map(|records| {
            records
                .iter()
                .map(|record| map_jira_issue(&site, record))
                .collect()
        })
        .unwrap_or_default();
    let total = response.get("total").and_then(serde_json::Value::as_u64);
    let start_at = response
        .get("startAt")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let is_last = response
        .get("isLast")
        .and_then(serde_json::Value::as_bool)
        .or_else(|| total.map(|total| start_at + issues.len() as u64 >= total))
        .unwrap_or(true);
    JiraSearchResult {
        issues,
        total,
        is_last: Some(is_last),
    }
}

/// Parse a Jira timestamp ("2026-01-02T03:04:05.000+0000" or trailing Z)
/// into epoch seconds for the multi-site sort. Returns `None` for
/// unparseable values; the sort then treats them as oldest.
fn parse_jira_timestamp(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        value.get(range).and_then(|part| part.parse::<i64>().ok())
    };
    let year = number(0..4)?;
    let month = number(5..7)?;
    let day = number(8..10)?;
    let hour = number(11..13)?;
    let minute = number(14..16)?;
    let second = number(17..19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    // civil-from-days inverse (Howard Hinnant, public domain).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let mut epoch = days * 86_400 + hour * 3600 + minute * 60 + second;
    // Optional numeric zone offset (+HHMM / -HHMM / Z), looked up after the
    // seconds/fraction ("...T03:04:05.000+0100").
    let tail = &value[19..];
    let sign_index = tail.find(['+', '-']);
    if let Some(index) = sign_index {
        let zone = &tail[index + 1..];
        if zone.len() >= 4 {
            let sign = if tail.as_bytes()[index] == b'-' {
                -1
            } else {
                1
            };
            let zh = zone[0..2].parse::<i64>().ok()?;
            let zm = zone[2..4].parse::<i64>().ok()?;
            epoch -= sign * (zh * 3600 + zm * 60);
        }
    }
    Some(epoch)
}

struct SiteSearchOutcome {
    result: Option<JiraSearchResult>,
    failure: Option<JiraRequestError>,
}

/// The fork's `searchIssues`: fan out per site, surface single-site
/// failures, downgrade per-site failures under an `all` fan-out (only an
/// all-sites failure is an error), merge multi-site results by updated
/// DESC, and never fabricate an empty list on error.
pub fn search_issues(
    state: &JiraState,
    jql: &str,
    limit: Option<u32>,
    start_at: Option<u32>,
    selection: Option<SiteSelection>,
    cancel: Option<&CancelFlag>,
) -> Result<JiraSearchResult, RpcError> {
    let surface_site_failure = selection != Some(SiteSelection::All);
    let entries = get_clients(&state.sites, selection)?;
    let jql = jql.trim();
    if entries.is_empty() || jql.is_empty() {
        return Ok(JiraSearchResult {
            issues: Vec::new(),
            total: None,
            is_last: None,
        });
    }
    let safe_limit = clamp_limit(limit);
    // The fork's `shouldSurfaceSiteFailure`: surface when the caller did
    // NOT select 'all' and at most one site is in play; multi-site reads
    // downgrade per-site failures so one bad site cannot mask the rest.
    let surface_site_failure = surface_site_failure && entries.len() <= 1;

    let outcomes: Vec<SiteSearchOutcome> = entries
        .iter()
        .map(|entry| {
            let entry = ClientForSite {
                site: entry.site.clone(),
                authorization: entry.authorization.clone(),
            };
            let site_id = entry.site.id.clone();
            let queue = state.site_queue(&site_id);
            let _permit = queue.lock().unwrap();
            let result = search_issues_for_client(&entry, jql, safe_limit, start_at, cancel);
            match result {
                Ok(response) => SiteSearchOutcome {
                    result: Some(map_search_response(&entry, &response)),
                    failure: None,
                },
                Err(error) => {
                    if error.status() == Some(401) {
                        clear_token(state, &site_id);
                    }
                    SiteSearchOutcome {
                        result: None,
                        failure: Some(error),
                    }
                }
            }
        })
        .collect();

    let failures: Vec<&JiraRequestError> = outcomes
        .iter()
        .filter_map(|outcome| outcome.failure.as_ref())
        .collect();
    if !failures.is_empty() && (surface_site_failure || failures.len() == outcomes.len()) {
        // Single-site selection (or every site failed under a fan-out):
        // the error IS the answer. An abandoned search (cancel) reports as
        // cancelled, never as a site failure.
        let error = failures
            .iter()
            .find(|error| error.status() != Some(401))
            .or(failures.first())
            .copied()
            .expect("non-empty failures");
        if matches!(error, JiraRequestError::Cancelled) {
            return Err(to_rpc_error(error));
        }
        let mut mapped = to_rpc_error(error);
        // The fork's toIssueSearchFailureError prefixes "Error {status}: ";
        // the retry-after hint (when present) stays in the message.
        if let Some(status) = error.status() {
            mapped.message = format!("Error {status}: {}", mapped.message);
        }
        return Err(mapped);
    }

    let mut issues: Vec<JiraIssue> = outcomes
        .iter()
        .filter_map(|outcome| outcome.result.clone())
        .flat_map(|result| result.issues)
        .collect();
    let total: Option<u64> = outcomes
        .iter()
        .filter_map(|outcome| outcome.result.as_ref())
        .filter_map(|result| result.total)
        .reduce(|a, b| a.max(b));
    let is_last = outcomes
        .iter()
        .filter_map(|outcome| outcome.result.as_ref())
        .filter_map(|result| result.is_last)
        .reduce(|a, b| a && b)
        .or(if start_at.is_some() { None } else { Some(true) });

    if entries.len() == 1 {
        issues.truncate(safe_limit as usize);
    } else {
        issues.sort_by(|a, b| {
            let left = parse_jira_timestamp(&a.updated_at).unwrap_or(i64::MIN);
            let right = parse_jira_timestamp(&b.updated_at).unwrap_or(i64::MIN);
            right.cmp(&left)
        });
        issues.truncate(safe_limit as usize);
    }
    Ok(JiraSearchResult {
        issues,
        total,
        is_last,
    })
}

/// The fork's `listIssues`: a filter tab is just its JQL.
pub fn list_issues(
    state: &JiraState,
    filter: Option<JiraIssueFilter>,
    limit: Option<u32>,
    start_at: Option<u32>,
    selection: Option<SiteSelection>,
    cancel: Option<&CancelFlag>,
) -> Result<JiraSearchResult, RpcError> {
    search_issues(
        state,
        filter_to_jql(filter.unwrap_or(JiraIssueFilter::Assigned)),
        limit,
        start_at,
        selection,
        cancel,
    )
}

// --- projects / create metadata ---------------------------------------------

fn fetch_paged_records(
    client: &ClientForSite,
    path_for_page: impl Fn(u64, u64) -> String,
) -> Result<Vec<serde_json::Value>, JiraRequestError> {
    let mut records = Vec::new();
    let mut start_at: u64 = 0;
    let max_results: u64 = 100;
    for _ in 0..100 {
        let path = path_for_page(start_at, max_results);
        let request = HttpRequest {
            url: format!("{}{path}", client.site.site_url),
            method: "GET",
            authorization: &client.authorization,
            body: None,
            cancel: None,
            timeout: super::client::REQUEST_TIMEOUT,
        };
        let response = jira_request(&request)?;
        let items: Vec<serde_json::Value> = response
            .get("values")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        let count = items.len();
        records.extend(items);
        if !should_fetch_next_page(&response, start_at, count, max_results) {
            break;
        }
        start_at += response
            .get("maxResults")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(max_results);
    }
    Ok(records)
}

/// The fork's `listProjects`: Server/DC has no `/project/search` resource
/// (`/project` returns the full list as a plain array); Cloud pages.
pub fn list_projects(
    state: &JiraState,
    selection: Option<SiteSelection>,
) -> Result<Vec<JiraProject>, RpcError> {
    let surface_site_failure = selection != Some(SiteSelection::All);
    let entries = get_clients(&state.sites, selection)?;
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let surface_site_failure = surface_site_failure && entries.len() <= 1;
    let mut projects = Vec::new();
    for entry in &entries {
        let queue = state.site_queue(&entry.site.id);
        let _permit = queue.lock().unwrap();
        let outcome = (|| {
            if entry.site.auth_type == JiraAuthType::Server {
                let path = format!(
                    "{}/project",
                    super::client::api_base_path(entry.site.auth_type)
                );
                let request = HttpRequest {
                    url: format!("{}{path}", entry.site.site_url),
                    method: "GET",
                    authorization: &entry.authorization,
                    body: None,
                    cancel: None,
                    timeout: super::client::REQUEST_TIMEOUT,
                };
                let response = jira_request(&request)?;
                Ok(response.as_array().cloned().unwrap_or_default())
            } else {
                fetch_paged_records(entry, |start_at, max_results| {
                    format!(
                        "/rest/api/3/project/search?maxResults={max_results}&startAt={start_at}"
                    )
                })
            }
        })();
        match outcome {
            Ok(records) => {
                let site: JiraSite = (&entry.site).into();
                projects.extend(
                    records
                        .iter()
                        .map(|record| map_project(Some(record), Some(&site))),
                );
            }
            Err(error) => {
                if error.status() == Some(401) {
                    clear_token(state, &entry.site.id);
                    if !surface_site_failure {
                        return Err(to_rpc_error(&error));
                    }
                }
                // Non-auth project failures degrade to [] per the fork; the
                // picker's empty state explains itself.
            }
        }
    }
    // Case-insensitive by display name, ties by the exact name.
    projects.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(projects)
}

/// `/issue/createmeta/<project>/issuetypes` (paged `issueTypes`).
pub fn list_issue_types(
    state: &JiraState,
    project_id_or_key: &str,
    site_id: Option<&str>,
) -> Result<Vec<JiraIssueType>, RpcError> {
    let entry = first_client(state, site_id)?;
    let Some(entry) = entry else {
        return Ok(Vec::new());
    };
    let queue = state.site_queue(&entry.site.id);
    let _permit = queue.lock().unwrap();
    let outcome = fetch_paged_records(&entry, |start_at, max_results| {
        format!(
            "{}/issue/createmeta/{}/issuetypes?maxResults={max_results}&startAt={start_at}",
            super::client::api_base_path(entry.site.auth_type),
            encode_path_segment(project_id_or_key)
        )
    });
    match outcome {
        Ok(records) => Ok(records
            .iter()
            .map(|record| map_issue_type(Some(record)))
            .collect()),
        Err(error) => {
            if error.status() == Some(401) {
                clear_token(state, &entry.site.id);
            }
            Err(to_rpc_error(&error))
        }
    }
}

/// `/issue/createmeta/<project>/issuetypes/<type>` (paged fields in their
/// three possible envelopes).
pub fn list_create_fields(
    state: &JiraState,
    project_id_or_key: &str,
    issue_type_id: &str,
    site_id: Option<&str>,
) -> Result<Vec<JiraCreateField>, RpcError> {
    let entry = first_client(state, site_id)?;
    let Some(entry) = entry else {
        return Ok(Vec::new());
    };
    let queue = state.site_queue(&entry.site.id);
    let _permit = queue.lock().unwrap();
    let mut fields = Vec::new();
    let mut start_at: u64 = 0;
    let max_results: u64 = 100;
    let outcome = (|| -> Result<(), JiraRequestError> {
        for _ in 0..100 {
            let path = format!(
                "{}/issue/createmeta/{}/issuetypes/{}?maxResults={max_results}&startAt={start_at}",
                super::client::api_base_path(entry.site.auth_type),
                encode_path_segment(project_id_or_key),
                encode_path_segment(issue_type_id)
            );
            let request = HttpRequest {
                url: format!("{}{path}", entry.site.site_url),
                method: "GET",
                authorization: &entry.authorization,
                body: None,
                cancel: None,
                timeout: super::client::REQUEST_TIMEOUT,
            };
            let response = jira_request(&request)?;
            let records = get_create_field_records(&response);
            let count = records.len();
            fields.extend(
                records
                    .iter()
                    .filter_map(|record| map_create_field(record, "")),
            );
            if !should_fetch_next_page(&response, start_at, count, max_results) {
                break;
            }
            start_at += response
                .get("maxResults")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(max_results);
        }
        Ok(())
    })();
    match outcome {
        Ok(()) => Ok(fields),
        Err(error) => {
            if error.status() == Some(401) {
                clear_token(state, &entry.site.id);
            }
            Err(to_rpc_error(&error))
        }
    }
}

/// The fork's `listPriorities`.
pub fn list_priorities(
    state: &JiraState,
    site_id: Option<&str>,
) -> Result<Vec<JiraPriority>, RpcError> {
    let entry = first_client(state, site_id)?;
    let Some(entry) = entry else {
        return Ok(Vec::new());
    };
    let queue = state.site_queue(&entry.site.id);
    let _permit = queue.lock().unwrap();
    let path = format!(
        "{}/priority",
        super::client::api_base_path(entry.site.auth_type)
    );
    let request = HttpRequest {
        url: format!("{}{path}", entry.site.site_url),
        method: "GET",
        authorization: &entry.authorization,
        body: None,
        cancel: None,
        timeout: super::client::REQUEST_TIMEOUT,
    };
    let outcome = jira_request(&request).map(|response| {
        response
            .as_array()
            .map(|records| {
                records
                    .iter()
                    .filter_map(|record| map_priority(Some(record)))
                    .collect::<Vec<JiraPriority>>()
            })
            .unwrap_or_default()
    });
    match outcome {
        Ok(priorities) => Ok(priorities),
        Err(error) => {
            if error.status() == Some(401) {
                clear_token(state, &entry.site.id);
            }
            Err(to_rpc_error(&error))
        }
    }
}

/// The fork's `searchUsers`: reporter/user pickers are not limited to
/// assignable users. Server/DC filters by `username` (rejects an empty
/// one, so the wildcard `.` means "everyone"); Cloud uses `query`.
pub fn search_users(
    state: &JiraState,
    query: Option<&str>,
    site_id: Option<&str>,
) -> Result<Vec<JiraUser>, RpcError> {
    let entry = first_client(state, site_id)?;
    let Some(entry) = entry else {
        return Ok(Vec::new());
    };
    let is_server = entry.site.auth_type == JiraAuthType::Server;
    let trimmed = query.map(str::trim).unwrap_or("");
    let filter_value = if trimmed.is_empty() {
        if is_server { "." } else { "" }
    } else {
        trimmed
    };
    let param = if is_server { "username" } else { "query" };
    let path = format!(
        "{}/user/search?maxResults=50&{param}={}",
        super::client::api_base_path(entry.site.auth_type),
        encode_query_value(filter_value)
    );
    let queue = state.site_queue(&entry.site.id);
    let _permit = queue.lock().unwrap();
    let request = HttpRequest {
        url: format!("{}{path}", entry.site.site_url),
        method: "GET",
        authorization: &entry.authorization,
        body: None,
        cancel: None,
        timeout: super::client::REQUEST_TIMEOUT,
    };
    let outcome = jira_request(&request).map(|response| {
        response
            .as_array()
            .map(|records| {
                records
                    .iter()
                    .filter_map(|record| map_user(Some(record)))
                    .collect::<Vec<JiraUser>>()
            })
            .unwrap_or_default()
    });
    match outcome {
        Ok(users) => Ok(users),
        Err(error) => {
            if error.status() == Some(401) {
                clear_token(state, &entry.site.id);
                return Err(to_rpc_error(&error));
            }
            // Browse-users permission is optional; the fork's dialog falls
            // back to a text field, so this degrades to [] by design.
            Ok(Vec::new())
        }
    }
}

pub(crate) fn first_client(
    state: &JiraState,
    site_id: Option<&str>,
) -> Result<Option<ClientForSite>, RpcError> {
    let clients = get_clients(
        &state.sites,
        site_id.map(|id| {
            if id == "all" {
                SiteSelection::All
            } else {
                SiteSelection::Site(id.to_string())
            }
        }),
    )?;
    Ok(clients.into_iter().next())
}

pub(crate) fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn encode_query_value(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else if byte == b' ' {
            encoded.push('+');
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_jql_matches_the_fork_verbatim() {
        assert_eq!(
            filter_to_jql(JiraIssueFilter::Assigned),
            "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC"
        );
        assert_eq!(
            filter_to_jql(JiraIssueFilter::Reported),
            "reporter = currentUser() AND resolution = Unresolved ORDER BY updated DESC"
        );
        assert_eq!(
            filter_to_jql(JiraIssueFilter::Done),
            "assignee = currentUser() AND resolution IS NOT EMPTY ORDER BY updated DESC"
        );
        assert_eq!(
            filter_to_jql(JiraIssueFilter::All),
            "resolution = Unresolved ORDER BY updated DESC"
        );
    }

    #[test]
    fn clamp_limit_matches_the_fork_bounds() {
        assert_eq!(clamp_limit(None), 30);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(500)), 100);
        assert_eq!(clamp_limit(Some(7)), 7);
    }

    #[test]
    fn parses_jira_timestamps_with_and_without_zone() {
        assert_eq!(
            parse_jira_timestamp("1970-01-01T00:00:00.000+0000"),
            Some(0)
        );
        assert_eq!(parse_jira_timestamp("1970-01-01T01:00:00.000Z"), Some(3600));
        // +0100 means local time one hour ahead of UTC.
        assert_eq!(
            parse_jira_timestamp("1970-01-01T01:00:00.000+0100"),
            Some(0)
        );
        assert_eq!(parse_jira_timestamp("not a date"), None);
    }

    #[test]
    fn should_fetch_next_page_obeys_total_is_last_and_page_size() {
        let page = |total: u64, is_last: Option<bool>| {
            let mut value = serde_json::json!({"total": total, "maxResults": 2});
            if let Some(is_last) = is_last {
                value["isLast"] = serde_json::json!(is_last);
            }
            value
        };
        assert!(!should_fetch_next_page(&page(5, Some(true)), 0, 2, 100));
        assert!(!should_fetch_next_page(&page(5, None), 0, 0, 100));
        assert!(should_fetch_next_page(&page(5, None), 0, 2, 100));
        assert!(!should_fetch_next_page(&page(5, None), 4, 1, 100));
        // total absent, isLast explicit false → keep paging while pages come.
        let mut value = serde_json::json!({"isLast": false, "maxResults": 2});
        value.as_object_mut().unwrap().remove("total");
        assert!(should_fetch_next_page(&value, 0, 2, 100));
        // total absent, no isLast → continue only when the page is full.
        let value = serde_json::json!({"maxResults": 2});
        assert!(should_fetch_next_page(&value, 0, 2, 100));
        assert!(!should_fetch_next_page(&value, 0, 1, 100));
    }
}
