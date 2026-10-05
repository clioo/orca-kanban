//! Jira HTTP transport (R17-A): authenticated requests over a bounded
//! `curl` child, ported from the fork's
//! `src/main/jira/authenticated-request.ts`, `request-queue.ts` and
//! `jira-read-failure.ts`.
//!
//! The fork rides Electron's `net.fetch`; Drogon's daemon has no HTTP
//! client dependency, so each request spawns the platform `curl` with the
//! same headers, JSON body, redirect handling, 30s deadline and a
//! renderer-visible cancellation flag (the fork aborts a search when the
//! query changes). A per-site mutex serializes requests, matching the
//! fork's bounded request pool from the site's point of view.
//! MIT Copyright (c) 2026 Lovecast Inc.

use std::io::Read as _;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::protocol::RpcError;
use crate::protocol::jira::JiraAuthType;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

/// Why: Atlassian's XSRF filter rejects POST/PUT REST calls that carry a
/// browser User-Agent, failing them with "XSRF check failed" even under
/// API-token auth (fork comment, kept verbatim).
const JIRA_API_USER_AGENT: &str = "Orca";

/// The fork's issue-search deadline (`ISSUE_SEARCH_TIMEOUT_MS`).
pub const ISSUE_SEARCH_TIMEOUT_MS: Duration = Duration::from_millis(30_000);
/// Default per-request ceiling; matches the search deadline so a hung site
/// can never park a request pool slot longer than the fork allows.
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_millis(30_000);
/// Response bodies are bounded before they ever reach the 1 MiB frame cap.
const MAX_BODY_BYTES: u64 = 8 * 1024 * 1024;
const CONNECT_TIMEOUT_SECS: &str = "10";

/// Self-hosted Jira Server/DC only exposes REST v2; Cloud endpoints are
/// written against v3 (the fork's `apiBasePath`).
pub fn api_base_path(auth_type: JiraAuthType) -> &'static str {
    match auth_type {
        JiraAuthType::Server => "/rest/api/2",
        JiraAuthType::Cloud => "/rest/api/3",
    }
}

/// Basic email+token for Cloud (and classic Server auth with a username);
/// Bearer for Server PATs — the fork's `authHeader`.
pub fn auth_header(email: &str, api_token: &str, auth_type: JiraAuthType) -> String {
    if auth_type == JiraAuthType::Server && email.is_empty() {
        return format!("Bearer {api_token}");
    }
    format!("Basic {}", STANDARD.encode(format!("{email}:{api_token}")))
}

/// Cancellation flag shared between a search thread and a later
/// `jira.cancelSearchIssues` dispatch (another connection).
#[derive(Debug, Clone, Default)]
pub struct CancelFlag(pub Arc<AtomicBool>);

impl CancelFlag {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }
    pub fn cancel(&self) {
        self.0.store(true, AtomicOrdering::SeqCst);
    }
    pub fn cancelled(&self) -> bool {
        self.0.load(AtomicOrdering::SeqCst)
    }
}

/// A failure from one Jira HTTP call, with the fork's status taxonomy.
#[derive(Debug, Clone)]
pub enum JiraRequestError {
    /// HTTP error with a parsed status; carries Retry-After for 429s.
    Api {
        message: String,
        status: u32,
        retry_after: Option<u64>,
    },
    /// DNS/TCP/TLS failure — the fork's network/offline case.
    Network(String),
    /// The deadline or the overall search timeout tripped.
    Timeout,
    /// Abandoned by the renderer (query changed) or a superseding call.
    Cancelled,
}

impl JiraRequestError {
    pub fn status(&self) -> Option<u32> {
        match self {
            JiraRequestError::Api { status, .. } => Some(*status),
            _ => None,
        }
    }
}

