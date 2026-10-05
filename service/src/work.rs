//! Work: the ticket board (`work.*`), ported from Drogon to run beside Orca.
//!
//! A ticket is a Drogon record with its own key (`DRG-41`), optionally
//! linked to an external source by URL and to a pull request. Tickets sit
//! in user-defined columns; each column can carry a prompt that is typed
//! into the sessions linked to its tickets:
//!
//! - when a ticket enters the column (moved, or created in it),
//! - on a cron schedule (every ticket in the column),
//! - when a ticket's pull request changes (state, review, checks, head),
//! - or on demand (`work.column_send`, the UI's "Send now").
//!
//! Delivery per linked session: a live session is typed into right away
//! (the same framed body + separate Return keypress as `terminal send`); a
//! session that is no longer live is resumed through `harness.start` with
//! `resumeSessionId`, which falls back to a fresh start when the harness has
//! no conversation to resume; a ticket with nothing to resume gets a new
//! session in its workspace. Replacement sessions are relinked to the ticket
//! at the generic resume boundary ([`relink_resumed_session`]).
//!
//! Every delivery is recorded in `work_sends`, so the board can say when a
//! column last sent and what each session got.

use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde_json::{Value, json};

use crate::protocol::RpcError;
use crate::{Engine, error};

mod github;
mod linear;
pub(crate) mod provider;
mod sources;
mod sync;

pub(crate) const SCHEMA_COMPONENT: &str = "work";
/// v1: local board. v2: imported provider boards (Jira), column↔status
/// mapping, sprints, sync state and the ticket activity log. v3: the
/// sources the owner allows and their connections (Linear, GitHub). v4: a
/// board can keep importing new issues assigned to the owner. v5: columns
/// can be collapsed. v6: the workspace made for a ticket, where its New
/// session starts. v7: a board workspace column (retired, unused).
pub(crate) const SCHEMA_VERSION: i64 = 7;

/// How often a watched pull request is re-read (`gh pr view`).
pub(crate) const PR_POLL_MS: i64 = 5 * 60_000;

const MAX_NAME: usize = 64;
const MAX_TITLE: usize = 200;
const MAX_TEXT: usize = 20_000;
const MAX_MESSAGE: usize = 16_000;
const MAX_URL: usize = 2048;
const MAX_SENDS_PAGE: i64 = 200;
/// How much of each description the board listing carries.
const BOARD_DESCRIPTION_CHARS: usize = 140;

/// The first `max` characters of `text` (at a character boundary), and
/// whether anything was cut.
fn excerpt(text: &str, max: usize) -> (String, bool) {
    match text.char_indices().nth(max) {
        Some((cut, _)) => (format!("{}…", text[..cut].trim_end()), true),
        None => (text.to_string(), false),
    }
}

pub(crate) const ICONS: &[&str] = &[
    "backlog",
    "todo",
    "in_progress",
    "review",
    "qa",
    "done",
    "blocked",
];

const DEFAULT_COLUMNS: &[(&str, &str)] = &[
    ("To do", "todo"),
    ("In progress", "in_progress"),
    ("Review", "review"),
    ("QA", "qa"),
    ("Done", "done"),
];

/// One delivery at a time: a scheduled send and a drag that land together
/// must not interleave two prompts into the same composer.
static DELIVERY_LOCK: Mutex<()> = Mutex::new(());

// ---------------------------------------------------------------- schema --

pub(crate) fn apply_pending_steps_in_tx(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_versions (
            component TEXT PRIMARY KEY,
            version INTEGER NOT NULL
        );",
    )?;
    let existing: Option<i64> = tx
        .query_row(
            "SELECT version FROM schema_versions WHERE component = ?1",
            params![SCHEMA_COMPONENT],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(found) = existing
        && found > SCHEMA_VERSION
    {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(1),
            Some(format!(
                "{SCHEMA_COMPONENT} schema version {found} is newer than supported {SCHEMA_VERSION}"
            )),
        ));
    }
    if existing == Some(SCHEMA_VERSION) {
        return Ok(());
    }
    if existing.unwrap_or(0) < 1 {
        apply_v1(tx)?;
    }
    if existing.unwrap_or(0) < 2 {
        apply_v2(tx)?;
    }
    if existing.unwrap_or(0) < 3 {
        apply_v3(tx)?;
    }
    if existing.unwrap_or(0) < 4 {
        add_column(
            tx,
            "work_boards",
            "auto_import_mine",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
    }
    if existing.unwrap_or(0) < 5 {
        add_column(
            tx,
            "work_columns",
            "collapsed",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
    }
    if existing.unwrap_or(0) < 6 {
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS work_ticket_workspaces (
                ticket_id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL
            );",
        )?;
    }
    if existing.unwrap_or(0) < 7 {
        // 0.2.1's board workspace default. Retired in 0.2.2 (agents work in
        // a repo or a folder project); kept so a 0.2.1 database opens as is.
        add_column(tx, "work_boards", "workspace_id", "TEXT")?;
    }
    tx.execute(
        "INSERT INTO schema_versions (component, version) VALUES (?1, ?2)
         ON CONFLICT(component) DO UPDATE SET version = excluded.version",
        params![SCHEMA_COMPONENT, SCHEMA_VERSION],
    )?;
    Ok(())
}

fn apply_v1(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS work_columns (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            position INTEGER NOT NULL,
            send_on_enter INTEGER NOT NULL DEFAULT 0,
            cron TEXT,
            pr_watch INTEGER NOT NULL DEFAULT 0,
            message TEXT NOT NULL DEFAULT '',
            recipients TEXT NOT NULL DEFAULT 'all',
            harness_id TEXT,
            next_run_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS work_tickets (
            id TEXT PRIMARY KEY,
            key TEXT NOT NULL UNIQUE,
            project_id TEXT,
            workspace_id TEXT,
            column_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            pr_url TEXT,
            pr_number INTEGER,
            source_url TEXT,
            next_step TEXT NOT NULL DEFAULT '',
            pr_fingerprint TEXT,
            pr_checked_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS work_tickets_column ON work_tickets(column_id, position);
        CREATE TABLE IF NOT EXISTS work_ticket_sessions (
            ticket_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            linked_at INTEGER NOT NULL,
            PRIMARY KEY(ticket_id, session_id)
        );
        CREATE INDEX IF NOT EXISTS work_ticket_sessions_session ON work_ticket_sessions(session_id);
        CREATE TABLE IF NOT EXISTS work_key_counters (
            prefix TEXT PRIMARY KEY,
            next INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS work_sends (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            column_id TEXT,
            ticket_id TEXT NOT NULL,
            trigger TEXT NOT NULL,
            message TEXT NOT NULL,
            results TEXT NOT NULL,
            at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS work_sends_column ON work_sends(column_id, at);
        CREATE INDEX IF NOT EXISTS work_sends_ticket ON work_sends(ticket_id, at);",
    )?;
    let columns: i64 = tx.query_row("SELECT COUNT(*) FROM work_columns", [], |r| r.get(0))?;
    if columns == 0 {
        let now = crate::now_unix_ms() as i64;
        for (index, (name, icon)) in DEFAULT_COLUMNS.iter().enumerate() {
            tx.execute(
                "INSERT INTO work_columns (id, name, icon, position, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    name,
                    icon,
                    index as i64,
                    now
                ],
            )?;
        }
    }
    Ok(())
}

fn add_column(tx: &Transaction, table: &str, column: &str, decl: &str) -> rusqlite::Result<()> {
    let exists: bool = tx
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|name| name == column);
    if !exists {
        tx.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
    }
    Ok(())
}

/// Additive: a row per source the owner changed; an absent row is an
/// allowed, unconnected source.
fn apply_v3(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS work_sources (
            provider TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 1,
            api_url TEXT,
            site_url TEXT,
            account TEXT,
            updated_at INTEGER NOT NULL
        );",
    )
}

/// Additive: every v1 row keeps its meaning (`board_id` NULL = My work).
fn apply_v2(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS work_boards (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            site_id TEXT NOT NULL,
            site_url TEXT NOT NULL DEFAULT '',
            external_id TEXT NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            project_key TEXT,
            project_name TEXT,
            project_id TEXT,
            statuses TEXT NOT NULL DEFAULT '[]',
            last_synced_at INTEGER,
            last_sync_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(provider, site_id, external_id)
        );
        CREATE TABLE IF NOT EXISTS work_sprints (
            board_id TEXT NOT NULL,
            ext_id TEXT NOT NULL,
            name TEXT NOT NULL,
            state TEXT NOT NULL,
            start_at TEXT,
            end_at TEXT,
            position INTEGER NOT NULL,
            PRIMARY KEY(board_id, ext_id)
        );
        CREATE TABLE IF NOT EXISTS work_ticket_sprints (
            ticket_id TEXT NOT NULL,
            sprint_id TEXT NOT NULL,
            status_name TEXT,
            first_seen_at INTEGER NOT NULL,
            PRIMARY KEY(ticket_id, sprint_id)
        );
        CREATE TABLE IF NOT EXISTS work_activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            text TEXT NOT NULL,
            at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS work_activity_ticket ON work_activity(ticket_id, at);",
    )?;
    add_column(tx, "work_columns", "board_id", "TEXT")?;
    add_column(tx, "work_columns", "statuses", "TEXT NOT NULL DEFAULT '[]'")?;
    for (column, decl) in [
        ("board_id", "TEXT"),
        ("ext_id", "TEXT"),
        ("ext_key", "TEXT"),
        ("ext_url", "TEXT"),
        ("issue_type", "TEXT"),
        ("priority", "TEXT"),
        ("assignee", "TEXT"),
        ("ext_status_id", "TEXT"),
        ("ext_status_name", "TEXT"),
        ("ext_status_category", "TEXT"),
        ("pending_status_id", "TEXT"),
        ("status_conflict", "INTEGER NOT NULL DEFAULT 0"),
        ("sprint_id", "TEXT"),
        ("ext_sprint_id", "TEXT"),
        ("push_error", "TEXT"),
        ("removed_at", "INTEGER"),
    ] {
        add_column(tx, "work_tickets", column, decl)?;
    }
    add_column(tx, "work_ticket_sessions", "label", "TEXT")?;
    tx.execute_batch(
        "CREATE INDEX IF NOT EXISTS work_tickets_board ON work_tickets(board_id, sprint_id);
         CREATE INDEX IF NOT EXISTS work_columns_board ON work_columns(board_id, position);",
    )?;
    Ok(())
}

// ------------------------------------------------------------- records --

#[derive(Clone, Debug)]
struct Column {
    id: String,
    name: String,
    icon: String,
    position: i64,
    send_on_enter: bool,
    cron: Option<String>,
    pr_watch: bool,
    message: String,
    recipients: String,
    harness_id: Option<String>,
    next_run_at: Option<i64>,
    /// `None` = the local board ("My work").
    board_id: Option<String>,
    /// Provider statuses this column stands for (empty = Drogon-only).
    statuses: Vec<BoardStatus>,
    /// Shown as a narrow strip (Canceled, Duplicate…); still a drop target.
    collapsed: bool,
}