/// Map one HTTP failure to the wire error taxonomy. 401 means the saved
/// credential itself is invalid (the fork's `isAuthError`; Jira returns
/// 403 for project/API permission gaps even when /myself succeeds).
pub fn to_rpc_error(error: &JiraRequestError) -> RpcError {
    match error {
        JiraRequestError::Api {
            message,
            status,
            retry_after,
        } => {
            let code = match status {
                401 => "jira_auth_required",
                403 => "jira_forbidden",
                404 => "jira_not_found",
                429 => "jira_rate_limited",
                400 => "jira_bad_request",
                _ => "jira_error",
            };
            let mut mapped = RpcError::new(code, message.clone());
            if *status == 429 {
                mapped.retryable = true;
                if let Some(seconds) = retry_after {
                    mapped.message = format!("{message} (retry after {seconds}s)");
                }
            }
            mapped
        }
        JiraRequestError::Network(message) => {
            let mut mapped = RpcError::new("jira_unreachable", message.clone());
            mapped.retryable = true;
            mapped
        }
        JiraRequestError::Timeout => {
            let mut mapped = RpcError::new(
                "jira_unreachable",
                "Jira request timed out; the site may be slow or unreachable.",
            );
            mapped.retryable = true;
            mapped
        }
        JiraRequestError::Cancelled => RpcError::new("jira_cancelled", "Jira search cancelled."),
    }
}

#[cfg(test)]
fn is_credential_error(error: &JiraRequestError) -> bool {
    matches!(error, JiraRequestError::Api { status: 401, .. })
}

// --- curl binary resolution (test seam mirrors tasks_rpc's gh override) ---

static CURL_BIN_OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Test seam: override the `curl` binary path for this process, or `None`
/// to resolve `curl` from `PATH` again. Never process-global environment
/// state — the same rationale as `tasks_rpc::set_gh_bin_override`.
pub fn set_curl_bin_override(path: Option<PathBuf>) {
    *CURL_BIN_OVERRIDE.lock().unwrap() = path;
}

pub(crate) fn curl_bin() -> PathBuf {
    CURL_BIN_OVERRIDE
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| PathBuf::from("curl"))
}

/// Everything one curl invocation needs to describe its own request.
pub struct HttpRequest<'a> {
    pub url: String,
    pub method: &'a str,
    pub authorization: &'a str,
    pub body: Option<String>,
    pub cancel: Option<&'a CancelFlag>,
    pub timeout: Duration,
}

struct TempFiles {
    body: PathBuf,
    headers: PathBuf,
    request_body: Option<PathBuf>,
}

impl TempFiles {
    fn new(tag: &str) -> std::io::Result<Self> {
        let dir = std::env::temp_dir();
        let unique = format!(
            "{}-{}-{}",
            std::process::id(),
            tag,
            Instant::now().elapsed().as_nanos()
        );
        Ok(Self {
            body: dir.join(format!("drogon-jira-{unique}.body")),
            headers: dir.join(format!("drogon-jira-{unique}.headers")),
            request_body: None,
        })
    }

    fn cleanup(&self) {
        let _ = std::fs::remove_file(&self.body);
        let _ = std::fs::remove_file(&self.headers);
        if let Some(path) = &self.request_body {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn next_temp_counter() -> u64 {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    COUNTER.fetch_add(1, AtomicOrdering::SeqCst)
}

struct CurlOutcome {
    http_status: Option<u32>,
    body: String,
    headers: String,
}

fn spawn_curl(
    request: &HttpRequest<'_>,
    files: &mut TempFiles,
    max_time_secs: u64,
) -> Result<CurlOutcome, JiraRequestError> {
    let mut argv: Vec<String> = vec![
        "-sS".into(),
        "-L".into(),
        "--connect-timeout".into(),
        CONNECT_TIMEOUT_SECS.into(),
        "--max-time".into(),
        max_time_secs.to_string(),
        "-o".into(),
        files.body.to_string_lossy().into_owned(),
        "-D".into(),
        files.headers.to_string_lossy().into_owned(),
        "-w".into(),
        "%{http_code}".into(),
        "-X".into(),
        request.method.into(),
        "-H".into(),
        "Accept: application/json".into(),
        "-H".into(),
        "Content-Type: application/json".into(),
        "-H".into(),
        format!("User-Agent: {JIRA_API_USER_AGENT}"),
        "-H".into(),
        format!("Authorization: {}", request.authorization),
    ];
    if let Some(body) = &request.body {
        let body_path = files.body.with_extension("request-body");
        std::fs::write(&body_path, body).map_err(|e| {
            JiraRequestError::Network(format!("cannot stage jira request body: {e}"))
        })?;
        argv.push("--data-binary".into());
        argv.push(format!("@{}", body_path.display()));
        files.request_body = Some(body_path);
    }
    argv.push(request.url.clone());

    let mut child: Child = Command::new(curl_bin())
        .args(&argv)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| JiraRequestError::Network(format!("cannot spawn curl: {e}")))?;

    let outcome = wait_bounded(&mut child, request.cancel, request.timeout);
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout);
    }
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    let _ = child.wait();

    match outcome {
        BoundedOutcome::Exited => {}
        BoundedOutcome::TimedOut => return Err(JiraRequestError::Timeout),
        BoundedOutcome::Cancelled => return Err(JiraRequestError::Cancelled),
    }

    // curl exit code 28 = --max-time expired (and 5/6/7 = DNS/TCP/conn).
    let code = child_code_hint(&stderr);
    if let Some(28) = code {
        return Err(JiraRequestError::Timeout);
    }

    let body = match std::fs::metadata(&files.body) {
        Ok(meta) if meta.len() > MAX_BODY_BYTES => {
            return Err(JiraRequestError::Network(format!(
                "jira response exceeded the {} byte body cap",
                MAX_BODY_BYTES
            )));
        }
        _ => std::fs::read_to_string(&files.body)
            .map_err(|e| JiraRequestError::Network(format!("cannot read jira response: {e}")))?,
    };
    let headers = std::fs::read_to_string(&files.headers).unwrap_or_default();
    let http_status = stdout
        .trim()
        .parse::<u32>()
        .ok()
        .filter(|status| *status > 0);
    match http_status {
        Some(status) => Ok(CurlOutcome {
            http_status: Some(status),
            body,
            headers,
        }),
        None => Err(JiraRequestError::Network(format!(
            "curl failed without an HTTP response: {}",
            stderr.trim()
        ))),
    }
}

fn child_code_hint(stderr: &str) -> Option<u32> {
    // stderr from -sS looks like "curl: (28) Operation timed out...".
    let start = stderr.find("curl: (")? + "curl: (".len();
    let end = stderr[start..].find(')')? + start;
    stderr[start..end].parse().ok()
}

enum BoundedOutcome {
    Exited,
    TimedOut,
    Cancelled,
}