/// A provider status as the board records it.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BoardStatus {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub category: String,
}

#[derive(Clone, Debug)]
struct Ticket {
    id: String,
    key: String,
    project_id: Option<String>,
    workspace_id: Option<String>,
    column_id: String,
    position: i64,
    title: String,
    description: String,
    pr_url: Option<String>,
    pr_number: Option<i64>,
    source_url: Option<String>,
    next_step: String,
    pr_fingerprint: Option<String>,
    pr_checked_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
    ext: TicketExt,
}

/// A ticket's provider side; all `None`/default for a local ticket.
#[derive(Clone, Debug, Default)]
struct TicketExt {
    board_id: Option<String>,
    id: Option<String>,
    key: Option<String>,
    url: Option<String>,
    issue_type: Option<String>,
    priority: Option<String>,
    assignee: Option<String>,
    status_id: Option<String>,
    status_name: Option<String>,
    status_category: Option<String>,
    /// A local move not yet pushed: the status it asks for.
    pending_status_id: Option<String>,
    /// The provider changed status while a local move was pending.
    status_conflict: bool,
    /// The sprint the ticket is in on the board (local view).
    sprint_id: Option<String>,
    /// The provider's sprint; differs from `sprint_id` while a carry-over
    /// or send-to-backlog is unsynced.
    ext_sprint_id: Option<String>,
    push_error: Option<String>,
    removed_at: Option<i64>,
}

const COLUMN_SELECT: &str = "SELECT id, name, icon, position, send_on_enter, cron, pr_watch, message, recipients, harness_id, next_run_at, board_id, statuses, collapsed FROM work_columns";
const TICKET_SELECT: &str = "SELECT id, key, project_id, workspace_id, column_id, position, title, description, pr_url, pr_number, source_url, next_step, pr_fingerprint, pr_checked_at, created_at, updated_at, board_id, ext_id, ext_key, ext_url, issue_type, priority, assignee, ext_status_id, ext_status_name, ext_status_category, pending_status_id, status_conflict, sprint_id, ext_sprint_id, push_error, removed_at FROM work_tickets";

fn column_from_row(r: &rusqlite::Row) -> rusqlite::Result<Column> {
    Ok(Column {
        id: r.get(0)?,
        name: r.get(1)?,
        icon: r.get(2)?,
        position: r.get(3)?,
        send_on_enter: r.get::<_, i64>(4)? != 0,
        cron: r.get(5)?,
        pr_watch: r.get::<_, i64>(6)? != 0,
        message: r.get(7)?,
        recipients: r.get(8)?,
        harness_id: r.get(9)?,
        next_run_at: r.get(10)?,
        board_id: r.get(11)?,
        statuses: serde_json::from_str(&r.get::<_, String>(12)?).unwrap_or_default(),
        collapsed: r.get::<_, i64>(13)? != 0,
    })
}

fn ticket_from_row(r: &rusqlite::Row) -> rusqlite::Result<Ticket> {
    Ok(Ticket {
        id: r.get(0)?,
        key: r.get(1)?,
        project_id: r.get(2)?,
        workspace_id: r.get(3)?,
        column_id: r.get(4)?,
        position: r.get(5)?,
        title: r.get(6)?,
        description: r.get(7)?,
        pr_url: r.get(8)?,
        pr_number: r.get(9)?,
        source_url: r.get(10)?,
        next_step: r.get(11)?,
        pr_fingerprint: r.get(12)?,
        pr_checked_at: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
        ext: TicketExt {
            board_id: r.get(16)?,
            id: r.get(17)?,
            key: r.get(18)?,
            url: r.get(19)?,
            issue_type: r.get(20)?,
            priority: r.get(21)?,
            assignee: r.get(22)?,
            status_id: r.get(23)?,
            status_name: r.get(24)?,
            status_category: r.get(25)?,
            pending_status_id: r.get(26)?,
            status_conflict: r.get::<_, i64>(27)? != 0,
            sprint_id: r.get(28)?,
            ext_sprint_id: r.get(29)?,
            push_error: r.get(30)?,
            removed_at: r.get(31)?,
        },
    })
}

/// The columns of one board (`None` = My work), in order.
fn list_columns(conn: &Connection, board_id: Option<&str>) -> Result<Vec<Column>, RpcError> {
    let mut stmt = conn
        .prepare(&format!(
            "{COLUMN_SELECT} WHERE board_id IS ?1 ORDER BY position, created_at"
        ))
        .map_err(error::from_sqlite)?;
    stmt.query_map(params![board_id], column_from_row)
        .map_err(error::from_sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error::from_sqlite)
}

fn list_all_columns(conn: &Connection) -> Result<Vec<Column>, RpcError> {
    let mut stmt = conn
        .prepare(&format!("{COLUMN_SELECT} ORDER BY board_id, position"))
        .map_err(error::from_sqlite)?;
    stmt.query_map([], column_from_row)
        .map_err(error::from_sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error::from_sqlite)
}

fn get_column(conn: &Connection, id: &str) -> Result<Column, RpcError> {
    conn.query_row(
        // A name resolves on My work first: imported boards reuse names.
        &format!(
            "{COLUMN_SELECT} WHERE id = ?1 OR lower(name) = lower(?1)
             ORDER BY id = ?1 DESC, board_id IS NULL DESC LIMIT 1"
        ),
        params![id],
        column_from_row,
    )
    .optional()
    .map_err(error::from_sqlite)?
    .ok_or_else(|| error::not_found(format!("work column {id} not found")))
}

fn list_tickets(conn: &Connection, column_id: Option<&str>) -> Result<Vec<Ticket>, RpcError> {
    let (sql, args): (String, Vec<String>) = match column_id {
        Some(id) => (
            format!("{TICKET_SELECT} WHERE column_id = ?1 ORDER BY position, created_at"),
            vec![id.to_string()],
        ),
        None => (
            format!("{TICKET_SELECT} ORDER BY position, created_at"),
            vec![],
        ),
    };
    let mut stmt = conn.prepare(&sql).map_err(error::from_sqlite)?;
    stmt.query_map(rusqlite::params_from_iter(args.iter()), ticket_from_row)
        .map_err(error::from_sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error::from_sqlite)
}