/// Wait for the child with a deadline and a cooperative cancel flag,
/// killing on either. The fork's deadline (`withJiraDeadline`) aborts the
/// fetch; here the fetch is a process, so abort = kill.
fn wait_bounded(
    child: &mut Child,
    cancel: Option<&CancelFlag>,
    timeout: Duration,
) -> BoundedOutcome {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return BoundedOutcome::Exited,
            Ok(None) => {}
            Err(_) => return BoundedOutcome::Exited,
        }
        if cancel.is_some_and(|flag| flag.cancelled()) {
            let _ = child.kill();
            let _ = child.wait();
            return BoundedOutcome::Cancelled;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return BoundedOutcome::TimedOut;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// The fork's `readJiraError`: Jira error bodies are
/// `{ errorMessages[], errors{}, message }`; fall back to a status-only
/// sentence when nothing parses.
#[cfg(test)]
fn read_jira_error(status: u32, body: &str) -> String {
    read_service_error(status, body, "Jira")
}

/// The message a failed JSON API answer carries: Jira's `errorMessages` /
/// `errors` map, GitHub's `message`, or a GraphQL `errors` list.
fn read_service_error(status: u32, body: &str, service: &str) -> String {
    if let Ok(data) = serde_json::from_str::<serde_json::Value>(body) {
        let mut messages: Vec<String> = Vec::new();
        if let Some(error_messages) = data
            .get("errorMessages")
            .and_then(serde_json::Value::as_array)
        {
            messages.extend(
                error_messages
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_string),
            );
        }
        if let Some(errors) = data.get("errors").and_then(serde_json::Value::as_array) {
            messages.extend(
                errors
                    .iter()
                    .filter_map(|e| e.get("message").and_then(serde_json::Value::as_str))
                    .map(str::to_string),
            );
        }
        if let Some(errors) = data.get("errors").and_then(serde_json::Value::as_object) {
            messages.extend(
                errors
                    .values()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_string),
            );
        }
        if let Some(message) = data.get("message").and_then(serde_json::Value::as_str) {
            messages.push(message.to_string());
        }
        messages.retain(|message| !message.is_empty());
        if !messages.is_empty() {
            return messages.join("; ");
        }
    }
    format!("{service} request failed ({status})")
}