/// Resolves a ticket by id, by Drogon key (`DRG-41`) or by provider key
/// (`APP-128`), keys case-insensitive. A provider key imported on two
/// boards is ambiguous: pass the Drogon key or id then.
fn get_ticket(conn: &Connection, id: &str) -> Result<Ticket, RpcError> {
    if let Some(found) = conn
        .query_row(
            &format!("{TICKET_SELECT} WHERE id = ?1 OR upper(key) = upper(?1) LIMIT 1"),
            params![id],
            ticket_from_row,
        )
        .optional()
        .map_err(error::from_sqlite)?
    {
        return Ok(found);
    }
    let mut stmt = conn
        .prepare(&format!("{TICKET_SELECT} WHERE upper(ext_key) = upper(?1)"))
        .map_err(error::from_sqlite)?;
    let mut found = stmt
        .query_map(params![id], ticket_from_row)
        .map_err(error::from_sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error::from_sqlite)?;
    match found.len() {
        0 => Err(error::not_found(format!("ticket {id} not found"))),
        1 => Ok(found.remove(0)),
        _ => Err(error::invalid_argument(format!(
            "{id} is on more than one board ({}); pass its board key",
            found
                .iter()
                .map(|t| t.key.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

fn linked_session_ids(conn: &Connection, ticket_id: &str) -> Result<Vec<String>, RpcError> {
    let mut stmt = conn
        .prepare(
            "SELECT session_id FROM work_ticket_sessions WHERE ticket_id = ?1 ORDER BY linked_at, rowid",
        )
        .map_err(error::from_sqlite)?;
    stmt.query_map(params![ticket_id], |r| r.get::<_, String>(0))
        .map_err(error::from_sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error::from_sqlite)
}

fn session_labels(
    conn: &Connection,
    ticket_id: &str,
) -> Result<std::collections::HashMap<String, String>, RpcError> {
    let mut stmt = conn
        .prepare("SELECT session_id, label FROM work_ticket_sessions WHERE ticket_id = ?1 AND label IS NOT NULL")
        .map_err(error::from_sqlite)?;
    stmt.query_map(params![ticket_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(error::from_sqlite)?
        .collect::<Result<_, _>>()
        .map_err(error::from_sqlite)
}

fn link_session_in(conn: &Connection, ticket_id: &str, session_id: &str) -> Result<(), RpcError> {
    conn.execute(
        "INSERT OR IGNORE INTO work_ticket_sessions (ticket_id, session_id, linked_at) VALUES (?1, ?2, ?3)",
        params![ticket_id, session_id, crate::now_unix_ms() as i64],
    )
    .map_err(error::from_sqlite)?;
    Ok(())
}

/// A resumed session replaces the prior one on every ticket that linked it,
/// keeping the prior link's place in the ticket's order. Best-effort callers
/// (the resume boundary) ignore the error; nothing else depends on it.
pub(crate) fn relink_resumed_session(
    conn: &Connection,
    prior_session_id: &str,
    replacement_session_id: &str,
) -> rusqlite::Result<usize> {
    if prior_session_id == replacement_session_id {
        return Ok(0);
    }
    conn.execute(
        "INSERT OR IGNORE INTO work_ticket_sessions (ticket_id, session_id, linked_at)
         SELECT ticket_id, ?2, linked_at FROM work_ticket_sessions WHERE session_id = ?1",
        params![prior_session_id, replacement_session_id],
    )?;
    conn.execute(
        "DELETE FROM work_ticket_sessions WHERE session_id = ?1",
        params![prior_session_id],
    )
}

// ---------------------------------------------------------- validation --

fn bounded_text(
    value: &str,
    field: &str,
    max: usize,
    allow_empty: bool,
) -> Result<String, RpcError> {
    let trimmed = value.trim();
    if (!allow_empty && trimmed.is_empty()) || value.chars().count() > max || value.contains('\0') {
        return Err(error::invalid_argument(format!(
            "{field} must be {}1..{max} characters without NUL",
            if allow_empty { "0.." } else { "" }
        )));
    }
    Ok(if allow_empty {
        value.to_string()
    } else {
        trimmed.to_string()
    })
}

fn validate_url(value: &str, field: &str) -> Result<String, RpcError> {
    let trimmed = value.trim();
    let parsed = url::Url::parse(trimmed)
        .map_err(|_| error::invalid_argument(format!("{field} must be an http(s) URL")))?;
    if trimmed.len() > MAX_URL
        || !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(error::invalid_argument(format!(
            "{field} must be an http(s) URL"
        )));
    }
    Ok(trimmed.to_string())
}

/// `https://github.com/o/r/pull/648`, `#648` or `648` → (url, number).
fn parse_pr(value: &str) -> Result<(Option<String>, Option<i64>), RpcError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok((None, None));
    }
    let bare = trimmed.trim_start_matches('#');
    if let Ok(number) = bare.parse::<i64>()
        && number > 0
    {
        return Ok((None, Some(number)));
    }
    let url = validate_url(trimmed, "pr")?;
    let number = url::Url::parse(&url)
        .ok()
        .and_then(|parsed| {
            let segments: Vec<String> = parsed.path_segments()?.map(str::to_owned).collect();
            let at = segments
                .iter()
                .position(|s| s == "pull" || s == "pulls" || s == "merge_requests")?;
            segments.get(at + 1)?.parse::<i64>().ok()
        })
        .filter(|n| *n > 0);
    Ok((Some(url), number))
}

fn validate_icon(value: &str) -> Result<String, RpcError> {
    if ICONS.contains(&value) {
        Ok(value.to_string())
    } else {
        Err(error::invalid_argument(format!(
            "icon must be one of: {}",
            ICONS.join(", ")
        )))
    }
}

fn validate_recipients(value: &str) -> Result<String, RpcError> {
    match value {
        "all" | "primary" => Ok(value.to_string()),
        _ => Err(error::invalid_argument(
            "recipients must be \"all\" or \"primary\"",
        )),
    }
}

fn validate_harness(value: &str) -> Result<String, RpcError> {
    match value {
        "claude" | "codex" | "opencode" | "pi" | "antigravity" => Ok(value.to_string()),
        _ => Err(error::invalid_argument(
            "harnessId must be one of: claude, codex, opencode, pi, antigravity",
        )),
    }
}

/// `*/15 * * * *` as-is, or a shorthand interval (`15m`, `2h`, `1d`).
pub(crate) fn normalize_schedule(value: &str) -> Result<String, RpcError> {
    let trimmed = value.trim();
    let interval = |suffix: char| -> Option<i64> {
        trimmed
            .strip_suffix(suffix)?
            .parse::<i64>()
            .ok()
            .filter(|n| *n > 0)
    };
    let cron = if let Some(minutes) = interval('m') {
        if minutes >= 60 {
            return Err(error::invalid_argument(
                "minute intervals must be 1..59 (use hours, e.g. 2h, for longer)",
            ));
        }
        format!("*/{minutes} * * * *")
    } else if let Some(hours) = interval('h') {
        if hours >= 24 {
            return Err(error::invalid_argument(
                "hour intervals must be 1..23 (use 1d)",
            ));
        }
        format!("0 */{hours} * * *")
    } else if interval('d') == Some(1) {
        "0 0 * * *".to_string()
    } else {
        trimmed.to_string()
    };
    crate::cron::validate_cron(&cron).map_err(error::invalid_argument)
}

/// Ticket key prefix from a project name: the first letter, then the next
/// consonants (`Drogon` → `DRG`), falling back to `WRK` without a project.
fn key_prefix(project_name: Option<&str>) -> String {
    let Some(name) = project_name else {
        return "WRK".to_string();
    };
    let letters: Vec<char> = name
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let Some(first) = letters.first() else {
        return "WRK".to_string();
    };
    let mut prefix = first.to_string();
    for c in letters.iter().skip(1) {
        if prefix.len() >= 3 {
            break;
        }
        if !"AEIOU".contains(*c) {
            prefix.push(*c);
        }
    }
    for c in letters.iter().skip(1) {
        if prefix.len() >= 2 {
            break;
        }
        prefix.push(*c);
    }
    prefix
}

fn next_key(conn: &Connection, prefix: &str) -> Result<String, RpcError> {
    let next: i64 = conn
        .query_row(
            "SELECT next FROM work_key_counters WHERE prefix = ?1",
            params![prefix],
            |r| r.get(0),
        )
        .optional()
        .map_err(error::from_sqlite)?
        .unwrap_or(1);
    conn.execute(
        "INSERT INTO work_key_counters (prefix, next) VALUES (?1, ?2)
         ON CONFLICT(prefix) DO UPDATE SET next = excluded.next",
        params![prefix, next + 1],
    )
    .map_err(error::from_sqlite)?;
    Ok(format!("{prefix}-{next}"))
}

fn project_name(conn: &Connection, project_id: &str) -> Result<String, RpcError> {
    conn.query_row(
        "SELECT name FROM projects WHERE id = ?1",
        params![project_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(error::from_sqlite)?
    .ok_or_else(|| error::not_found(format!("project {project_id} not found")))
}

/// A project by id, or by its name (case-insensitive) when unambiguous.
fn resolve_project(conn: &Connection, value: &str) -> Result<String, RpcError> {
    let mut stmt = conn
        .prepare("SELECT id FROM projects WHERE id = ?1 OR lower(name) = lower(?1) ORDER BY id = ?1 DESC")
        .map_err(error::from_sqlite)?;
    let ids = stmt
        .query_map(params![value], |r| r.get::<_, String>(0))
        .map_err(error::from_sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error::from_sqlite)?;
    match ids.as_slice() {
        [] => Err(error::not_found(format!("project {value} not found"))),
        [only] => Ok(only.clone()),
        [first, ..] if first == value => Ok(first.clone()),
        _ => Err(error::invalid_argument(format!(
            "more than one project is named {value}; pass its id"
        ))),
    }
}

fn require_workspace(conn: &Connection, workspace_id: &str) -> Result<(), RpcError> {
    let found: Option<String> = conn
        .query_row(
            "SELECT id FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(error::from_sqlite)?;
    found
        .map(|_| ())
        .ok_or_else(|| error::not_found(format!("workspace {workspace_id} not found")))
}

/// Renumbers a column's tickets 0..n with `moving` inserted at `index`.
fn place_ticket(
    conn: &Connection,
    column_id: &str,
    moving: &str,
    index: Option<usize>,
) -> Result<(), RpcError> {
    let mut order: Vec<String> = list_tickets(conn, Some(column_id))?
        .into_iter()
        .map(|t| t.id)
        .filter(|id| id != moving)
        .collect();
    let at = index.unwrap_or(order.len()).min(order.len());
    order.insert(at, moving.to_string());
    for (position, id) in order.iter().enumerate() {
        conn.execute(
            "UPDATE work_tickets SET position = ?2 WHERE id = ?1",
            params![id, position as i64],
        )
        .map_err(error::from_sqlite)?;
    }
    Ok(())
}

// -------------------------------------------------------------- params --

fn str_field<'a>(params: &'a Value, field: &str) -> Result<Option<&'a str>, RpcError> {
    match params.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(_) => Err(error::invalid_argument(format!("{field} must be a string"))),
    }
}

fn required(params: &Value, field: &str) -> Result<String, RpcError> {
    str_field(params, field)?
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| error::invalid_argument(format!("{field} is required")))
}

fn bool_field(params: &Value, field: &str) -> Result<Option<bool>, RpcError> {
    match params.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(error::invalid_argument(format!(
            "{field} must be a boolean"
        ))),
    }
}

fn index_field(params: &Value, field: &str) -> Result<Option<usize>, RpcError> {
    match params.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_u64().map(|n| Some(n as usize)).ok_or_else(|| {
            error::invalid_argument(format!("{field} must be a non-negative integer"))
        }),
    }
}

/// `field` present as `null` or `""` clears it; absent leaves it alone.
fn clearable(params: &Value, field: &str) -> Result<Option<Option<String>>, RpcError> {
    match params.get(field) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(Some(None)),
        Some(Value::String(s)) => Ok(Some(Some(s.clone()))),
        Some(_) => Err(error::invalid_argument(format!(
            "{field} must be a string or null"
        ))),
    }
}

fn reject_unknown(params: &Value, allowed: &[&str]) -> Result<(), RpcError> {
    if let Some(object) = params.as_object() {
        if let Some(unknown) = object.keys().find(|k| !allowed.contains(&k.as_str())) {
            return Err(error::invalid_argument(format!("unknown field {unknown}")));
        }
        Ok(())
    } else if params.is_null() {
        Ok(())
    } else {
        Err(error::invalid_argument("expected an object of params"))
    }
}

// ------------------------------------------------------------ messages --

/// The column after `column` on its board (for `{column.next}`), or the
/// column's own name when it is the last one.
fn next_column_name(conn: &Connection, column: &Column) -> String {
    let columns = list_columns(conn, column.board_id.as_deref()).unwrap_or_default();
    columns
        .iter()
        .position(|c| c.id == column.id)
        .and_then(|i| columns.get(i + 1))
        .map(|c| c.name.clone())
        .unwrap_or_else(|| column.name.clone())
}

/// `{ticket.id}` style placeholders. Unknown placeholders are left as typed.
fn render_message(
    template: &str,
    ticket: &Ticket,
    column: Option<&Column>,
    project: Option<&str>,
) -> String {
    let pr = match (&ticket.pr_url, ticket.pr_number) {
        (Some(url), _) => url.clone(),
        (None, Some(n)) => format!("PR #{n}"),
        (None, None) => "(no pull request)".to_string(),
    };
    // An imported ticket goes by its provider key (APP-128); the Drogon key
    // stays reachable as {ticket.drogon_key}.
    let key = ticket.ext.key.clone().unwrap_or_else(|| ticket.key.clone());
    let pairs = [
        ("{ticket.id}", key.clone()),
        ("{ticket.key}", key),
        ("{ticket.drogon_key}", ticket.key.clone()),
        (
            "{ticket.status}",
            ticket
                .ext
                .status_name
                .clone()
                .unwrap_or_else(|| column.map(|c| c.name.clone()).unwrap_or_default()),
        ),
        ("{ticket.title}", ticket.title.clone()),
        ("{ticket.description}", ticket.description.clone()),
        ("{ticket.pr}", pr),
        (
            "{ticket.pr_number}",
            ticket.pr_number.map(|n| n.to_string()).unwrap_or_default(),
        ),
        (
            "{ticket.url}",
            ticket.source_url.clone().unwrap_or_default(),
        ),
        (
            "{ticket.source}",
            ticket.source_url.clone().unwrap_or_default(),
        ),
        ("{ticket.next}", ticket.next_step.clone()),
        ("{ticket.project}", project.unwrap_or("").to_string()),
        (
            "{ticket.column}",
            column.map(|c| c.name.clone()).unwrap_or_default(),
        ),
        (
            "{column.name}",
            column.map(|c| c.name.clone()).unwrap_or_default(),
        ),
    ];
    let mut out = template.replace("\r\n", "\n").replace('\r', "\n");
    for (placeholder, value) in pairs {
        out = out.replace(placeholder, &value);
    }
    out.trim_end().to_string()
}

// ---------------------------------------------------------------- JSON --

fn column_json(conn: &Connection, column: &Column) -> Result<Value, RpcError> {
    let ticket_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM work_tickets WHERE column_id = ?1",
            params![column.id],
            |r| r.get(0),
        )
        .map_err(error::from_sqlite)?;
    let last: Option<(i64, String)> = conn
        .query_row(
            "SELECT at, results FROM work_sends WHERE column_id = ?1 ORDER BY at DESC, id DESC LIMIT 1",
            params![column.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(error::from_sqlite)?;
    let (last_sent_at, last_sent_count) = match last {
        Some((latest_at, _)) => {
            // Sessions reached by the most recent send (all tickets that
            // went out in the same second belong to one fan-out).
            let mut stmt = conn
                .prepare("SELECT results FROM work_sends WHERE column_id = ?1 AND at >= ?2")
                .map_err(error::from_sqlite)?;
            let rows = stmt
                .query_map(params![column.id, latest_at - 1000], |r| {
                    r.get::<_, String>(0)
                })
                .map_err(error::from_sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(error::from_sqlite)?;
            let delivered = rows
                .iter()
                .filter_map(|raw| serde_json::from_str::<Vec<Value>>(raw).ok())
                .flatten()
                .filter(|r| r["action"] != "failed" && r["action"] != "skipped")
                .count();
            (Some(latest_at), delivered as i64)
        }
        None => (None, 0),
    };
    Ok(json!({
        "id": column.id,
        "name": column.name,
        "icon": column.icon,
        "position": column.position,
        "sendOnEnter": column.send_on_enter,
        "cron": column.cron,
        "prWatch": column.pr_watch,
        "message": column.message,
        "recipients": column.recipients,
        "harnessId": column.harness_id,
        "nextRunAt": column.next_run_at,
        "boardId": column.board_id,
        "statuses": column.statuses,
        "collapsed": column.collapsed,
        "ticketCount": ticket_count,
        "lastSentAt": last_sent_at,
        "lastSentCount": last_sent_count,
    }))
}

impl Engine {
    /// The linked sessions of a ticket as `session.list` rows (live handles
    /// overlaid), plus a `{id, missing: true}` row for a link whose session
    /// record is gone.
    fn work_session_rows(&self, ids: &[String]) -> Result<Vec<Value>, RpcError> {
        self.session_rows(ids)
    }

    fn ticket_json(&self, ticket: &Ticket) -> Result<Value, RpcError> {
        self.ticket_json_with(ticket, true)
    }

    /// A ticket as JSON. The board lists every ticket at once, so it carries
    /// a description excerpt (`descriptionTruncated`); one ticket carries
    /// all of it.
    fn ticket_json_with(&self, ticket: &Ticket, full: bool) -> Result<Value, RpcError> {
        let (ids, labels, project, ext) = {
            let conn = self.db.lock().unwrap();
            let ids = linked_session_ids(&conn, &ticket.id)?;
            let labels = session_labels(&conn, &ticket.id)?;
            let project = match &ticket.project_id {
                Some(id) => project_name(&conn, id).ok(),
                None => None,
            };
            (ids, labels, project, sync::ticket_ext_json(&conn, ticket)?)
        };
        let (description, truncated) = if full {
            (ticket.description.clone(), false)
        } else {
            excerpt(&ticket.description, BOARD_DESCRIPTION_CHARS)
        };
        let mut sessions = self.work_session_rows(&ids)?;
        for row in &mut sessions {
            if let Some(label) = row["id"].as_str().and_then(|id| labels.get(id)) {
                row["label"] = json!(label);
            }
        }
        let mut value = json!({
            "id": ticket.id,
            "key": ticket.key,
            "title": ticket.title,
            "description": description,
            "descriptionTruncated": truncated,
            "projectId": ticket.project_id,
            "projectName": project,
            "workspaceId": ticket.workspace_id,
            "columnId": ticket.column_id,
            "position": ticket.position,
            "prUrl": ticket.pr_url,
            "prNumber": ticket.pr_number,
            "sourceUrl": ticket.source_url,
            "nextStep": ticket.next_step,
            "createdAt": ticket.created_at,
            "updatedAt": ticket.updated_at,
            "sessions": sessions,
        });
        if let (Some(target), Value::Object(mut extra)) = (value.as_object_mut(), ext) {
            // The sprint timeline is the panel's (one ticket at a time).
            if !full {
                extra.remove("sprints");
            }
            target.extend(extra);
        }
        Ok(value)
    }

    // --------------------------------------------------------- reads --

    /// `work.board`: one board's columns and tickets. Without `boardId`
    /// it is My work; an imported scrum board shows one sprint (`sprintId`,
    /// default the active one) or `backlog`.
    pub(crate) fn work_board(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["projectId", "boardId", "sprintId"])?;
        let (columns, tickets, projects, board, boards, view) = {
            let conn = self.db.lock().unwrap();
            let project_filter = str_field(params, "projectId")?
                .map(|p| resolve_project(&conn, p))
                .transpose()?;
            let board_id = sync::resolve_board_param(&conn, str_field(params, "boardId")?)?;
            let columns = list_columns(&conn, board_id.as_deref())?
                .iter()
                .map(|c| column_json(&conn, c))
                .collect::<Result<Vec<_>, _>>()?;
            let (scoped, board, view) = match &board_id {
                None => (
                    list_tickets(&conn, None)?
                        .into_iter()
                        .filter(|t| t.ext.board_id.is_none())
                        .collect::<Vec<_>>(),
                    sync::local_board_json(&conn)?,
                    json!({ "kind": "all", "readOnly": false, "promptsPaused": false, "sprints": [] }),
                ),
                Some(id) => {
                    let board = sync::get_board(&conn, id)?;
                    let view = sync::board_view(&conn, &board, str_field(params, "sprintId")?)?;
                    (view.tickets, sync::board_json(&conn, &board)?, view.view)
                }
            };
            let boards = sync::boards_json(&conn)?;
            let tickets: Vec<Ticket> = scoped
                .into_iter()
                .filter(|t| {
                    project_filter
                        .as_deref()
                        .is_none_or(|p| t.project_id.as_deref() == Some(p))
                })
                .collect();
            let mut stmt = conn
                .prepare("SELECT id, name, kind FROM projects ORDER BY name COLLATE NOCASE")
                .map_err(error::from_sqlite)?;
            let projects = stmt
                .query_map([], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "name": r.get::<_, String>(1)?,
                        "kind": r.get::<_, String>(2)?,
                    }))
                })
                .map_err(error::from_sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(error::from_sqlite)?;
            (columns, tickets, projects, board, boards, view)
        };
        let tickets = tickets
            .iter()
            .map(|t| self.ticket_json_with(t, false))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({
            "columns": columns,
            "tickets": tickets,
            "projects": projects,
            "board": board,
            "boards": boards,
            "view": view,
        }))
    }

    pub(crate) fn work_ticket_show(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["ticketId"])?;
        let id = required(params, "ticketId")?;
        let ticket = {
            let conn = self.db.lock().unwrap();
            get_ticket(&conn, &id)?
        };
        let mut value = self.ticket_json(&ticket)?;
        let sends = self.work_sends(&json!({ "ticketId": ticket.id, "limit": 20 }))?;
        value["sends"] = sends["sends"].clone();
        let conn = self.db.lock().unwrap();
        value["activity"] = json!(sync::activity_json(&conn, &ticket.id)?);
        Ok(value)
    }

    pub(crate) fn work_sends(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["ticketId", "columnId", "limit"])?;
        let limit = params
            .get("limit")
            .and_then(Value::as_i64)
            .unwrap_or(50)
            .clamp(1, MAX_SENDS_PAGE);
        let conn = self.db.lock().unwrap();
        let (filter, arg) = if let Some(t) = str_field(params, "ticketId")? {
            ("ticket_id = ?1", get_ticket(&conn, t)?.id)
        } else if let Some(c) = str_field(params, "columnId")? {
            ("column_id = ?1", get_column(&conn, c)?.id)
        } else {
            ("?1 = ?1", String::new())
        };
        let mut stmt = conn
            .prepare(&format!(
                "SELECT s.id, s.column_id, s.ticket_id, t.key, s.trigger, s.message, s.results, s.at
                 FROM work_sends s LEFT JOIN work_tickets t ON t.id = s.ticket_id
                 WHERE s.{filter} ORDER BY s.at DESC, s.id DESC LIMIT {limit}"
            ))
            .map_err(error::from_sqlite)?;
        let sends = stmt
            .query_map(params![arg], |r| {
                let results: String = r.get(6)?;
                Ok(json!({
                    "id": r.get::<_, i64>(0)?,
                    "columnId": r.get::<_, Option<String>>(1)?,
                    "ticketId": r.get::<_, String>(2)?,
                    "ticketKey": r.get::<_, Option<String>>(3)?,
                    "trigger": r.get::<_, String>(4)?,
                    "message": r.get::<_, String>(5)?,
                    "results": serde_json::from_str::<Value>(&results).unwrap_or(json!([])),
                    "at": r.get::<_, i64>(7)?,
                }))
            })
            .map_err(error::from_sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error::from_sqlite)?;
        Ok(json!({ "sends": sends }))
    }

    // ------------------------------------------------------- columns --

    pub(crate) fn do_work_column_create(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["name", "icon", "index", "boardId"])?;
        let name = bounded_text(&required(params, "name")?, "name", MAX_NAME, false)?;
        let icon = validate_icon(str_field(params, "icon")?.unwrap_or("todo"))?;
        let index = index_field(params, "index")?;
        let conn = self.db.lock().unwrap();
        let board_id = sync::resolve_board_param(&conn, str_field(params, "boardId")?)?;
        let existing = list_columns(&conn, board_id.as_deref())?;
        if existing.iter().any(|c| c.name.eq_ignore_ascii_case(&name)) {
            return Err(error::invalid_argument(format!(
                "a column named {name} already exists"
            )));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = crate::now_unix_ms() as i64;
        conn.execute(
            "INSERT INTO work_columns (id, name, icon, position, board_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, name, icon, existing.len() as i64, board_id, now],
        )
        .map_err(error::from_sqlite)?;
        reorder_columns(&conn, &id, index)?;
        column_json(&conn, &get_column(&conn, &id)?)
    }

    pub(crate) fn do_work_column_update(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(
            params,
            &[
                "columnId",
                "name",
                "icon",
                "index",
                "sendOnEnter",
                "cron",
                "prWatch",
                "message",
                "recipients",
                "harnessId",
                "statusIds",
                "collapsed",
            ],
        )?;
        let status_ids: Option<Vec<String>> = match params.get("statusIds") {
            None | Some(Value::Null) => None,
            Some(Value::Array(items)) => Some(
                items
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| error::invalid_argument("statusIds must be strings"))
                    })
                    .collect::<Result<_, _>>()?,
            ),
            Some(_) => return Err(error::invalid_argument("statusIds must be an array")),
        };
        let conn = self.db.lock().unwrap();
        let mut column = get_column(&conn, &required(params, "columnId")?)?;
        if let Some(name) = str_field(params, "name")? {
            let name = bounded_text(name, "name", MAX_NAME, false)?;
            if list_columns(&conn, column.board_id.as_deref())?
                .iter()
                .any(|c| c.id != column.id && c.name.eq_ignore_ascii_case(&name))
            {
                return Err(error::invalid_argument(format!(
                    "a column named {name} already exists"
                )));
            }
            column.name = name;
        }
        if let Some(icon) = str_field(params, "icon")? {
            column.icon = validate_icon(icon)?;
        }
        if let Some(on) = bool_field(params, "sendOnEnter")? {
            column.send_on_enter = on;
        }
        if let Some(on) = bool_field(params, "prWatch")? {
            column.pr_watch = on;
        }
        if let Some(message) = str_field(params, "message")? {
            column.message = bounded_text(message, "message", MAX_MESSAGE, true)?;
        }
        if let Some(recipients) = str_field(params, "recipients")? {
            column.recipients = validate_recipients(recipients)?;
        }
        if let Some(harness) = clearable(params, "harnessId")? {
            column.harness_id = harness.as_deref().map(validate_harness).transpose()?;
        }
        if let Some(collapsed) = bool_field(params, "collapsed")? {
            column.collapsed = collapsed;
        }
        if let Some(cron) = clearable(params, "cron")? {
            match cron {
                Some(raw) => {
                    let normalized = normalize_schedule(&raw)?;
                    column.next_run_at =
                        crate::cron::next_fire_ms(&normalized, crate::now_unix_ms() as f64);
                    column.cron = Some(normalized);
                }
                None => {
                    column.cron = None;
                    column.next_run_at = None;
                }
            }
        }
        conn.execute(
            "UPDATE work_columns SET name = ?2, icon = ?3, send_on_enter = ?4, cron = ?5, pr_watch = ?6,
             message = ?7, recipients = ?8, harness_id = ?9, next_run_at = ?10, updated_at = ?11,
             collapsed = ?12 WHERE id = ?1",
            params![
                column.id,
                column.name,
                column.icon,
                column.send_on_enter as i64,
                column.cron,
                column.pr_watch as i64,
                column.message,
                column.recipients,
                column.harness_id,
                column.next_run_at,
                crate::now_unix_ms() as i64,
                column.collapsed as i64,
            ],
        )
        .map_err(error::from_sqlite)?;
        if let Some(index) = index_field(params, "index")? {
            reorder_columns(&conn, &column.id, Some(index))?;
        }
        let adopted = match status_ids {
            Some(ids) => sync::map_column_statuses(&conn, &column, &ids)?,
            None => Vec::new(),
        };
        let value = column_json(&conn, &get_column(&conn, &column.id)?)?;
        drop(conn);
        // Cards whose provider status just got a home move there (by the
        // provider), and the column's on-enter prompt reaches them.
        for ticket_id in adopted {
            let _ = self.deliver_on_enter(&ticket_id);
        }
        Ok(value)
    }

    pub(crate) fn do_work_column_delete(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["columnId", "moveTicketsTo"])?;
        let conn = self.db.lock().unwrap();
        let column = get_column(&conn, &required(params, "columnId")?)?;
        let tickets = list_tickets(&conn, Some(&column.id))?;
        let target = match str_field(params, "moveTicketsTo")? {
            Some(t) => Some(get_column(&conn, t)?),
            None => None,
        };
        if let Some(target) = &target
            && (target.id == column.id || target.board_id != column.board_id)
        {
            return Err(error::invalid_argument(
                "moveTicketsTo must be another column of the same board",
            ));
        }
        if !tickets.is_empty() && target.is_none() {
            return Err(error::invalid_argument(format!(
                "column {} still holds {} ticket(s); pass moveTicketsTo",
                column.name,
                tickets.len()
            )));
        }
        if list_columns(&conn, column.board_id.as_deref())?.len() <= 1 {
            return Err(error::invalid_argument(
                "the board needs at least one column",
            ));
        }
        if let Some(target) = &target {
            for ticket in &tickets {
                conn.execute(
                    "UPDATE work_tickets SET column_id = ?2, updated_at = ?3 WHERE id = ?1",
                    params![ticket.id, target.id, crate::now_unix_ms() as i64],
                )
                .map_err(error::from_sqlite)?;
                place_ticket(&conn, &target.id, &ticket.id, None)?;
            }
        }
        conn.execute("DELETE FROM work_columns WHERE id = ?1", params![column.id])
            .map_err(error::from_sqlite)?;
        let remaining = list_columns(&conn, column.board_id.as_deref())?;
        for (position, c) in remaining.iter().enumerate() {
            conn.execute(
                "UPDATE work_columns SET position = ?2 WHERE id = ?1",
                params![c.id, position as i64],
            )
            .map_err(error::from_sqlite)?;
        }
        Ok(json!({ "deleted": column.id, "movedTickets": tickets.len() }))
    }

    // ------------------------------------------------------- tickets --

    pub(crate) fn do_work_ticket_create(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(
            params,
            &[
                "title",
                "description",
                "projectId",
                "workspaceId",
                "columnId",
                "prUrl",
                "sourceUrl",
                "nextStep",
                "sessionIds",
                "boardId",
                "assignToMe",
                "issueType",
                "repo",
                "sprintId",
            ],
        )?;
        // On an imported board the ticket is a new issue in its source.
        let on_board = {
            let conn = self.db.lock().unwrap();
            let board = sync::resolve_board_param(&conn, str_field(params, "boardId")?)?;
            match (board, str_field(params, "columnId")?) {
                (Some(board), column) => Some((board, column.map(str::to_owned))),
                (None, Some(column)) => get_column(&conn, column)?
                    .board_id
                    .map(|board| (board, Some(column.to_string()))),
                (None, None) => None,
            }
        };
        if let Some((board, column)) = on_board {
            return self.create_ticket_on_board(&board, column.as_deref(), params);
        }
        for field in ["assignToMe", "issueType", "repo", "sprintId"] {
            if params.get(field).is_some() {
                return Err(error::invalid_argument(format!(
                    "{field} is for a ticket created on an imported board"
                )));
            }
        }
        let title = bounded_text(&required(params, "title")?, "title", MAX_TITLE, false)?;
        let description = bounded_text(
            str_field(params, "description")?.unwrap_or(""),
            "description",
            MAX_TEXT,
            true,
        )?;
        let next_step = bounded_text(
            str_field(params, "nextStep")?.unwrap_or(""),
            "nextStep",
            MAX_TITLE,
            true,
        )?;
        let (pr_url, pr_number) = parse_pr(str_field(params, "prUrl")?.unwrap_or(""))?;
        let source_url = str_field(params, "sourceUrl")?
            .filter(|s| !s.trim().is_empty())
            .map(|s| validate_url(s, "sourceUrl"))
            .transpose()?;
        let session_ids: Vec<String> = match params.get("sessionIds") {
            None | Some(Value::Null) => vec![],
            Some(Value::Array(items)) => items
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| error::invalid_argument("sessionIds must be strings"))
                })
                .collect::<Result<_, _>>()?,
            Some(_) => return Err(error::invalid_argument("sessionIds must be an array")),
        };
        for session in &session_ids {
            self.ensure_session_row(session)?;
        }
        let ticket_id = {
            let conn = self.db.lock().unwrap();
            let project_id = str_field(params, "projectId")?
                .map(|p| resolve_project(&conn, p))
                .transpose()?;
            let project = match &project_id {
                Some(id) => Some(project_name(&conn, id)?),
                None => None,
            };
            let workspace_id = str_field(params, "workspaceId")?.map(str::to_owned);
            if let Some(ws) = &workspace_id {
                require_workspace(&conn, ws)?;
            }
            let column = match str_field(params, "columnId")? {
                Some(c) => get_column(&conn, c)?,
                None => list_columns(&conn, None)?
                    .into_iter()
                    .next()
                    .ok_or_else(|| error::invalid_argument("the board has no columns"))?,
            };
            for session in &session_ids {
                self.require_session_row(&conn, session)?;
            }
            let key = next_key(&conn, &key_prefix(project.as_deref()))?;
            let id = uuid::Uuid::new_v4().to_string();
            let now = crate::now_unix_ms() as i64;
            conn.execute(
                "INSERT INTO work_tickets (id, key, project_id, workspace_id, column_id, position, title, description,
                  pr_url, pr_number, source_url, next_step, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
                params![
                    id, key, project_id, workspace_id, column.id, i64::MAX, title, description, pr_url, pr_number,
                    source_url, next_step, now
                ],
            )
            .map_err(error::from_sqlite)?;
            place_ticket(&conn, &column.id, &id, None)?;
            for session in &session_ids {
                link_session_in(&conn, &id, session)?;
            }
            id
        };
        let delivery = self.deliver_on_enter(&ticket_id)?;
        let ticket = {
            let conn = self.db.lock().unwrap();
            get_ticket(&conn, &ticket_id)?
        };
        let mut value = self.ticket_json(&ticket)?;
        value["delivery"] = delivery;
        Ok(value)
    }

    pub(crate) fn do_work_ticket_update(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(
            params,
            &[
                "ticketId",
                "title",
                "description",
                "projectId",
                "workspaceId",
                "prUrl",
                "sourceUrl",
                "nextStep",
            ],
        )?;
        let conn = self.db.lock().unwrap();
        let mut ticket = get_ticket(&conn, &required(params, "ticketId")?)?;
        if let Some(board_id) = &ticket.ext.board_id
            && let Some(field) = ["title", "description"]
                .iter()
                .find(|f| params.get(**f).is_some())
        {
            return Err(error::invalid_argument(format!(
                "{field} comes from {} for {}; edit it there and sync",
                sync::provider_label(&sync::get_board(&conn, board_id)?.provider),
                ticket.ext.key.clone().unwrap_or(ticket.key.clone())
            )));
        }
        if let Some(title) = str_field(params, "title")? {
            ticket.title = bounded_text(title, "title", MAX_TITLE, false)?;
        }
        if let Some(description) = str_field(params, "description")? {
            ticket.description = bounded_text(description, "description", MAX_TEXT, true)?;
        }
        if let Some(next) = str_field(params, "nextStep")? {
            ticket.next_step = bounded_text(next, "nextStep", MAX_TITLE, true)?;
        }
        if let Some(project) = clearable(params, "projectId")? {
            ticket.project_id = project.map(|p| resolve_project(&conn, &p)).transpose()?;
        }
        if let Some(workspace) = clearable(params, "workspaceId")? {
            if let Some(id) = &workspace {
                require_workspace(&conn, id)?;
                // A workspace belongs to one project: choosing it moves the
                // ticket there, unless this call also names the project.
                if params.get("projectId").is_none()
                    && let Some(owner) = conn
                        .query_row(
                            "SELECT project_id FROM workspaces WHERE id = ?1",
                            params![id],
                            |r| r.get::<_, Option<String>>(0),
                        )
                        .optional()
                        .map_err(error::from_sqlite)?
                        .flatten()
                {
                    ticket.project_id = Some(owner);
                }
            }
            ticket.workspace_id = workspace;
        }
        if let Some(pr) = clearable(params, "prUrl")? {
            let (url, number) = parse_pr(pr.as_deref().unwrap_or(""))?;
            if number != ticket.pr_number {
                ticket.pr_fingerprint = None;
                ticket.pr_checked_at = None;
            }
            ticket.pr_url = url;
            ticket.pr_number = number;
        }
        if let Some(source) = clearable(params, "sourceUrl")? {
            ticket.source_url = source
                .as_deref()
                .map(|s| validate_url(s, "sourceUrl"))
                .transpose()?;
        }
        conn.execute(
            "UPDATE work_tickets SET title = ?2, description = ?3, next_step = ?4, project_id = ?5, workspace_id = ?6,
             pr_url = ?7, pr_number = ?8, source_url = ?9, pr_fingerprint = ?10, pr_checked_at = ?11, updated_at = ?12
             WHERE id = ?1",
            params![
                ticket.id,
                ticket.title,
                ticket.description,
                ticket.next_step,
                ticket.project_id,
                ticket.workspace_id,
                ticket.pr_url,
                ticket.pr_number,
                ticket.source_url,
                ticket.pr_fingerprint,
                ticket.pr_checked_at,
                crate::now_unix_ms() as i64,
            ],
        )
        .map_err(error::from_sqlite)?;
        let ticket = get_ticket(&conn, &ticket.id)?;
        drop(conn);
        self.ticket_json(&ticket)
    }

    /// Moves a ticket between columns (or within one). On an imported board
    /// a move into a mapped column is Drogon-only until pushed: the ticket
    /// records the status it asks for (`pendingStatus`), or clears it when
    /// the column already holds the provider's status.
    pub(crate) fn do_work_ticket_move(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["ticketId", "columnId", "index", "sprintId"])?;
        let (ticket_id, entered) = {
            let conn = self.db.lock().unwrap();
            let ticket = get_ticket(&conn, &required(params, "ticketId")?)?;
            let column = get_column_on(
                &conn,
                &required(params, "columnId")?,
                ticket.ext.board_id.as_deref(),
            )?;
            if column.board_id != ticket.ext.board_id {
                return Err(error::invalid_argument(format!(
                    "{} belongs to another board; tickets move within their board",
                    column.name
                )));
            }
            if let Some(board_id) = &ticket.ext.board_id {
                sync::check_movable(&conn, board_id, &ticket, str_field(params, "sprintId")?)?;
            }
            let entered = ticket.column_id != column.id;
            if entered && ticket.ext.board_id.is_some() {
                sync::record_local_move(&conn, &ticket, &column)?;
            }
            if entered {
                conn.execute(
                    "UPDATE work_tickets SET column_id = ?2, updated_at = ?3 WHERE id = ?1",
                    params![ticket.id, column.id, crate::now_unix_ms() as i64],
                )
                .map_err(error::from_sqlite)?;
            }
            place_ticket(&conn, &column.id, &ticket.id, index_field(params, "index")?)?;
            if entered {
                // Close the gap in the column the ticket left.
                let left: Vec<String> = list_tickets(&conn, Some(&ticket.column_id))?
                    .into_iter()
                    .map(|t| t.id)
                    .collect();
                for (position, id) in left.iter().enumerate() {
                    conn.execute(
                        "UPDATE work_tickets SET position = ?2 WHERE id = ?1",
                        params![id, position as i64],
                    )
                    .map_err(error::from_sqlite)?;
                }
            }
            (ticket.id, entered)
        };
        let delivery = if entered {
            self.deliver_on_enter(&ticket_id)?
        } else {
            Value::Null
        };
        let ticket = {
            let conn = self.db.lock().unwrap();
            get_ticket(&conn, &ticket_id)?
        };
        let mut value = self.ticket_json(&ticket)?;
        value["delivery"] = delivery;
        Ok(value)
    }

    pub(crate) fn do_work_ticket_delete(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["ticketId"])?;
        let conn = self.db.lock().unwrap();
        let ticket = get_ticket(&conn, &required(params, "ticketId")?)?;
        for table in [
            "work_ticket_sessions",
            "work_ticket_sprints",
            "work_activity",
        ] {
            conn.execute(
                &format!("DELETE FROM {table} WHERE ticket_id = ?1"),
                params![ticket.id],
            )
            .map_err(error::from_sqlite)?;
        }
        conn.execute("DELETE FROM work_tickets WHERE id = ?1", params![ticket.id])
            .map_err(error::from_sqlite)?;
        let remaining: Vec<String> = list_tickets(&conn, Some(&ticket.column_id))?
            .into_iter()
            .map(|t| t.id)
            .collect();
        for (position, id) in remaining.iter().enumerate() {
            conn.execute(
                "UPDATE work_tickets SET position = ?2 WHERE id = ?1",
                params![id, position as i64],
            )
            .map_err(error::from_sqlite)?;
        }
        Ok(json!({ "deleted": ticket.id, "key": ticket.key }))
    }

    fn require_session_row(&self, conn: &Connection, session_id: &str) -> Result<(), RpcError> {
        if crate::sessions::get_row(conn, session_id)?.is_some() {
            Ok(())
        } else {
            Err(error::not_found(format!("session {session_id} not found")))
        }
    }

    pub(crate) fn do_work_ticket_link_session(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["ticketId", "sessionId"])?;
        self.ensure_session_row(&required(params, "sessionId")?)?;
        let ticket = {
            let conn = self.db.lock().unwrap();
            let ticket = get_ticket(&conn, &required(params, "ticketId")?)?;
            let session = required(params, "sessionId")?;
            self.require_session_row(&conn, &session)?;
            link_session_in(&conn, &ticket.id, &session)?;
            // A ticket without a workspace adopts the first linked session's.
            if ticket.workspace_id.is_none() {
                let workspace: Option<String> = conn
                    .query_row(
                        "SELECT workspace_id FROM sessions WHERE id = ?1",
                        params![session],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(error::from_sqlite)?;
                conn.execute(
                    "UPDATE work_tickets SET workspace_id = ?2 WHERE id = ?1",
                    params![ticket.id, workspace],
                )
                .map_err(error::from_sqlite)?;
            }
            conn.execute(
                "UPDATE work_tickets SET updated_at = ?2 WHERE id = ?1",
                params![ticket.id, crate::now_unix_ms() as i64],
            )
            .map_err(error::from_sqlite)?;
            get_ticket(&conn, &ticket.id)?
        };
        self.ticket_json(&ticket)
    }

    pub(crate) fn do_work_ticket_unlink_session(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["ticketId", "sessionId"])?;
        let ticket = {
            let conn = self.db.lock().unwrap();
            let ticket = get_ticket(&conn, &required(params, "ticketId")?)?;
            let removed = conn
                .execute(
                    "DELETE FROM work_ticket_sessions WHERE ticket_id = ?1 AND session_id = ?2",
                    params![ticket.id, required(params, "sessionId")?],
                )
                .map_err(error::from_sqlite)?;
            if removed == 0 {
                return Err(error::not_found(
                    "that session is not linked to this ticket",
                ));
            }
            ticket
        };
        self.ticket_json(&ticket)
    }

    /// Opens a ticket's session for the user: a live one is returned as is;
    /// one that is no longer live is resumed (fresh start when the harness
    /// has nothing to resume) and the replacement is linked in its place.
    pub(crate) fn do_work_session_open(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["ticketId", "sessionId"])?;
        let session_id = required(params, "sessionId")?;
        {
            let conn = self.db.lock().unwrap();
            let ticket = get_ticket(&conn, &required(params, "ticketId")?)?;
            if !linked_session_ids(&conn, &ticket.id)?.contains(&session_id) {
                return Err(error::not_found(
                    "that session is not linked to this ticket",
                ));
            }
        }
        if let Some(live) = self.live_session_snapshot(&session_id) {
            return Ok(json!({ "action": "open", "session": live }));
        }
        let row = self
            .work_session_rows(std::slice::from_ref(&session_id))?
            .into_iter()
            .next()
            .unwrap_or(Value::Null);
        if row["missing"] == true {
            let conn = self.db.lock().unwrap();
            let _ = conn.execute(
                "DELETE FROM work_ticket_sessions WHERE session_id = ?1",
                params![session_id],
            );
            return Err(error::not_found(
                "that session was closed and its record is gone; it has been unlinked from the ticket",
            ));
        }
        let Some(harness) = row["harnessId"].as_str().map(str::to_owned) else {
            // A plain terminal has nothing to resume: the desktop shows its
            // recorded (exited) state with the terminal's own restart.
            return Ok(json!({ "action": "open", "session": row }));
        };
        let workspace = row["workspaceId"].as_str().unwrap_or_default().to_string();
        let launched = self.start_agent(crate::sessions::StartRequest {
            workspace_id: &workspace,
            harness_id: &harness,
            prompt: None,
            resume_of: Some(&session_id),
            title: row["title"].as_str().map(str::to_owned),
        })?;
        Ok(json!({
            "action": if launched["agentResume"] == "fresh" { "started" } else { "resumed" },
            "session": launched,
        }))
    }

    fn live_session_snapshot(&self, session_id: &str) -> Option<Value> {
        self.live_session_json(session_id)
    }

    // ------------------------------------------------------ delivery --

    pub(crate) fn work_column_preview(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["columnId", "ticketId", "message"])?;
        let (column, tickets) = self.send_targets(params)?;
        let template = str_field(params, "message")?
            .map(str::to_owned)
            .unwrap_or_else(|| column.message.clone());
        let next = {
            let conn = self.db.lock().unwrap();
            next_column_name(&conn, &column)
        };
        let mut previews = Vec::new();
        for ticket in &tickets {
            let (project, ids) = {
                let conn = self.db.lock().unwrap();
                let project = ticket
                    .project_id
                    .as_deref()
                    .and_then(|p| project_name(&conn, p).ok());
                (project, linked_session_ids(&conn, &ticket.id)?)
            };
            let ids = select_recipients(&column.recipients, ids);
            let rows = self.work_session_rows(&ids)?;
            let recipients: Vec<Value> = rows
                .iter()
                .map(|row| {
                    let action = if row["verdict"] == "live" {
                        "send"
                    } else if row["harnessId"].is_string() {
                        "resume"
                    } else {
                        "start"
                    };
                    json!({ "sessionId": row["id"], "action": action, "harnessId": row["harnessId"] })
                })
                .collect();
            previews.push(json!({
                "ticketId": ticket.id,
                "ticketKey": ticket.key,
                "message": render_message(&template, ticket, Some(&column), project.as_deref())
                    .replace("{column.next}", &next)
                    .replace("{board.cli}", &self.board_cli_word()),
                "recipients": if recipients.is_empty() {
                    json!([{ "sessionId": null, "action": "start", "harnessId": self.default_harness(&column) }])
                } else {
                    json!(recipients)
                },
            }));
        }
        Ok(json!({ "columnId": column.id, "previews": previews }))
    }

    pub(crate) fn do_work_column_send(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["columnId", "ticketId", "message"])?;
        let (column, tickets) = self.send_targets(params)?;
        let template = str_field(params, "message")?.map(str::to_owned);
        if template
            .as_deref()
            .unwrap_or(&column.message)
            .trim()
            .is_empty()
        {
            return Err(error::invalid_argument(format!(
                "column {} has no message to send",
                column.name
            )));
        }
        let mut sends = Vec::new();
        for ticket in &tickets {
            sends.push(self.deliver(&column, &ticket.id, "manual", template.as_deref())?);
        }
        Ok(json!({ "columnId": column.id, "sends": sends }))
    }

    fn send_targets(&self, params: &Value) -> Result<(Column, Vec<Ticket>), RpcError> {
        let conn = self.db.lock().unwrap();
        let ticket = str_field(params, "ticketId")?
            .map(|t| get_ticket(&conn, t))
            .transpose()?;
        let column = match (str_field(params, "columnId")?, &ticket) {
            (Some(c), _) => get_column(&conn, c)?,
            (None, Some(t)) => get_column(&conn, &t.column_id)?,
            (None, None) => {
                return Err(error::invalid_argument("columnId or ticketId is required"));
            }
        };
        let tickets = match ticket {
            Some(t) => {
                if !sync::prompts_live(&conn, &t)? {
                    return Err(error::invalid_argument(format!(
                        "prompts are paused for {}: it is not in the active sprint",
                        t.ext.key.clone().unwrap_or(t.key.clone())
                    )));
                }
                vec![t]
            }
            None => live_tickets(&conn, &column.id)?,
        };
        Ok((column, tickets))
    }

    fn default_harness(&self, column: &Column) -> String {
        if let Some(h) = &column.harness_id {
            return h.clone();
        }
        self.orca_default_agent()
            .unwrap_or_else(|| "claude".to_string())
    }

    /// The workspace chosen for the ticket (Links → Workspace). One that is
    /// gone fails closed rather than launching in a different checkout.
    fn configured_ticket_workspace(&self, ticket: &Ticket) -> Result<Option<String>, RpcError> {
        let conn = self.db.lock().unwrap();
        if let Some(ws) = &ticket.workspace_id {
            // One recorded under the ticket's previous project (the board
            // moved, or the project was changed) is not where it works now.
            let owner: Option<Option<String>> = conn
                .query_row(
                    "SELECT project_id FROM workspaces WHERE id = ?1",
                    params![ws],
                    |r| r.get(0),
                )
                .optional()
                .map_err(error::from_sqlite)?;
            if let (Some(project), Some(Some(owner))) = (&ticket.project_id, &owner)
                && project != owner
            {
                return Ok(None);
            }
            let active = conn
                .query_row(
                    "SELECT 1 FROM workspaces WHERE id = ?1 AND is_archived = 0",
                    params![ws],
                    |_| Ok(()),
                )
                .optional()
                .map_err(error::from_sqlite)?
                .is_some();
            if active {
                return Ok(Some(ws.clone()));
            }
            // Automatically created ticket worktrees may be recreated after archive.
            let own = conn.query_row(
                "SELECT 1 FROM work_ticket_workspaces WHERE ticket_id = ?1 AND workspace_id = ?2",
                params![ticket.id, ws], |_| Ok(()),
            ).optional().map_err(error::from_sqlite)?.is_some();
            if !own {
                return Err(error::invalid_argument(
                    "The ticket's workspace is unavailable. Choose another workspace in Links.",
                ));
            }
        }
        Ok(None)
    }

    /// The workspace a new session for this ticket starts in: the ticket's
    /// own, else its project's main checkout, else any of its worktrees.
    fn ticket_workspace(&self, ticket: &Ticket) -> Result<Option<String>, RpcError> {
        if let Some(ws) = self.configured_ticket_workspace(ticket)? {
            return Ok(Some(ws));
        }
        let Some(project) = &ticket.project_id else {
            return Ok(None);
        };
        let folder_group = {
            let conn = self.db.lock().unwrap();
            conn.query_row(
                "SELECT kind FROM projects WHERE id = ?1",
                params![project],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(error::from_sqlite)?
            .is_some_and(|k| k == "folder-group")
        };
        if folder_group {
            // No checkout to share: each ticket has its own folder workspace.
            return self.ticket_own_workspace(ticket);
        }
        let conn = self.db.lock().unwrap();
        let worktree = conn
            .query_row(
                "SELECT w.workspace_id FROM worktrees w JOIN projects p ON p.id = w.project_id
                 WHERE w.project_id = ?1 ORDER BY (w.path = p.path) DESC, w.created_at LIMIT 1",
                params![project],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(error::from_sqlite)?;
        if worktree.is_some() {
            return Ok(worktree);
        }
        // A folder project's implicit worktree is the workspace registered
        // at the project's own path.
        conn.query_row(
            "SELECT ws.id FROM workspaces ws JOIN projects p ON p.path = ws.path
             WHERE p.id = ?1 ORDER BY ws.id LIMIT 1",
            params![project],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(error::from_sqlite)
    }

    fn deliver_on_enter(&self, ticket_id: &str) -> Result<Value, RpcError> {
        let (column, live) = {
            let conn = self.db.lock().unwrap();
            let ticket = get_ticket(&conn, ticket_id)?;
            (
                get_column(&conn, &ticket.column_id)?,
                sync::prompts_live(&conn, &ticket)?,
            )
        };
        if !live || !column.send_on_enter || column.message.trim().is_empty() {
            return Ok(Value::Null);
        }
        self.deliver(&column, ticket_id, "enter", None)
    }

    /// Types the column's message into every recipient session of one
    /// ticket, resuming or starting sessions as needed, and records it.
    fn deliver(
        &self,
        column: &Column,
        ticket_id: &str,
        trigger: &str,
        template: Option<&str>,
    ) -> Result<Value, RpcError> {
        let _serial = DELIVERY_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let (ticket, project, ids, next) = {
            let conn = self.db.lock().unwrap();
            let ticket = get_ticket(&conn, ticket_id)?;
            let project = ticket
                .project_id
                .as_deref()
                .and_then(|p| project_name(&conn, p).ok());
            let ids = linked_session_ids(&conn, &ticket.id)?;
            (ticket, project, ids, next_column_name(&conn, column))
        };
        let message = render_message(
            template.unwrap_or(&column.message),
            &ticket,
            Some(column),
            project.as_deref(),
        )
        .replace("{column.next}", &next)
        .replace("{board.cli}", &self.board_cli_word());
        let mut results = Vec::new();
        if message.trim().is_empty() {
            results
                .push(json!({ "sessionId": null, "action": "skipped", "error": "empty message" }));
        } else {
            let recipients = select_recipients(&column.recipients, ids);
            for session_id in &recipients {
                results.push(self.deliver_to_session(&ticket, session_id, &message));
            }
            let delivered = results
                .iter()
                .any(|r| matches!(r["action"].as_str(), Some("sent" | "resumed" | "started")));
            if !delivered {
                results.push(self.start_ticket_session(column, &ticket, &message));
            }
        }
        let at = crate::now_unix_ms() as i64;
        {
            let conn = self.db.lock().unwrap();
            conn.execute(
                "INSERT INTO work_sends (column_id, ticket_id, trigger, message, results, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![column.id, ticket.id, trigger, message, Value::Array(results.clone()).to_string(), at],
            )
            .map_err(error::from_sqlite)?;
        }
        Ok(json!({
            "ticketId": ticket.id,
            "ticketKey": ticket.key,
            "columnId": column.id,
            "trigger": trigger,
            "message": message,
            "results": results,
            "at": at,
        }))
    }

    fn deliver_to_session(&self, ticket: &Ticket, session_id: &str, message: &str) -> Value {
        if self.live_session_json(session_id).is_some() {
            match self.session_send(session_id, message) {
                Ok(()) => return json!({ "sessionId": session_id, "action": "sent" }),
                Err(err) => {
                    // A terminal that closed between the read and the send
                    // falls through to resume below.
                    if self.live_session_json(session_id).is_some() {
                        return json!({ "sessionId": session_id, "action": "failed", "error": err.message });
                    }
                }
            }
        }
        let row = match self.work_session_rows(&[session_id.to_string()]) {
            Ok(rows) => rows.into_iter().next().unwrap_or(Value::Null),
            Err(err) => {
                return json!({ "sessionId": session_id, "action": "failed", "error": err.message });
            }
        };
        if row["missing"] == true {
            let conn = self.db.lock().unwrap();
            let _ = conn.execute(
                "DELETE FROM work_ticket_sessions WHERE ticket_id = ?1 AND session_id = ?2",
                params![ticket.id, session_id],
            );
            return json!({ "sessionId": session_id, "action": "skipped", "error": "session record is gone; unlinked" });
        }
        if row["verdict"] == "unverifiable" {
            // Loss of contact with Orca never proves the agent stopped:
            // resuming now could run it twice.
            return json!({ "sessionId": session_id, "action": "failed", "error": "Orca could not be read, so the session's state is unknown" });
        }
        let Some(harness) = row["harnessId"].as_str() else {
            return json!({
                "sessionId": session_id,
                "action": "skipped",
                "error": "a plain terminal that is no longer live cannot be resumed",
            });
        };
        let workspace = row["workspaceId"].as_str().unwrap_or_default().to_string();
        match self.start_agent(crate::sessions::StartRequest {
            workspace_id: &workspace,
            harness_id: harness,
            prompt: Some(message),
            resume_of: Some(session_id),
            title: row["title"].as_str().map(str::to_owned),
        }) {
            Ok(launched) => json!({
                "sessionId": session_id,
                "action": if launched["agentResume"] == "fresh" { "started" } else { "resumed" },
                "newSessionId": launched["id"],
                "agentResume": launched["agentResume"],
            }),
            Err(err) => {
                json!({ "sessionId": session_id, "action": "failed", "error": err.message })
            }
        }
    }

    fn start_ticket_session(&self, column: &Column, ticket: &Ticket, message: &str) -> Value {
        let workspace = match self.ticket_workspace(ticket) {
            Ok(Some(ws)) => ws,
            Ok(None) => {
                return json!({
                    "sessionId": null,
                    "action": "skipped",
                    "error": "the ticket has no workspace or project to start a session in; set its project (or, on an imported board, where the board's sessions start)",
                });
            }
            Err(err) => {
                return json!({ "sessionId": null, "action": "failed", "error": err.message });
            }
        };
        let harness = self.default_harness(column);
        let key = ticket.ext.key.clone().unwrap_or_else(|| ticket.key.clone());
        match self.start_agent(crate::sessions::StartRequest {
            workspace_id: &workspace,
            harness_id: &harness,
            prompt: Some(message),
            resume_of: None,
            title: Some(format!("{key} · {harness}")),
        }) {
            Ok(launched) => {
                let new_id = launched["id"].as_str().unwrap_or_default().to_string();
                let conn = self.db.lock().unwrap();
                let linked = link_session_in(&conn, &ticket.id, &new_id);
                if ticket.workspace_id.is_none() {
                    let _ = conn.execute(
                        "UPDATE work_tickets SET workspace_id = ?2 WHERE id = ?1",
                        params![ticket.id, workspace],
                    );
                }
                json!({
                    "sessionId": null,
                    "action": if linked.is_ok() { "started" } else { "failed" },
                    "newSessionId": new_id,
                    "harnessId": harness,
                })
            }
            Err(err) => {
                json!({ "sessionId": null, "action": "failed", "error": err.message, "harnessId": harness })
            }
        }
    }

    // ---------------------------------------------------------- tick --

    /// Scheduled column sends and pull-request watches. Best-effort: runs on
    /// the automation scheduler's tick and never fails it.
    pub fn tick_work(&self, now_ms: f64) {
        if self.is_quiescent() {
            return;
        }
        let now = now_ms as i64;
        let columns = {
            let conn = self.db.lock().unwrap();
            match list_all_columns(&conn) {
                Ok(c) => c,
                Err(err) => {
                    eprintln!("[work] tick: cannot list columns: {}", err.message);
                    return;
                }
            }
        };
        for column in &columns {
            if let (Some(cron), Some(due)) = (&column.cron, column.next_run_at)
                && due <= now
            {
                let next = crate::cron::next_fire_ms(cron, now_ms);
                let tickets = {
                    let conn = self.db.lock().unwrap();
                    let _ = conn.execute(
                        "UPDATE work_columns SET next_run_at = ?2 WHERE id = ?1",
                        params![column.id, next],
                    );
                    live_tickets(&conn, &column.id).unwrap_or_default()
                };
                if !column.message.trim().is_empty() {
                    for ticket in tickets {
                        if let Err(err) = self.deliver(column, &ticket.id, "schedule", None) {
                            eprintln!(
                                "[work] scheduled send for {} failed: {}",
                                ticket.key, err.message
                            );
                        }
                    }
                }
            }
            if column.pr_watch && !column.message.trim().is_empty() {
                self.watch_column_prs(column, now);
            }
        }
        self.tick_work_sync(now);
    }

    fn watch_column_prs(&self, column: &Column, now: i64) {
        let tickets = {
            let conn = self.db.lock().unwrap();
            live_tickets(&conn, &column.id).unwrap_or_default()
        };
        for ticket in tickets {
            let (Some(project), Some(number)) = (&ticket.project_id, ticket.pr_number) else {
                continue;
            };
            if ticket.pr_checked_at.is_some_and(|at| now - at < PR_POLL_MS) {
                continue;
            }
            let fingerprint = match self.pr_view(project, number) {
                Ok(value) => pr_fingerprint(&value["pull"]),
                Err(err) => {
                    let conn = self.db.lock().unwrap();
                    let _ = conn.execute(
                        "UPDATE work_tickets SET pr_checked_at = ?2 WHERE id = ?1",
                        params![ticket.id, now],
                    );
                    eprintln!("[work] PR watch for {} failed: {}", ticket.key, err.message);
                    continue;
                }
            };
            {
                let conn = self.db.lock().unwrap();
                let _ = conn.execute(
                    "UPDATE work_tickets SET pr_fingerprint = ?2, pr_checked_at = ?3 WHERE id = ?1",
                    params![ticket.id, fingerprint, now],
                );
            }
            if let Some(previous) = &ticket.pr_fingerprint
                && *previous != fingerprint
                && let Err(err) = self.deliver(column, &ticket.id, "pr_change", None)
            {
                eprintln!(
                    "[work] PR-change send for {} failed: {}",
                    ticket.key, err.message
                );
            }
        }
    }
}

/// A column's tickets that prompts reach (see [`sync::prompts_live`]).
fn live_tickets(conn: &Connection, column_id: &str) -> Result<Vec<Ticket>, RpcError> {
    let mut out = Vec::new();
    for ticket in list_tickets(conn, Some(column_id))? {
        if sync::prompts_live(conn, &ticket)? {
            out.push(ticket);
        }
    }
    Ok(out)
}

/// A column by id, or by name on the given board first.
fn get_column_on(conn: &Connection, id: &str, board_id: Option<&str>) -> Result<Column, RpcError> {
    if let Some(found) = list_columns(conn, board_id)?
        .into_iter()
        .find(|c| c.id == id || c.name.eq_ignore_ascii_case(id))
    {
        return Ok(found);
    }
    get_column(conn, id)
}

fn reorder_columns(conn: &Connection, moving: &str, index: Option<usize>) -> Result<(), RpcError> {
    let board = get_column(conn, moving)?.board_id;
    let mut order: Vec<String> = list_columns(conn, board.as_deref())?
        .into_iter()
        .map(|c| c.id)
        .filter(|id| id != moving)
        .collect();
    let at = index.unwrap_or(order.len()).min(order.len());
    order.insert(at, moving.to_string());
    for (position, id) in order.iter().enumerate() {
        conn.execute(
            "UPDATE work_columns SET position = ?2 WHERE id = ?1",
            params![id, position as i64],
        )
        .map_err(error::from_sqlite)?;
    }
    Ok(())
}

fn select_recipients(recipients: &str, ids: Vec<String>) -> Vec<String> {
    if recipients == "primary" {
        ids.into_iter().take(1).collect()
    } else {
        ids
    }
}

/// What a PR change means for the board: its lifecycle, review decision,
/// mergeability, checks and last update.
fn pr_fingerprint(pull: &Value) -> String {
    json!([
        pull["state"],
        pull["isDraft"],
        pull["mergeable"],
        pull["reviewDecision"],
        pull["checks"]["state"],
        pull["updatedAt"],
    ])
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_v5_database_gains_the_ticket_workspaces_table() {
        let mut conn = Connection::open_in_memory().unwrap();
        let has_table = |conn: &Connection| -> bool {
            conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'work_ticket_workspaces'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
                == 1
        };
        // A database made by an earlier build: everything up to v5, marked v5.
        {
            let tx = conn.transaction().unwrap();
            apply_pending_steps_in_tx(&tx).unwrap();
            tx.execute_batch("DROP TABLE work_ticket_workspaces;")
                .unwrap();
            tx.execute(
                "UPDATE schema_versions SET version = 5 WHERE component = ?1",
                params![SCHEMA_COMPONENT],
            )
            .unwrap();
            tx.commit().unwrap();
        }
        assert!(!has_table(&conn));
        let tx = conn.transaction().unwrap();
        apply_pending_steps_in_tx(&tx).unwrap();
        tx.commit().unwrap();
        assert!(
            has_table(&conn),
            "the v6 step adds it to an existing database"
        );
        let version: i64 = conn
            .query_row(
                "SELECT version FROM schema_versions WHERE component = ?1",
                params![SCHEMA_COMPONENT],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        conn.execute(
            "INSERT INTO work_ticket_workspaces (ticket_id, workspace_id) VALUES ('t', 'w')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn key_prefixes_follow_the_project_name() {
        assert_eq!(key_prefix(Some("Drogon")), "DRG");
        assert_eq!(key_prefix(Some("waman")), "WMN");
        assert_eq!(key_prefix(Some("aeiou")), "AE");
        assert_eq!(key_prefix(Some("x")), "X");
        assert_eq!(key_prefix(None), "WRK");
        assert_eq!(key_prefix(Some("123")), "WRK");
    }

    #[test]
    fn pr_links_parse_numbers_and_urls() {
        assert_eq!(parse_pr("#648").unwrap(), (None, Some(648)));
        assert_eq!(parse_pr("12").unwrap(), (None, Some(12)));
        assert_eq!(
            parse_pr("https://github.com/clioo/drogon/pull/663").unwrap(),
            (
                Some("https://github.com/clioo/drogon/pull/663".to_string()),
                Some(663)
            )
        );
        assert_eq!(parse_pr("").unwrap(), (None, None));
        assert!(parse_pr("ftp://x/pull/1").is_err());
    }

    #[test]
    fn schedules_accept_shorthand_and_cron() {
        assert_eq!(normalize_schedule("15m").unwrap(), "*/15 * * * *");
        assert_eq!(normalize_schedule("2h").unwrap(), "0 */2 * * *");
        assert_eq!(normalize_schedule("1d").unwrap(), "0 0 * * *");
        assert_eq!(normalize_schedule("*/5 * * * *").unwrap(), "*/5 * * * *");
        assert!(normalize_schedule("90m").is_err());
        assert!(normalize_schedule("nonsense").is_err());
    }

    #[test]
    fn excerpts_cut_at_a_character_boundary() {
        assert_eq!(excerpt("short", 10), ("short".to_string(), false));
        assert_eq!(excerpt("héllo wörld", 6), ("héllo…".to_string(), true));
        assert_eq!(excerpt("", 3), (String::new(), false));
    }

    #[test]
    fn imported_tickets_render_their_provider_key() {
        let mut ticket = Ticket {
            id: "t".into(),
            key: "DRG-7".into(),
            project_id: None,
            workspace_id: None,
            column_id: "c".into(),
            position: 0,
            title: "Resume".into(),
            description: String::new(),
            pr_url: None,
            pr_number: None,
            source_url: None,
            next_step: String::new(),
            pr_fingerprint: None,
            pr_checked_at: None,
            created_at: 0,
            updated_at: 0,
            ext: TicketExt::default(),
        };
        assert_eq!(
            render_message("{ticket.key} {ticket.status}", &ticket, None, None),
            "DRG-7"
        );
        ticket.ext.key = Some("APP-128".into());
        ticket.ext.status_name = Some("In Review".into());
        assert_eq!(
            render_message(
                "{ticket.id} {ticket.key} {ticket.drogon_key} {ticket.status}",
                &ticket,
                None,
                None
            ),
            "APP-128 APP-128 DRG-7 In Review"
        );
    }

    #[test]
    fn messages_render_ticket_placeholders() {
        let ticket = Ticket {
            id: "t".into(),
            key: "DRG-42".into(),
            project_id: None,
            workspace_id: None,
            column_id: "c".into(),
            position: 0,
            title: "Improve Jira resume".into(),
            description: String::new(),
            pr_url: None,
            pr_number: Some(648),
            source_url: Some("https://jira.example/DRG-42".into()),
            next_step: String::new(),
            pr_fingerprint: None,
            pr_checked_at: None,
            created_at: 0,
            updated_at: 0,
            ext: TicketExt::default(),
        };
        let out = render_message(
            "Review {ticket.pr} for {ticket.id}.\r\nSource: {ticket.url} {unknown}\n\n",
            &ticket,
            None,
            Some("Drogon"),
        );
        assert_eq!(
            out,
            "Review PR #648 for DRG-42.\nSource: https://jira.example/DRG-42 {unknown}"
        );
    }
}