/// Parse the final header block out of a curl `-D` dump (redirects prepend
/// earlier blocks) and pick up Retry-After for the 429 mapping.
fn parse_last_header_block(headers: &str) -> (Option<u32>, Option<u64>) {
    let last_block = headers
        .split("\r\n\r\n")
        .map(str::trim)
        .filter(|block| !block.is_empty() && block.starts_with("HTTP/"))
        .last()
        .unwrap_or("");
    let mut status = None;
    let mut retry_after = None;
    for line in last_block.lines() {
        if let Some(rest) = line.strip_prefix("HTTP/") {
            status = rest
                .split_whitespace()
                .nth(1)
                .and_then(|code| code.parse().ok());
            continue;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.trim().eq_ignore_ascii_case("retry-after")
        {
            retry_after = value
                .trim()
                .parse::<u64>()
                .ok()
                .or_else(|| http_date_to_delay_secs(value.trim()));
        }
    }
    (status, retry_after)
}

fn http_date_to_delay_secs(value: &str) -> Option<u64> {
    // Retry-After may be an HTTP date; without a date-parsing dependency we
    // honor the common numeric form and treat dates as "retry later" (0s
    // would be a lie, so return None and omit the hint).
    let _ = value;
    None
}

/// Execute one authenticated Jira request and parse the JSON body — the
/// fork's `jiraRequest`. The full URL rides on the request.
pub fn jira_request(request: &HttpRequest<'_>) -> Result<serde_json::Value, JiraRequestError> {
    http_json(request, "Jira")
}

/// One JSON request over curl to any service (Jira, Linear, GitHub): the
/// same bounded transport, with `service` naming it in error messages.
pub(crate) fn http_json(
    request: &HttpRequest<'_>,
    service: &str,
) -> Result<serde_json::Value, JiraRequestError> {
    let mut files = TempFiles::new(&format!("req-{}", next_temp_counter()))
        .map_err(|e| JiraRequestError::Network(format!("cannot stage jira response files: {e}")))?;
    let outcome = spawn_curl(request, &mut files, request.timeout.as_secs().max(1) + 1);
    files.cleanup();
    let outcome = outcome?;
    let status = outcome.http_status.unwrap_or(0);
    if !(200..300).contains(&status) {
        let (_, retry_after) = parse_last_header_block(&outcome.headers);
        return Err(JiraRequestError::Api {
            message: read_service_error(status, &outcome.body, service),
            status,
            retry_after,
        });
    }
    if status == 204 {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&outcome.body).map_err(|e| {
        JiraRequestError::Network(format!(
            "{} returned a non-JSON response: {e}",
            service.to_lowercase()
        ))
    })
}

/// Serialize the auth failure prefix the fork adds for surfaced site
/// failures (`toIssueSearchFailureError`): "Error {status}: {message}".
pub fn failure_message(error: &JiraRequestError) -> String {
    match error {
        JiraRequestError::Api {
            message, status, ..
        } => format!("Error {status}: {message}"),
        JiraRequestError::Network(message) => message.clone(),
        JiraRequestError::Timeout => "Jira request timed out.".to_string(),
        JiraRequestError::Cancelled => "Jira search cancelled.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_header_matches_the_fork() {
        assert_eq!(
            auth_header("me@example.com", "tok", JiraAuthType::Cloud),
            format!("Basic {}", STANDARD.encode("me@example.com:tok"))
        );
        assert_eq!(auth_header("", "pat", JiraAuthType::Server), "Bearer pat");
        // Server with a username is classic Basic, like Cloud.
        assert_eq!(
            auth_header("jsmith", "pw", JiraAuthType::Server),
            format!("Basic {}", STANDARD.encode("jsmith:pw"))
        );
    }

    #[test]
    fn api_base_path_splits_by_deployment() {
        assert_eq!(api_base_path(JiraAuthType::Cloud), "/rest/api/3");
        assert_eq!(api_base_path(JiraAuthType::Server), "/rest/api/2");
    }

    #[test]
    fn read_jira_error_prefers_structured_messages() {
        let body = r#"{"errorMessages": ["The value 'ABC' does not exist"], "errors": {}}"#;
        assert_eq!(read_jira_error(400, body), "The value 'ABC' does not exist");
        let body = r#"{"errorMessages": [], "errors": {"summary": "required"}}"#;
        assert_eq!(read_jira_error(400, body), "required");
        assert_eq!(
            read_jira_error(503, "<html>nope</html>"),
            "Jira request failed (503)"
        );
    }

    #[test]
    fn other_services_errors_read_as_their_own_messages() {
        let graphql =
            r#"{"errors": [{"message": "Entity not found: Issue"}, {"message": "second"}]}"#;
        assert_eq!(
            read_service_error(400, graphql, "Linear"),
            "Entity not found: Issue; second"
        );
        assert_eq!(
            read_service_error(401, r#"{"message": "Bad credentials"}"#, "GitHub"),
            "Bad credentials"
        );
        assert_eq!(
            read_service_error(502, "", "GitHub"),
            "GitHub request failed (502)"
        );
    }

    #[test]
    fn parses_last_header_block_and_retry_after() {
        let headers = "HTTP/1.1 301 Moved\r\nLocation: https://x/rest/api/3/search/jql\r\n\r\nHTTP/2 429 \r\nretry-after: 37\r\ncontent-type: application/json\r\n\r\n";
        let (status, retry_after) = parse_last_header_block(headers);
        assert_eq!(status, Some(429));
        assert_eq!(retry_after, Some(37));
    }

    #[test]
    fn error_mapping_uses_the_fork_taxonomy() {
        let err = to_rpc_error(&JiraRequestError::Api {
            message: "nope".into(),
            status: 401,
            retry_after: None,
        });
        assert_eq!(err.code, "jira_auth_required");
        assert!(!err.retryable);
        let err = to_rpc_error(&JiraRequestError::Api {
            message: "slow down".into(),
            status: 429,
            retry_after: Some(5),
        });
        assert_eq!(err.code, "jira_rate_limited");
        assert!(err.retryable);
        assert!(err.message.contains("retry after 5s"));
        let err = to_rpc_error(&JiraRequestError::Network("down".into()));
        assert_eq!(err.code, "jira_unreachable");
        assert!(err.retryable);
    }

    #[test]
    fn only_401_counts_as_a_credential_error() {
        assert!(is_credential_error(&JiraRequestError::Api {
            message: "x".into(),
            status: 401,
            retry_after: None,
        }));
        assert!(!is_credential_error(&JiraRequestError::Api {
            message: "x".into(),
            status: 403,
            retry_after: None,
        }));
    }
}
