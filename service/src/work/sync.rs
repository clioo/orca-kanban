//! Imported boards: a provider board (Jira first) brought into Work.
//!
//! Import picks a provider board as the frame: its columns become the
//! board's columns, each mapped to the provider statuses it stands for, and
//! the user chooses which issues come in. Every imported issue is a ticket
//! with its own (hidden) Drogon key, so sessions, notes and prompts work
//! exactly as on My work.
//!
//! Sync (every [`SYNC_INTERVAL_MS`], or on demand) reads the provider and
//! the provider wins for title, description, type, priority, assignee and
//! sprint. Status is the one field both sides move:
//!
//! - a card dropped into a mapped column moves in Drogon only and waits,
//!   "not synced", until pushed (`work.ticket_push` / `work.board_push`);
//!   a refused push keeps the card where it is with the provider's error;
//! - a provider status change on a card with no pending move moves the card
//!   to the mapped column ("Moved by Jira") and fires its on-enter prompt;
//! - a provider change while a local move is pending is a conflict the user
//!   settles (`work.ticket_resolve`: keep the provider's, or push ours);
//! - a status no column maps leaves the card in place, flagged, until a
//!   column adopts it (`work.column_update statusIds`);
//! - an issue gone from the provider is flagged, never deleted.
//!
//! Scrum boards carry sprints. Prompts fire only for tickets in the active
//! sprint; a closed sprint is read-only, and its unfinished tickets can only
//! be carried over to the active sprint or sent to the backlog — a change
//! that, like a status move, waits to be pushed.

use std::collections::{HashMap, HashSet};

use super::provider::{
    ExtBoard, ExtIssue, ExtSprint, IssueRef, IssueScope, NewIssue, WorkProvider,
};
use super::*;

pub(super) const LOCAL_BOARD: &str = "local";
pub(crate) const SYNC_INTERVAL_MS: i64 = 5 * 60_000;
/// What the import picker's issue rows may take of the 1 MB reply.
pub(super) const PREVIEW_BUDGET_BYTES: usize = 700 * 1024;

#[derive(Clone, Debug)]
pub(super) struct Board {
    pub id: String,
    pub provider: String,
    pub site_id: String,
    pub site_url: String,
    pub external_id: String,
    pub name: String,
    pub kind: String,
    pub project_key: Option<String>,
    pub project_name: Option<String>,
    pub project_id: Option<String>,
    pub statuses: Vec<BoardStatus>,
    pub last_synced_at: Option<i64>,
    pub last_sync_error: Option<String>,
    /// Sync brings in new issues assigned to the connected account.
    pub auto_import_mine: bool,
}

#[derive(Clone, Debug)]
pub(super) struct Sprint {
    pub id: String,
    pub name: String,
    pub state: String,
    pub start: Option<String>,
    pub end: Option<String>,
}

const BOARD_SELECT: &str = "SELECT id, provider, site_id, site_url, external_id, name, kind, project_key, project_name, project_id, statuses, last_synced_at, last_sync_error, auto_import_mine FROM work_boards";

fn board_from_row(r: &rusqlite::Row) -> rusqlite::Result<Board> {
    Ok(Board {
        id: r.get(0)?,
        provider: r.get(1)?,
        site_id: r.get(2)?,
        site_url: r.get(3)?,
        external_id: r.get(4)?,
        name: r.get(5)?,
        kind: r.get(6)?,
        project_key: r.get(7)?,
        project_name: r.get(8)?,
        project_id: r.get(9)?,
        statuses: serde_json::from_str(&r.get::<_, String>(10)?).unwrap_or_default(),
        last_synced_at: r.get(11)?,
        last_sync_error: r.get(12)?,
        auto_import_mine: r.get::<_, i64>(13)? != 0,
    })
}

pub(super) fn list_boards(conn: &Connection) -> Result<Vec<Board>, RpcError> {
    let mut stmt = conn
        .prepare(&format!("{BOARD_SELECT} ORDER BY created_at"))
        .map_err(error::from_sqlite)?;
    stmt.query_map([], board_from_row)
        .map_err(error::from_sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error::from_sqlite)
}

/// A board by id, by name (case-insensitive) or by provider board id.
pub(super) fn get_board(conn: &Connection, id: &str) -> Result<Board, RpcError> {
    conn.query_row(
        &format!(
            "{BOARD_SELECT} WHERE id = ?1 OR lower(name) = lower(?1) OR external_id = ?1
             ORDER BY id = ?1 DESC LIMIT 1"
        ),
        params![id],
        board_from_row,
    )
    .optional()
    .map_err(error::from_sqlite)?
    .ok_or_else(|| error::not_found(format!("work board {id} not found")))
}

/// `boardId` as a column/board filter: absent, empty or `local` is My work.
pub(super) fn resolve_board_param(
    conn: &Connection,
    value: Option<&str>,
) -> Result<Option<String>, RpcError> {
    match value.map(str::trim) {
        None | Some("") => Ok(None),
        Some(v) if v.eq_ignore_ascii_case(LOCAL_BOARD) || v.eq_ignore_ascii_case("my work") => {
            Ok(None)
        }
        Some(v) => Ok(Some(get_board(conn, v)?.id)),
    }
}

pub(super) fn list_sprints(conn: &Connection, board_id: &str) -> Result<Vec<Sprint>, RpcError> {
    let mut stmt = conn
        .prepare(
            "SELECT ext_id, name, state, start_at, end_at FROM work_sprints WHERE board_id = ?1
             ORDER BY position",
        )
        .map_err(error::from_sqlite)?;
    stmt.query_map(params![board_id], |r| {
        Ok(Sprint {
            id: r.get(0)?,
            name: r.get(1)?,
            state: r.get(2)?,
            start: r.get(3)?,
            end: r.get(4)?,
        })
    })
    .map_err(error::from_sqlite)?
    .collect::<Result<Vec<_>, _>>()
    .map_err(error::from_sqlite)
}

fn sprint_json(sprint: &Sprint) -> Value {
    json!({
        "id": sprint.id,
        "name": sprint.name,
        "state": sprint.state,
        "start": sprint.start,
        "end": sprint.end,
    })
}

pub(super) fn active_sprint(sprints: &[Sprint]) -> Option<&Sprint> {
    sprints.iter().find(|s| s.state == "active")
}

pub(super) fn log_activity(conn: &Connection, ticket_id: &str, kind: &str, text: &str) {
    let _ = conn.execute(
        "INSERT INTO work_activity (ticket_id, kind, text, at) VALUES (?1, ?2, ?3, ?4)",
        params![ticket_id, kind, text, crate::now_unix_ms() as i64],
    );
}

fn ticket_sprint_history(
    conn: &Connection,
    ticket_id: &str,
) -> Result<Vec<(String, Option<String>)>, RpcError> {
    let mut stmt = conn
        .prepare("SELECT sprint_id, status_name FROM work_ticket_sprints WHERE ticket_id = ?1")
        .map_err(error::from_sqlite)?;
    stmt.query_map(params![ticket_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(error::from_sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error::from_sqlite)
}

/// Finished on the provider inside a sprint that has since closed: the
/// ticket belongs to that sprint's record, not to the backlog.
fn completed_in_closed(
    ticket: &Ticket,
    closed: &HashSet<String>,
    history: &[(String, Option<String>)],
) -> bool {
    ticket.ext.sprint_id.is_none()
        && ticket.ext.status_category.as_deref() == Some("done")
        && history.iter().any(|(id, _)| closed.contains(id))
}

/// Prompts reach a ticket on My work, on a kanban board, or in the active
/// sprint of a scrum board — never in a closed or future sprint or the
/// backlog.
pub(super) fn prompts_live(conn: &Connection, ticket: &Ticket) -> Result<bool, RpcError> {
    let Some(board_id) = &ticket.ext.board_id else {
        return Ok(true);
    };
    let board = get_board(conn, board_id)?;
    if board.kind != "scrum" {
        return Ok(true);
    }
    let sprints = list_sprints(conn, board_id)?;
    Ok(match (active_sprint(&sprints), &ticket.ext.sprint_id) {
        (Some(active), Some(current)) => active.id == *current,
        _ => false,
    })
}

fn column_for_status<'a>(columns: &'a [Column], status_id: &str) -> Option<&'a Column> {
    columns
        .iter()
        .find(|c| c.statuses.iter().any(|s| s.id == status_id))
}

fn status_name(board: &Board, columns: &[Column], status_id: &str) -> String {
    board
        .statuses
        .iter()
        .chain(columns.iter().flat_map(|c| c.statuses.iter()))
        .find(|s| s.id == status_id)
        .map(|s| s.name.clone())
        .unwrap_or_else(|| status_id.to_string())
}

/// Columns nobody works in (Canceled, Duplicate, Won't do, Archived) start
/// collapsed on an imported board.
fn starts_collapsed(name: &str) -> bool {
    let lower = name.to_lowercase();
    ["cancel", "duplicate", "won't", "wont", "archiv", "obsolete"]
        .iter()
        .any(|w| lower.contains(w))
}

fn icon_for(name: &str, category: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.contains("backlog") {
        "backlog"
    } else if lower.contains("block") {
        "blocked"
    } else if lower.contains("review") {
        "review"
    } else if lower.contains("qa") || lower.contains("test") || lower.contains("verif") {
        "qa"
    } else if category == "done" || lower.contains("done") || lower.contains("closed") {
        "done"
    } else if category == "indeterminate" || lower.contains("progress") || lower.contains("doing") {
        "in_progress"
    } else {
        "todo"
    }
}

/// Maps `ids` to `column` (a status belongs to one column of a board) and
/// returns the tickets whose unmapped provider status just found a home;
/// they are moved there as the provider placed them.
pub(super) fn map_column_statuses(
    conn: &Connection,
    column: &Column,
    ids: &[String],
) -> Result<Vec<String>, RpcError> {
    let Some(board_id) = &column.board_id else {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        return Err(error::invalid_argument(
            "status mapping is for imported boards; My work has no provider statuses",
        ));
    };
    let board = get_board(conn, board_id)?;
    let columns = list_columns(conn, Some(board_id))?;
    let mut mapped = Vec::new();
    for id in ids {
        let status = board
            .statuses
            .iter()
            .chain(columns.iter().flat_map(|c| c.statuses.iter()))
            .find(|s| s.id == *id || s.name.eq_ignore_ascii_case(id))
            .cloned()
            .ok_or_else(|| {
                error::invalid_argument(format!(
                    "{} has no status {id}; known: {}",
                    board.name,
                    board
                        .statuses
                        .iter()
                        .map(|s| s.name.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ))
            })?;
        if !mapped.iter().any(|s: &BoardStatus| s.id == status.id) {
            mapped.push(status);
        }
    }
    let was_mapped: HashSet<String> = columns
        .iter()
        .flat_map(|c| c.statuses.iter().map(|s| s.id.clone()))
        .collect();
    for other in columns.iter().filter(|c| c.id != column.id) {
        let kept: Vec<&BoardStatus> = other
            .statuses
            .iter()
            .filter(|s| !mapped.iter().any(|m| m.id == s.id))
            .collect();
        if kept.len() != other.statuses.len() {
            conn.execute(
                "UPDATE work_columns SET statuses = ?2 WHERE id = ?1",
                params![other.id, serde_json::to_string(&kept).unwrap()],
            )
            .map_err(error::from_sqlite)?;
        }
    }
    conn.execute(
        "UPDATE work_columns SET statuses = ?2, updated_at = ?3 WHERE id = ?1",
        params![
            column.id,
            serde_json::to_string(&mapped).unwrap(),
            crate::now_unix_ms() as i64
        ],
    )
    .map_err(error::from_sqlite)?;
    // Unmapped cards with a newly mapped status and no pending move go home.
    let mut adopted = Vec::new();
    for status in mapped.iter().filter(|s| !was_mapped.contains(&s.id)) {
        let mut stmt = conn
            .prepare(&format!(
                "{TICKET_SELECT} WHERE board_id = ?1 AND ext_status_id = ?2 AND pending_status_id IS NULL"
            ))
            .map_err(error::from_sqlite)?;
        let tickets = stmt
            .query_map(params![board_id, status.id], ticket_from_row)
            .map_err(error::from_sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error::from_sqlite)?;
        for ticket in tickets.into_iter().filter(|t| t.column_id != column.id) {
            let from = columns
                .iter()
                .find(|c| c.id == ticket.column_id)
                .map(|c| c.name.clone())
                .unwrap_or_default();
            relocate(conn, &ticket, &column.id)?;
            log_activity(
                conn,
                &ticket.id,
                "mapped",
                &format!(
                    "Status '{}' mapped to {}: moved {from} → {}",
                    status.name, column.name, column.name
                ),
            );
            if prompts_live(conn, &ticket)? {
                adopted.push(ticket.id);
            }
        }
    }
    Ok(adopted)
}

/// A closed sprint is a record: its board takes no moves.
pub(super) fn check_movable(
    conn: &Connection,
    board_id: &str,
    ticket: &Ticket,
    sprint_param: Option<&str>,
) -> Result<(), RpcError> {
    let sprints = list_sprints(conn, board_id)?;
    let closed_view = sprint_param
        .and_then(|p| {
            sprints
                .iter()
                .find(|s| s.id == p || s.name.eq_ignore_ascii_case(p))
        })
        .filter(|s| s.state == "closed");
    let closed: HashSet<String> = sprints
        .iter()
        .filter(|s| s.state == "closed")
        .map(|s| s.id.clone())
        .collect();
    let history = ticket_sprint_history(conn, &ticket.id)?;
    let home = if completed_in_closed(ticket, &closed, &history) {
        sprints
            .iter()
            .rev()
            .find(|s| closed.contains(&s.id) && history.iter().any(|(id, _)| *id == s.id))
    } else {
        None
    };
    match closed_view.or(home) {
        Some(sprint) => Err(error::invalid_argument(format!(
            "{} is closed and read-only: carry the ticket over to the active sprint or send it to the backlog instead",
            sprint.name
        ))),
        None => Ok(()),
    }
}

/// Records a Drogon-side move on an imported board (see the module comment).
pub(super) fn record_local_move(
    conn: &Connection,
    ticket: &Ticket,
    column: &Column,
) -> Result<(), RpcError> {
    let board = get_board(conn, ticket.ext.board_id.as_deref().unwrap_or_default())?;
    let label = provider_label(&board.provider);
    let from = get_column(conn, &ticket.column_id)
        .map(|c| c.name)
        .unwrap_or_default();
    let status = ticket.ext.status_id.clone().unwrap_or_default();
    let (pending, text) = if ticket.ext.removed_at.is_some() {
        (
            None,
            format!(
                "Moved {from} → {} (not in {label} anymore; nothing to push)",
                column.name
            ),
        )
    } else if column.statuses.is_empty() {
        (
            None,
            format!("Moved {from} → {} (a board-only column)", column.name),
        )
    } else if column.statuses.iter().any(|s| s.id == status) {
        (
            None,
            format!("Moved {from} → {} (matches {label})", column.name),
        )
    } else {
        (
            Some(column.statuses[0].id.clone()),
            format!("Moved {from} → {}; not synced to {label}", column.name),
        )
    };
    conn.execute(
        "UPDATE work_tickets SET pending_status_id = ?2, status_conflict = 0, push_error = NULL WHERE id = ?1",
        params![ticket.id, pending],
    )
    .map_err(error::from_sqlite)?;
    log_activity(conn, &ticket.id, "moved", &text);
    Ok(())
}

/// Moves a ticket to the end of `column_id` and closes the gap it left.
fn relocate(conn: &Connection, ticket: &Ticket, column_id: &str) -> Result<(), RpcError> {
    conn.execute(
        "UPDATE work_tickets SET column_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![ticket.id, column_id, crate::now_unix_ms() as i64],
    )
    .map_err(error::from_sqlite)?;
    place_ticket(conn, column_id, &ticket.id, None)?;
    renumber(conn, &ticket.column_id)
}

pub(super) fn renumber(conn: &Connection, column_id: &str) -> Result<(), RpcError> {
    let ids: Vec<String> = list_tickets(conn, Some(column_id))?
        .into_iter()
        .map(|t| t.id)
        .collect();
    for (position, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE work_tickets SET position = ?2 WHERE id = ?1",
            params![id, position as i64],
        )
        .map_err(error::from_sqlite)?;
    }
    Ok(())
}

// ------------------------------------------------------------- JSON --

pub(super) fn board_json(conn: &Connection, board: &Board) -> Result<Value, RpcError> {
    let pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM work_tickets WHERE board_id = ?1 AND removed_at IS NULL AND
             (pending_status_id IS NOT NULL OR sprint_id IS NOT ext_sprint_id)",
            params![board.id],
            |r| r.get(0),
        )
        .map_err(error::from_sqlite)?;
    let tickets: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM work_tickets WHERE board_id = ?1",
            params![board.id],
            |r| r.get(0),
        )
        .map_err(error::from_sqlite)?;
    Ok(json!({
        "id": board.id,
        "provider": board.provider,
        "siteId": board.site_id,
        "siteUrl": board.site_url,
        "externalId": board.external_id,
        "name": board.name,
        "kind": board.kind,
        "projectKey": board.project_key,
        "projectName": board.project_name,
        "projectId": board.project_id,
        "statuses": board.statuses,
        "lastSyncedAt": board.last_synced_at,
        "lastSyncError": board.last_sync_error,
        "autoImportMine": board.auto_import_mine,
        "pendingCount": pending,
        "ticketCount": tickets,
    }))
}

pub(super) fn local_board_json(conn: &Connection) -> Result<Value, RpcError> {
    let tickets: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM work_tickets WHERE board_id IS NULL",
            [],
            |r| r.get(0),
        )
        .map_err(error::from_sqlite)?;
    Ok(json!({
        "id": LOCAL_BOARD,
        "provider": null,
        "name": "My work",
        "kind": "local",
        "statuses": [],
        "pendingCount": 0,
        "ticketCount": tickets,
    }))
}

pub(super) fn boards_json(conn: &Connection) -> Result<Vec<Value>, RpcError> {
    let mut out = vec![local_board_json(conn)?];
    for board in list_boards(conn)? {
        out.push(board_json(conn, &board)?);
    }
    Ok(out)
}

/// The provider half of a ticket's JSON (all null/false for a local one).
pub(super) fn ticket_ext_json(conn: &Connection, ticket: &Ticket) -> Result<Value, RpcError> {
    let Some(board_id) = &ticket.ext.board_id else {
        return Ok(json!({ "boardId": null, "provider": null, "sync": "local", "sprints": [] }));
    };
    let board = get_board(conn, board_id)?;
    let columns = list_columns(conn, Some(board_id))?;
    let sprints = list_sprints(conn, board_id)?;
    let history = ticket_sprint_history(conn, &ticket.id)?;
    let sprint = |id: &Option<String>| {
        id.as_ref()
            .and_then(|id| sprints.iter().find(|s| s.id == *id))
    };
    let current = sprint(&ticket.ext.sprint_id);
    let unmapped = ticket.ext.pending_status_id.is_none()
        && ticket
            .ext
            .status_id
            .as_ref()
            .is_some_and(|id| column_for_status(&columns, id).is_none());
    let sprint_pending = ticket.ext.sprint_id != ticket.ext.ext_sprint_id;
    let sync = if ticket.ext.removed_at.is_some() {
        "removed"
    } else if ticket.ext.status_conflict {
        "conflict"
    } else if ticket.ext.push_error.is_some() {
        "error"
    } else if ticket.ext.pending_status_id.is_some() || sprint_pending {
        "pending"
    } else if unmapped {
        "unmapped"
    } else {
        "synced"
    };
    // Carried from: the latest closed sprint it passed through, while it
    // sits in an open sprint.
    let closed_history: Vec<&Sprint> = sprints
        .iter()
        .filter(|s| s.state == "closed" && history.iter().any(|(id, _)| *id == s.id))
        .collect();
    let carried_from = match current {
        Some(s) if s.state != "closed" => closed_history.last().map(|s| s.name.clone()),
        _ => None,
    };
    let done = ticket.ext.status_category.as_deref() == Some("done");
    let timeline: Vec<Value> = sprints
        .iter()
        .filter(|s| {
            history.iter().any(|(id, _)| *id == s.id) || current.is_some_and(|c| c.id == s.id)
        })
        .map(|s| {
            let status = history
                .iter()
                .find(|(id, _)| *id == s.id)
                .and_then(|(_, status)| status.clone());
            let outcome = if current.is_some_and(|c| c.id == s.id) {
                s.state.clone()
            } else if s.state == "closed" {
                if current.is_some() {
                    "carried over".to_string()
                } else if done {
                    "completed".to_string()
                } else {
                    "returned to backlog".to_string()
                }
            } else {
                s.state.clone()
            };
            json!({
                "id": s.id,
                "name": s.name,
                "state": s.state,
                "start": s.start,
                "end": s.end,
                "status": status,
                "outcome": outcome,
            })
        })
        .collect();
    Ok(json!({
        "boardId": board.id,
        "provider": board.provider,
        "externalId": ticket.ext.id,
        "externalKey": ticket.ext.key,
        "externalUrl": ticket.ext.url,
        "issueType": ticket.ext.issue_type,
        "priority": ticket.ext.priority,
        "assignee": ticket.ext.assignee,
        "externalStatus": ticket.ext.status_id.as_ref().map(|id| json!({
            "id": id,
            "name": ticket.ext.status_name,
            "category": ticket.ext.status_category,
        })),
        "pendingStatus": ticket.ext.pending_status_id.as_ref().map(|id| json!({
            "id": id,
            "name": status_name(&board, &columns, id),
        })),
        "statusConflict": ticket.ext.status_conflict,
        "statusUnmapped": unmapped,
        "pushError": ticket.ext.push_error,
        "removed": ticket.ext.removed_at.is_some(),
        "removedAt": ticket.ext.removed_at,
        "sprintId": ticket.ext.sprint_id,
        "sprintName": current.map(|s| s.name.clone()),
        "sprintState": current.map(|s| s.state.clone()),
        "externalSprintId": ticket.ext.ext_sprint_id,
        "externalSprintName": sprint(&ticket.ext.ext_sprint_id).map(|s| s.name.clone()),
        "sprintPending": sprint_pending,
        "carriedFrom": carried_from,
        "sync": sync,
        "sprints": timeline,
    }))
}

pub(super) fn activity_json(conn: &Connection, ticket_id: &str) -> Result<Vec<Value>, RpcError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, text, at FROM work_activity WHERE ticket_id = ?1 ORDER BY at DESC, id DESC LIMIT 100",
        )
        .map_err(error::from_sqlite)?;
    stmt.query_map(params![ticket_id], |r| {
        Ok(json!({
            "id": r.get::<_, i64>(0)?,
            "kind": r.get::<_, String>(1)?,
            "text": r.get::<_, String>(2)?,
            "at": r.get::<_, i64>(3)?,
        }))
    })
    .map_err(error::from_sqlite)?
    .collect::<Result<Vec<_>, _>>()
    .map_err(error::from_sqlite)
}

/// Which of an imported board's tickets a view shows, and what the view
/// allows: a scrum board shows one sprint (default: the active one) or the
/// backlog; a kanban board shows everything.
pub(super) struct BoardView {
    pub tickets: Vec<Ticket>,
    pub view: Value,
}

pub(super) fn board_view(
    conn: &Connection,
    board: &Board,
    sprint_param: Option<&str>,
) -> Result<BoardView, RpcError> {
    let mut stmt = conn
        .prepare(&format!(
            "{TICKET_SELECT} WHERE board_id = ?1 ORDER BY position, created_at"
        ))
        .map_err(error::from_sqlite)?;
    let all = stmt
        .query_map(params![board.id], ticket_from_row)
        .map_err(error::from_sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error::from_sqlite)?;
    let sprints = list_sprints(conn, &board.id)?;
    if board.kind != "scrum" {
        return Ok(BoardView {
            tickets: all,
            view: json!({ "kind": "all", "readOnly": false, "promptsPaused": false, "sprints": [] }),
        });
    }
    let closed: HashSet<String> = sprints
        .iter()
        .filter(|s| s.state == "closed")
        .map(|s| s.id.clone())
        .collect();
    let selected = match sprint_param.map(str::trim).filter(|s| !s.is_empty()) {
        Some("backlog") => None,
        Some("active") | None => active_sprint(&sprints).cloned(),
        Some(id) => Some(
            sprints
                .iter()
                .find(|s| s.id == id || s.name.eq_ignore_ascii_case(id))
                .cloned()
                .ok_or_else(|| error::not_found(format!("{} has no sprint {id}", board.name)))?,
        ),
    };
    let mut histories = HashMap::new();
    for ticket in &all {
        histories.insert(ticket.id.clone(), ticket_sprint_history(conn, &ticket.id)?);
    }
    let sprints_json: Vec<Value> = sprints.iter().map(sprint_json).collect();
    let Some(sprint) = selected else {
        let tickets = all
            .into_iter()
            .filter(|t| {
                t.ext.sprint_id.is_none() && !completed_in_closed(t, &closed, &histories[&t.id])
            })
            .collect();
        return Ok(BoardView {
            tickets,
            view: json!({
                "kind": "backlog",
                "sprint": null,
                "readOnly": false,
                "promptsPaused": true,
                "sprints": sprints_json,
            }),
        });
    };
    if sprint.state != "closed" {
        let tickets = all
            .into_iter()
            .filter(|t| t.ext.sprint_id.as_deref() == Some(sprint.id.as_str()))
            .collect();
        return Ok(BoardView {
            tickets,
            view: json!({
                "kind": "sprint",
                "sprint": sprint_json(&sprint),
                "readOnly": false,
                "promptsPaused": sprint.state != "active",
                "sprints": sprints_json,
            }),
        });
    }
    // A closed sprint: every ticket that passed through it, and where each
    // one went.
    let tickets: Vec<Ticket> = all
        .into_iter()
        .filter(|t| {
            t.ext.sprint_id.as_deref() == Some(sprint.id.as_str())
                || histories[&t.id].iter().any(|(id, _)| *id == sprint.id)
        })
        .collect();
    let (mut completed, mut carried, mut backlog) = (vec![], vec![], vec![]);
    for t in &tickets {
        match &t.ext.sprint_id {
            Some(to) if *to != sprint.id => {
                let target = sprints.iter().find(|s| s.id == *to);
                carried.push(json!({
                    "ticketId": t.id,
                    "toSprintId": to,
                    "toSprintName": target.map(|s| s.name.clone()),
                    "pending": t.ext.sprint_id != t.ext.ext_sprint_id,
                }));
            }
            _ if t.ext.status_category.as_deref() == Some("done") => completed.push(json!(t.id)),
            _ => backlog.push(json!({
                "ticketId": t.id,
                "pending": t.ext.sprint_id != t.ext.ext_sprint_id,
            })),
        }
    }
    Ok(BoardView {
        tickets,
        view: json!({
            "kind": "sprint",
            "sprint": sprint_json(&sprint),
            "readOnly": true,
            "promptsPaused": true,
            "sprints": sprints_json,
            "outcome": { "completed": completed, "carried": carried, "backlog": backlog },
        }),
    })
}

/// Assigned to the connected account and not finished: what `mine` and
/// auto-import bring in.
fn is_open_mine(issue: &ExtIssue, me: &str) -> bool {
    issue.assignee_id.as_deref() == Some(me) && issue.status.category != "done"
}

// ------------------------------------------------------ import picker --

/// The import picker's filters (`assignee`: `me`, `none`, `any` or a
/// person's id; `project`: a name or `none`; `status`: a status id;
/// `query`: words in the key or title; `open`: leave out finished issues).
#[derive(Default)]
pub(super) struct PreviewFilter {
    open: bool,
    assignee: Option<String>,
    project: Option<String>,
    status: Option<String>,
    query: Option<String>,
}

impl PreviewFilter {
    fn from_params(params: &Value) -> Result<Self, RpcError> {
        let text = |f: &str| -> Result<Option<String>, RpcError> {
            Ok(str_field(params, f)?
                .map(str::trim)
                .filter(|v| !v.is_empty() && *v != "any")
                .map(str::to_owned))
        };
        Ok(Self {
            open: bool_field(params, "open")?.unwrap_or(false),
            assignee: text("assignee")?,
            project: text("project")?,
            status: text("status")?,
            query: text("query")?.map(|q| q.to_lowercase()),
        })
    }

    fn matches(&self, issue: &ExtIssue, me: Option<&str>) -> bool {
        let assignee = match self.assignee.as_deref() {
            None => true,
            Some("me") => me.is_some() && issue.assignee_id.as_deref() == me,
            Some("none") => issue.assignee_id.is_none(),
            Some(id) => issue.assignee_id.as_deref() == Some(id),
        };
        let project = match self.project.as_deref() {
            None => true,
            Some("none") => issue.project.is_none(),
            Some(name) => issue.project.as_deref() == Some(name),
        };
        let status = self.status.as_deref().is_none_or(|s| issue.status.id == s);
        let query = self.query.as_deref().is_none_or(|q| {
            q.split_whitespace().all(|w| {
                issue.key.to_lowercase().contains(w) || issue.title.to_lowercase().contains(w)
            })
        });
        let open = !self.open || issue.status.category != "done";
        open && assignee && project && status && query
    }
}

/// Who, which projects and which statuses a board's issues have, with
/// counts, for the picker's filter menus (over every issue, not just the
/// filtered ones).
fn preview_facets(issues: &[ExtIssue], me: Option<&str>) -> Value {
    fn count(entries: &mut Vec<(String, String, usize)>, id: String, name: String) {
        match entries.iter_mut().find(|e| e.0 == id) {
            Some(e) => e.2 += 1,
            None => entries.push((id, name, 1)),
        }
    }
    let (mut people, mut projects, mut statuses) = (Vec::new(), Vec::new(), Vec::new());
    let (mut mine, mut unassigned, mut no_project, mut finished) = (0, 0, 0, 0);
    for issue in issues {
        if issue.status.category == "done" {
            finished += 1;
        }
        match &issue.assignee_id {
            Some(id) => {
                if me == Some(id.as_str()) {
                    mine += 1;
                }
                count(
                    &mut people,
                    id.clone(),
                    issue.assignee.clone().unwrap_or_else(|| id.clone()),
                );
            }
            None => unassigned += 1,
        }
        match &issue.project {
            Some(p) => count(&mut projects, p.clone(), p.clone()),
            None => no_project += 1,
        }
        count(
            &mut statuses,
            issue.status.id.clone(),
            issue.status.name.clone(),
        );
    }
    people.sort_by(|a, b| b.2.cmp(&a.2).then(a.1.cmp(&b.1)));
    projects.sort_by(|a, b| b.2.cmp(&a.2).then(a.1.cmp(&b.1)));
    let rows = |v: Vec<(String, String, usize)>| -> Vec<Value> {
        v.into_iter()
            .map(|(id, name, n)| json!({ "id": id, "name": name, "count": n }))
            .collect()
    };
    json!({
        "mine": mine,
        "finished": finished,
        "unassigned": unassigned,
        "noProject": no_project,
        "people": rows(people),
        "projects": rows(projects),
        "statuses": rows(statuses),
    })
}

// ------------------------------------------------------ provider I/O --

fn ext_sprint_row(
    conn: &Connection,
    board_id: &str,
    sprint: &ExtSprint,
    position: i64,
) -> Result<(), RpcError> {
    conn.execute(
        "INSERT INTO work_sprints (board_id, ext_id, name, state, start_at, end_at, position)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(board_id, ext_id) DO UPDATE SET name = excluded.name, state = excluded.state,
           start_at = excluded.start_at, end_at = excluded.end_at,
           position = CASE WHEN excluded.position < 0 THEN work_sprints.position ELSE excluded.position END",
        params![board_id, sprint.id, sprint.name, sprint.state, sprint.start, sprint.end, position],
    )
    .map_err(error::from_sqlite)?;
    Ok(())
}

/// A sprint seen only on an issue (another board's, say) goes after the
/// board's own list.
fn ensure_sprint(conn: &Connection, board_id: &str, sprint: &ExtSprint) -> Result<(), RpcError> {
    let known: bool = conn
        .query_row(
            "SELECT 1 FROM work_sprints WHERE board_id = ?1 AND ext_id = ?2",
            params![board_id, sprint.id],
            |_| Ok(true),
        )
        .optional()
        .map_err(error::from_sqlite)?
        .unwrap_or(false);
    if !known {
        let next: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM work_sprints WHERE board_id = ?1",
                params![board_id],
                |r| r.get(0),
            )
            .map_err(error::from_sqlite)?;
        ext_sprint_row(conn, board_id, sprint, next)?;
    }
    Ok(())
}

fn remember_status(
    conn: &Connection,
    board: &mut Board,
    status: &super::provider::ExtStatus,
) -> Result<(), RpcError> {
    if status.id.is_empty() || board.statuses.iter().any(|s| s.id == status.id) {
        return Ok(());
    }
    board.statuses.push(BoardStatus {
        id: status.id.clone(),
        name: status.name.clone(),
        category: status.category.clone(),
    });
    conn.execute(
        "UPDATE work_boards SET statuses = ?2 WHERE id = ?1",
        params![board.id, serde_json::to_string(&board.statuses).unwrap()],
    )
    .map_err(error::from_sqlite)?;
    Ok(())
}

fn record_sprints(
    conn: &Connection,
    board_id: &str,
    ticket_id: &str,
    issue: &ExtIssue,
    column_name: &str,
) -> Result<(), RpcError> {
    let now = crate::now_unix_ms() as i64;
    for sprint in issue.closed_sprints.iter().chain(issue.sprint.iter()) {
        ensure_sprint(conn, board_id, sprint)?;
        conn.execute(
            "INSERT OR IGNORE INTO work_ticket_sprints (ticket_id, sprint_id, status_name, first_seen_at) VALUES (?1, ?2, NULL, ?3)",
            params![ticket_id, sprint.id, now],
        )
        .map_err(error::from_sqlite)?;
    }
    if let Some(sprint) = &issue.sprint {
        conn.execute(
            "UPDATE work_ticket_sprints SET status_name = ?3 WHERE ticket_id = ?1 AND sprint_id = ?2",
            params![ticket_id, sprint.id, column_name],
        )
        .map_err(error::from_sqlite)?;
    }
    Ok(())
}

/// Creates the ticket for a newly imported issue.
fn insert_issue(
    conn: &Connection,
    board: &mut Board,
    columns: &[Column],
    issue: &ExtIssue,
) -> Result<String, RpcError> {
    remember_status(conn, board, &issue.status)?;
    let column = column_for_status(columns, &issue.status.id)
        .or_else(|| columns.first())
        .ok_or_else(|| error::invalid_argument("the board has no columns"))?;
    let project = board
        .project_id
        .as_deref()
        .and_then(|p| project_name(conn, p).ok());
    let key = next_key(conn, &key_prefix(project.as_deref()))?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = crate::now_unix_ms() as i64;
    let sprint = issue.sprint.as_ref().map(|s| s.id.clone());
    conn.execute(
        "INSERT INTO work_tickets (id, key, project_id, column_id, position, title, description, source_url,
           created_at, updated_at, board_id, ext_id, ext_key, ext_url, issue_type, priority, assignee,
           ext_status_id, ext_status_name, ext_status_category, sprint_id, ext_sprint_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20)",
        params![
            id, key, board.project_id, column.id, i64::MAX, clip(&issue.title, MAX_TITLE), clip(&issue.description, MAX_TEXT),
            issue.url, now, board.id, issue.id, issue.key, issue.url, issue.issue_type, issue.priority,
            issue.assignee, issue.status.id, issue.status.name, issue.status.category, sprint
        ],
    )
    .map_err(error::from_sqlite)?;
    place_ticket(conn, &column.id, &id, None)?;
    record_sprints(conn, &board.id, &id, issue, &column.name)?;
    let mapped = column_for_status(columns, &issue.status.id).is_some();
    log_activity(
        conn,
        &id,
        "imported",
        &if mapped {
            format!(
                "Imported {} from {} ({})",
                issue.key,
                provider_label(&board.provider),
                issue.status.name
            )
        } else {
            format!(
                "Imported {} from {}; status '{}' is not mapped to a column",
                issue.key,
                provider_label(&board.provider),
                issue.status.name
            )
        },
    );
    Ok(id)
}

fn clip(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max {
        trimmed.to_string()
    } else {
        trimmed.chars().take(max).collect()
    }
}

pub(super) fn provider_label(provider: &str) -> &'static str {
    super::sources::source_info(provider)
        .map(|s| s.name)
        .unwrap_or("the provider")
}

/// What one sync did to one ticket.
#[derive(Default)]
struct IssueOutcome {
    moved: bool,
    conflict: bool,
    /// Moved into a column while prompts are live: fire its on-enter.
    enter: bool,
}

/// Applies the provider's view of an issue to its ticket (see the module
/// comment for who wins what).
fn apply_issue(
    conn: &Connection,
    board: &mut Board,
    columns: &[Column],
    ticket: &Ticket,
    issue: &ExtIssue,
) -> Result<IssueOutcome, RpcError> {
    let label = provider_label(&board.provider);
    let mut outcome = IssueOutcome::default();
    remember_status(conn, board, &issue.status)?;
    if ticket.ext.removed_at.is_some() {
        log_activity(conn, &ticket.id, "restored", &format!("Back in {label}"));
    }
    conn.execute(
        "UPDATE work_tickets SET title = ?2, description = ?3, issue_type = ?4, priority = ?5, assignee = ?6,
           ext_url = ?7, source_url = COALESCE(source_url, ?7), ext_id = ?8, removed_at = NULL WHERE id = ?1",
        params![
            ticket.id,
            clip(&issue.title, MAX_TITLE),
            clip(&issue.description, MAX_TEXT),
            issue.issue_type,
            issue.priority,
            issue.assignee,
            issue.url,
            issue.id
        ],
    )
    .map_err(error::from_sqlite)?;

    // Sprint: the provider wins. An unsynced local sprint change survives
    // only while the provider's sprint is the one it was made against.
    let remote_sprint = issue.sprint.as_ref().map(|s| s.id.clone());
    if remote_sprint != ticket.ext.ext_sprint_id {
        let name = |id: &Option<String>| match id {
            Some(id) => list_sprints(conn, &board.id)
                .ok()
                .and_then(|all| all.into_iter().find(|s| s.id == *id).map(|s| s.name))
                .or_else(|| {
                    issue
                        .sprint
                        .as_ref()
                        .filter(|s| s.id == *id)
                        .map(|s| s.name.clone())
                })
                .unwrap_or_else(|| id.clone()),
            None => "the backlog".to_string(),
        };
        if let Some(sprint) = &issue.sprint {
            ensure_sprint(conn, &board.id, sprint)?;
        }
        let text = if ticket.ext.sprint_id != ticket.ext.ext_sprint_id {
            format!(
                "{label} moved it to {}; your unsynced move to {} was dropped",
                name(&remote_sprint),
                name(&ticket.ext.sprint_id)
            )
        } else {
            format!(
                "{label} moved it from {} to {}",
                name(&ticket.ext.ext_sprint_id),
                name(&remote_sprint)
            )
        };
        conn.execute(
            "UPDATE work_tickets SET sprint_id = ?2, ext_sprint_id = ?2 WHERE id = ?1",
            params![ticket.id, remote_sprint],
        )
        .map_err(error::from_sqlite)?;
        log_activity(conn, &ticket.id, "sprint", &text);
    }

    // Status.
    let mut column_name = columns
        .iter()
        .find(|c| c.id == ticket.column_id)
        .map(|c| c.name.clone())
        .unwrap_or_default();
    let status = &issue.status;
    if ticket.ext.status_id.as_deref() != Some(status.id.as_str()) {
        let previous = ticket.ext.status_name.clone().unwrap_or_else(|| "?".into());
        match &ticket.ext.pending_status_id {
            Some(pending) if *pending == status.id => {
                conn.execute(
                    "UPDATE work_tickets SET pending_status_id = NULL, status_conflict = 0, push_error = NULL WHERE id = ?1",
                    params![ticket.id],
                )
                .map_err(error::from_sqlite)?;
                log_activity(
                    conn,
                    &ticket.id,
                    "synced",
                    &format!("{label} now matches your move: {}", status.name),
                );
            }
            Some(pending) => {
                conn.execute(
                    "UPDATE work_tickets SET status_conflict = 1 WHERE id = ?1",
                    params![ticket.id],
                )
                .map_err(error::from_sqlite)?;
                outcome.conflict = true;
                log_activity(
                    conn,
                    &ticket.id,
                    "conflict",
                    &format!(
                        "{label} moved it to {} while your move to {} was unsynced",
                        status.name,
                        status_name(board, columns, pending)
                    ),
                );
            }
            None => match column_for_status(columns, &status.id) {
                Some(target) if target.id != ticket.column_id => {
                    relocate(conn, ticket, &target.id)?;
                    log_activity(
                        conn,
                        &ticket.id,
                        "moved_by_provider",
                        &format!("Moved by {label}: {column_name} → {}", target.name),
                    );
                    column_name = target.name.clone();
                    outcome.moved = true;
                }
                Some(_) => log_activity(
                    conn,
                    &ticket.id,
                    "status",
                    &format!("{label} status: {previous} → {}", status.name),
                ),
                None => log_activity(
                    conn,
                    &ticket.id,
                    "unmapped",
                    &format!(
                        "{label} status '{}' is not mapped to a column; the card stays in {column_name}",
                        status.name
                    ),
                ),
            },
        }
        conn.execute(
            "UPDATE work_tickets SET ext_status_id = ?2, ext_status_name = ?3, ext_status_category = ?4, updated_at = ?5 WHERE id = ?1",
            params![ticket.id, status.id, status.name, status.category, crate::now_unix_ms() as i64],
        )
        .map_err(error::from_sqlite)?;
    }
    record_sprints(conn, &board.id, &ticket.id, issue, &column_name)?;
    if outcome.moved {
        let fresh = get_ticket(conn, &ticket.id)?;
        outcome.enter = prompts_live(conn, &fresh)?;
    }
    Ok(outcome)
}

fn provider_error(error: super::provider::ProviderError) -> RpcError {
    error.into()
}

impl Engine {
    fn board_provider(&self, board: &Board) -> Result<Box<dyn WorkProvider + '_>, RpcError> {
        self.work_provider(&board.provider, Some(&board.site_id))
    }

    fn provider_param<'a>(
        &'a self,
        params: &Value,
    ) -> Result<Box<dyn WorkProvider + 'a>, RpcError> {
        let kind = str_field(params, "provider")?.unwrap_or("jira");
        let site = str_field(params, "siteId")?.filter(|s| !s.trim().is_empty());
        self.work_provider(kind, site)
    }

    /// `work.provider_boards`: the provider's boards, marking the ones
    /// already imported.
    pub(crate) fn work_provider_boards(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["provider", "siteId"])?;
        let provider = self.provider_param(params)?;
        let boards = provider.list_boards().map_err(provider_error)?;
        // Only a ranking hint: a failed lookup lists the boards as before.
        let assigned = provider.assigned_open_counts(&boards).unwrap_or_default();
        let imported = {
            let conn = self.db.lock().unwrap();
            list_boards(&conn)?
        };
        let rows: Vec<Value> = boards
            .iter()
            .map(|b| {
                let mut row = serde_json::to_value(b).unwrap();
                row["importedBoardId"] = json!(
                    imported
                        .iter()
                        .find(|i| i.provider == provider.kind() && i.external_id == b.id)
                        .map(|i| i.id.clone())
                );
                let counts = assigned.get(&b.id).copied().unwrap_or_default();
                row["assignedOpen"] = json!(counts.on_board);
                row["assignedInProject"] = json!(counts.in_project);
                row
            })
            .collect();
        Ok(
            json!({ "provider": provider.kind(), "boards": rows, "warnings": provider.board_warnings() }),
        )
    }

    /// `work.import_preview`: a provider board's columns, sprints and
    /// issues, marking issues already on the board, for the import picker.
    pub(crate) fn work_import_preview(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(
            params,
            &[
                "provider",
                "siteId",
                "externalBoardId",
                "scope",
                "assignee",
                "project",
                "status",
                "query",
                "open",
            ],
        )?;
        let external = required(params, "externalBoardId")?;
        let filter = PreviewFilter::from_params(params)?;
        let scope = match str_field(params, "scope")?.map(str::trim) {
            None | Some("") | Some("board") => IssueScope::Board,
            Some("backlog") => IssueScope::Backlog,
            Some(other) => match other.strip_prefix("sprint:") {
                Some(id) if !id.is_empty() => IssueScope::Sprint(id.to_string()),
                _ => {
                    return Err(error::invalid_argument(
                        "scope must be board, backlog or sprint:<id>",
                    ));
                }
            },
        };
        let provider = self.provider_param(params)?;
        let board = provider.board(&external).map_err(provider_error)?;
        let columns = provider.board_columns(&external).map_err(provider_error)?;
        let sprints = provider.list_sprints(&external).map_err(provider_error)?;
        let issues = provider
            .list_issues(&external, &scope)
            .map_err(provider_error)?;
        let imported: HashMap<String, String> = {
            let conn = self.db.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT t.ext_key, t.id FROM work_tickets t JOIN work_boards b ON b.id = t.board_id
                     WHERE b.provider = ?1 AND b.external_id = ?2",
                )
                .map_err(error::from_sqlite)?;
            stmt.query_map(params![provider.kind(), external], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(error::from_sqlite)?
            .collect::<Result<_, _>>()
            .map_err(error::from_sqlite)?
        };
        // The picker needs keys, titles, statuses and sprints, not
        // descriptions (a real team's run to megabytes): rows are compact,
        // and a board past the reply budget is cut with `truncated` (narrow
        // it with a scope).
        let me = provider.me().ok().flatten();
        let facets = preview_facets(&issues, me.as_deref());
        let issues: Vec<&ExtIssue> = issues
            .iter()
            .filter(|i| filter.matches(i, me.as_deref()))
            .collect();
        let total = issues.len();
        let mut rows: Vec<Value> = Vec::new();
        let mut used = 0usize;
        for i in issues {
            let mut row = serde_json::to_value(i).unwrap();
            if let Some(object) = row.as_object_mut() {
                object.remove("description");
                object.remove("updated");
            }
            row["importedTicketId"] = json!(imported.get(&i.key));
            used += row.to_string().len() + 1;
            if used > PREVIEW_BUDGET_BYTES {
                break;
            }
            rows.push(row);
        }
        Ok(json!({
            "provider": provider.kind(),
            "board": board,
            "columns": columns,
            "sprints": sprints,
            "truncated": rows.len() < total,
            "total": total,
            "me": me,
            "facets": facets,
            "issues": rows,
        }))
    }

    /// `work.board_import`: brings a provider board in (first time: its
    /// columns and status mapping) and the chosen issues onto it. Issues
    /// already imported are refreshed, never duplicated.
    pub(crate) fn do_work_board_import(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(
            params,
            &[
                "provider",
                "siteId",
                "externalBoardId",
                "issueKeys",
                "all",
                "mine",
                "autoImportMine",
                "projectId",
            ],
        )?;
        let mine = bool_field(params, "mine")?.unwrap_or(false);
        let auto_import_mine = bool_field(params, "autoImportMine")?;
        let external = required(params, "externalBoardId")?;
        let keys: Option<Vec<String>> = match params.get("issueKeys") {
            None | Some(Value::Null) => None,
            Some(Value::Array(items)) => Some(
                items
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .map(|s| s.trim().to_uppercase())
                            .ok_or_else(|| error::invalid_argument("issueKeys must be strings"))
                    })
                    .collect::<Result<_, _>>()?,
            ),
            Some(_) => return Err(error::invalid_argument("issueKeys must be an array")),
        };
        let all = bool_field(params, "all")?.unwrap_or(false);
        if keys.is_none() && !all && !mine {
            return Err(error::invalid_argument(
                "choose the issues to import (issueKeys), mine: true (your open ones) or all: true",
            ));
        }
        let provider = self.provider_param(params)?;
        let ext_board: ExtBoard = provider.board(&external).map_err(provider_error)?;
        let ext_columns = provider.board_columns(&external).map_err(provider_error)?;
        let ext_sprints = provider.list_sprints(&external).map_err(provider_error)?;
        let catalogue = provider.list_statuses(&external).map_err(provider_error)?;
        let issues = provider
            .list_issues(&external, &IssueScope::Board)
            .map_err(provider_error)?;
        let me = if mine || auto_import_mine == Some(true) {
            provider.me().map_err(provider_error)?
        } else {
            None
        };
        if mine && me.is_none() {
            return Err(error::invalid_argument(format!(
                "{} did not say who you are; choose the issues instead",
                provider_label(provider.kind())
            )));
        }
        let chosen: Vec<&ExtIssue> = match &keys {
            Some(keys) => {
                let missing: Vec<&String> = keys
                    .iter()
                    .filter(|k| !issues.iter().any(|i| i.key.eq_ignore_ascii_case(k)))
                    .collect();
                if !missing.is_empty() {
                    return Err(error::not_found(format!(
                        "{} is not on {}",
                        missing
                            .iter()
                            .map(|k| k.as_str())
                            .collect::<Vec<_>>()
                            .join(", "),
                        ext_board.name
                    )));
                }
                issues
                    .iter()
                    .filter(|i| keys.iter().any(|k| i.key.eq_ignore_ascii_case(k)))
                    .collect()
            }
            None if all => issues.iter().collect(),
            None => Vec::new(),
        };
        // `mine` adds every issue assigned to the connected account.
        let mut chosen = chosen;
        if let (true, Some(me)) = (mine, me.as_deref()) {
            for issue in issues.iter().filter(|i| is_open_mine(i, me)) {
                if !chosen.iter().any(|c| c.key == issue.key) {
                    chosen.push(issue);
                }
            }
        }
        let (site_id, site_url) = provider.site();
        let mut conn = self.db.lock().unwrap();
        let project_id = str_field(params, "projectId")?
            .map(|p| resolve_project(&conn, p))
            .transpose()?;
        let tx = conn.transaction().map_err(error::from_sqlite)?;
        let now = crate::now_unix_ms() as i64;
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM work_boards WHERE provider = ?1 AND site_id = ?2 AND external_id = ?3",
                params![provider.kind(), site_id, ext_board.id],
                |r| r.get(0),
            )
            .optional()
            .map_err(error::from_sqlite)?;
        let board_id = match existing {
            Some(id) => {
                tx.execute(
                    "UPDATE work_boards SET name = ?2, kind = ?3, project_key = ?4, project_name = ?5,
                       project_id = COALESCE(?6, project_id), updated_at = ?7,
                       auto_import_mine = COALESCE(?8, auto_import_mine) WHERE id = ?1",
                    params![id, ext_board.name, ext_board.kind, ext_board.project_key, ext_board.project_name, project_id, now,
                        auto_import_mine.map(|b| b as i64)],
                )
                .map_err(error::from_sqlite)?;
                id
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                // The board's own statuses first, then the rest of the site's
                // (what a Drogon column can be mapped to later).
                let mut statuses: Vec<BoardStatus> = Vec::new();
                for s in ext_columns
                    .iter()
                    .flat_map(|c| c.statuses.iter())
                    .chain(catalogue.iter())
                {
                    if !statuses.iter().any(|known| known.id == s.id) {
                        statuses.push(BoardStatus {
                            id: s.id.clone(),
                            name: s.name.clone(),
                            category: s.category.clone(),
                        });
                    }
                }
                tx.execute(
                    "INSERT INTO work_boards (id, provider, site_id, site_url, external_id, name, kind, project_key,
                       project_name, project_id, statuses, created_at, updated_at, auto_import_mine)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13)",
                    params![
                        id, provider.kind(), site_id, site_url, ext_board.id, ext_board.name, ext_board.kind,
                        ext_board.project_key, ext_board.project_name, project_id,
                        serde_json::to_string(&statuses).unwrap(), now, auto_import_mine.unwrap_or(false) as i64
                    ],
                )
                .map_err(error::from_sqlite)?;
                for (position, column) in ext_columns.iter().enumerate() {
                    let statuses: Vec<BoardStatus> = column
                        .statuses
                        .iter()
                        .map(|s| BoardStatus {
                            id: s.id.clone(),
                            name: s.name.clone(),
                            category: s.category.clone(),
                        })
                        .collect();
                    let category = column
                        .statuses
                        .first()
                        .map(|s| s.category.as_str())
                        .unwrap_or("");
                    tx.execute(
                        "INSERT INTO work_columns (id, name, icon, position, board_id, statuses, created_at, updated_at, collapsed)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
                        params![
                            uuid::Uuid::new_v4().to_string(),
                            clip(&column.name, MAX_NAME),
                            icon_for(&column.name, category),
                            position as i64,
                            id,
                            serde_json::to_string(&statuses).unwrap(),
                            now,
                            starts_collapsed(&column.name) as i64
                        ],
                    )
                    .map_err(error::from_sqlite)?;
                }
                if ext_columns.is_empty() {
                    tx.execute(
                        "INSERT INTO work_columns (id, name, icon, position, board_id, created_at, updated_at)
                         VALUES (?1, 'To do', 'todo', 0, ?2, ?3, ?3)",
                        params![uuid::Uuid::new_v4().to_string(), id, now],
                    )
                    .map_err(error::from_sqlite)?;
                }
                id
            }
        };
        for (position, sprint) in ext_sprints.iter().enumerate() {
            ext_sprint_row(&tx, &board_id, sprint, position as i64)?;
        }
        let mut board = get_board(&tx, &board_id)?;
        let columns = list_columns(&tx, Some(&board_id))?;
        let (mut imported, mut refreshed) = (0, 0);
        for issue in chosen {
            let found: Option<Ticket> = tx
                .query_row(
                    &format!("{TICKET_SELECT} WHERE board_id = ?1 AND ext_key = ?2"),
                    params![board_id, issue.key],
                    ticket_from_row,
                )
                .optional()
                .map_err(error::from_sqlite)?;
            match found {
                Some(ticket) => {
                    apply_issue(&tx, &mut board, &columns, &ticket, issue)?;
                    refreshed += 1;
                }
                None => {
                    insert_issue(&tx, &mut board, &columns, issue)?;
                    imported += 1;
                }
            }
        }
        tx.execute(
            "UPDATE work_boards SET last_synced_at = ?2, last_sync_error = NULL WHERE id = ?1",
            params![board_id, now],
        )
        .map_err(error::from_sqlite)?;
        tx.commit().map_err(error::from_sqlite)?;
        let board = get_board(&conn, &board_id)?;
        Ok(json!({
            "board": board_json(&conn, &board)?,
            "imported": imported,
            "refreshed": refreshed,
        }))
    }

    /// `work.board_sync`: reads the provider for every ticket on the board.
    pub(crate) fn do_work_board_sync(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["boardId"])?;
        let board = {
            let conn = self.db.lock().unwrap();
            get_board(&conn, &required(params, "boardId")?)?
        };
        self.sync_board(&board)
    }

    pub(super) fn sync_board(&self, board: &Board) -> Result<Value, RpcError> {
        let now = crate::now_unix_ms() as i64;
        let fetched = (|| {
            let provider = self.board_provider(board)?;
            let sprints = provider
                .list_sprints(&board.external_id)
                .map_err(provider_error)?;
            let catalogue = provider
                .list_statuses(&board.external_id)
                .map_err(provider_error)?;
            let known: Vec<(String, String, Option<String>)> = {
                let conn = self.db.lock().unwrap();
                let mut stmt = conn
                    .prepare("SELECT id, ext_key, ext_id FROM work_tickets WHERE board_id = ?1 AND ext_key IS NOT NULL")
                    .map_err(error::from_sqlite)?;
                stmt.query_map(params![board.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .map_err(error::from_sqlite)?
                    .collect::<Result<_, _>>()
                    .map_err(error::from_sqlite)?
            };
            let scope = IssueScope::Sync {
                keys: known.iter().map(|(_, key, _)| key.clone()).collect(),
                mine_open: board.auto_import_mine,
            };
            let issues = provider
                .list_issues(&board.external_id, &scope)
                .map_err(provider_error)?;
            // Tickets whose issue left the board's listing: read each one
            // directly (it may have moved board) before calling it gone.
            let mut off_board = HashMap::new();
            for (_, key, ext_id) in &known {
                if !issues.iter().any(|i| i.key == *key) {
                    let issue = IssueRef {
                        key,
                        id: ext_id.as_deref(),
                    };
                    off_board.insert(
                        key.clone(),
                        provider
                            .get_issue(&board.external_id, issue)
                            .map_err(provider_error)?,
                    );
                }
            }
            let me = if board.auto_import_mine {
                provider.me().map_err(provider_error)?
            } else {
                None
            };
            Ok::<_, RpcError>((sprints, catalogue, issues, known, off_board, me))
        })();
        let (sprints, catalogue, issues, known, off_board, me) = match fetched {
            Ok(data) => data,
            Err(err) => {
                let conn = self.db.lock().unwrap();
                let _ = conn.execute(
                    "UPDATE work_boards SET last_synced_at = ?2, last_sync_error = ?3 WHERE id = ?1",
                    params![board.id, now, err.message],
                );
                return Err(err);
            }
        };
        let mut enter = Vec::new();
        let (mut moved, mut conflicts, mut removed, mut updated, mut added) = (0, 0, 0, 0, 0);
        {
            let mut conn = self.db.lock().unwrap();
            let tx = conn.transaction().map_err(error::from_sqlite)?;
            for (position, sprint) in sprints.iter().enumerate() {
                ext_sprint_row(&tx, &board.id, sprint, position as i64)?;
            }
            let mut board = get_board(&tx, &board.id)?;
            for status in &catalogue {
                remember_status(&tx, &mut board, status)?;
            }
            let columns = list_columns(&tx, Some(&board.id))?;
            for (ticket_id, key, _) in &known {
                let ticket = get_ticket(&tx, ticket_id)?;
                let issue = issues
                    .iter()
                    .find(|i| i.key == *key)
                    .or_else(|| off_board.get(key).and_then(|i| i.as_ref()));
                match issue {
                    Some(issue) => {
                        let outcome = apply_issue(&tx, &mut board, &columns, &ticket, issue)?;
                        updated += 1;
                        if outcome.moved {
                            moved += 1;
                        }
                        if outcome.conflict {
                            conflicts += 1;
                        }
                        if outcome.enter {
                            enter.push(ticket.id.clone());
                        }
                    }
                    None if ticket.ext.removed_at.is_none() => {
                        tx.execute(
                            "UPDATE work_tickets SET removed_at = ?2 WHERE id = ?1",
                            params![ticket.id, now],
                        )
                        .map_err(error::from_sqlite)?;
                        log_activity(
                            &tx,
                            &ticket.id,
                            "removed",
                            &format!(
                                "Not in {} anymore; kept here with its sessions",
                                provider_label(&board.provider)
                            ),
                        );
                        removed += 1;
                    }
                    None => {}
                }
            }
            // New open issues assigned to the owner come in by themselves
            // (finished ones are history, not work).
            if let Some(me) = &me {
                for issue in issues.iter().filter(|i| is_open_mine(i, me)) {
                    if known.iter().any(|(_, key, _)| *key == issue.key) {
                        continue;
                    }
                    let id = insert_issue(&tx, &mut board, &columns, issue)?;
                    log_activity(
                        &tx,
                        &id,
                        "auto_imported",
                        &format!(
                            "Assigned to you in {}: imported on sync",
                            provider_label(&board.provider)
                        ),
                    );
                    added += 1;
                }
            }
            tx.execute(
                "UPDATE work_boards SET last_synced_at = ?2, last_sync_error = NULL WHERE id = ?1",
                params![board.id, now],
            )
            .map_err(error::from_sqlite)?;
            tx.commit().map_err(error::from_sqlite)?;
        }
        let mut deliveries = Vec::new();
        for ticket_id in enter {
            match self.deliver_on_enter(&ticket_id) {
                Ok(Value::Null) => {}
                Ok(delivery) => deliveries.push(delivery),
                Err(err) => eprintln!("[work] on-enter after sync failed: {}", err.message),
            }
        }
        let conn = self.db.lock().unwrap();
        let board = get_board(&conn, &board.id)?;
        Ok(json!({
            "board": board_json(&conn, &board)?,
            "updated": updated,
            "moved": moved,
            "conflicts": conflicts,
            "removed": removed,
            "imported": added,
            "deliveries": deliveries,
        }))
    }

    /// `work.create_options`: what creating an issue on an imported board
    /// needs chosen (Jira issue types, a GitHub Project's repositories).
    pub(crate) fn work_create_options(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["boardId"])?;
        let board = {
            let conn = self.db.lock().unwrap();
            get_board(&conn, &required(params, "boardId")?)?
        };
        let provider = self.board_provider(&board)?;
        let options = provider
            .create_options(&board.external_id)
            .map_err(provider_error)?;
        Ok(
            json!({ "provider": board.provider, "boardId": board.id, "issueTypes": options.issue_types, "repos": options.repos }),
        )
    }

    /// A new issue in an imported board's source, in the status of
    /// `column` (its first mapped one; a Drogon-only column keeps the
    /// source's default and the card stays in it), in the sprint named by
    /// `sprintId` (default: the active one on a sprint board; `backlog` for
    /// none), assigned to the owner unless `assignToMe` is false. The
    /// ticket comes in like an imported one, and the column's on-enter
    /// prompt fires as for any ticket entering it.
    pub(super) fn create_ticket_on_board(
        &self,
        board_id: &str,
        column: Option<&str>,
        params: &Value,
    ) -> Result<Value, RpcError> {
        for field in ["projectId", "workspaceId", "prUrl", "sourceUrl"] {
            if params.get(field).is_some() {
                return Err(error::invalid_argument(format!(
                    "{field} is not set when creating an issue on an imported board (set it on the ticket afterwards)"
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
        let assign_to_me = bool_field(params, "assignToMe")?.unwrap_or(true);
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
        let (board, column, sprint) = {
            let conn = self.db.lock().unwrap();
            // Checked before anything is created in the source.
            for session in &session_ids {
                self.require_session_row(&conn, session)?;
            }
            let board = get_board(&conn, board_id)?;
            let columns = list_columns(&conn, Some(&board.id))?;
            let column = match column {
                Some(c) => columns
                    .iter()
                    .find(|x| x.id == c || x.name.eq_ignore_ascii_case(c))
                    .cloned()
                    .ok_or_else(|| error::not_found(format!("{} has no column {c}", board.name)))?,
                None => columns
                    .first()
                    .cloned()
                    .ok_or_else(|| error::invalid_argument("the board has no columns"))?,
            };
            let sprints = list_sprints(&conn, &board.id)?;
            let sprint = match str_field(params, "sprintId")?.map(str::trim) {
                Some("backlog") | Some("") => None,
                None if board.kind == "scrum" => active_sprint(&sprints).map(|s| s.id.clone()),
                None => None,
                Some("active") => Some(
                    active_sprint(&sprints)
                        .ok_or_else(|| {
                            error::invalid_argument(format!("{} has no active sprint", board.name))
                        })?
                        .id
                        .clone(),
                ),
                Some(wanted) => {
                    let sprint = sprints
                        .iter()
                        .find(|s| s.id == wanted || s.name.eq_ignore_ascii_case(wanted))
                        .ok_or_else(|| {
                            error::not_found(format!("{} has no sprint {wanted}", board.name))
                        })?;
                    if sprint.state == "closed" {
                        return Err(error::invalid_argument(format!(
                            "{} is closed; it takes no issues",
                            sprint.name
                        )));
                    }
                    Some(sprint.id.clone())
                }
            };
            (board, column, sprint)
        };
        let provider = self.board_provider(&board)?;
        let (issue, warnings) = provider
            .create_issue(
                &board.external_id,
                &NewIssue {
                    title: &title,
                    description: &description,
                    status_id: column.statuses.first().map(|s| s.id.as_str()),
                    sprint_id: sprint.as_deref(),
                    assign_to_me,
                    issue_type: str_field(params, "issueType")?.filter(|s| !s.trim().is_empty()),
                    repo: str_field(params, "repo")?.filter(|s| !s.trim().is_empty()),
                },
            )
            .map_err(provider_error)?;
        let label = provider_label(&board.provider);
        let ticket_id = {
            let mut conn = self.db.lock().unwrap();
            let tx = conn.transaction().map_err(error::from_sqlite)?;
            let mut board = get_board(&tx, &board.id)?;
            let columns = list_columns(&tx, Some(&board.id))?;
            if let Some(sprint) = &issue.sprint {
                ensure_sprint(&tx, &board.id, sprint)?;
            }
            let id = insert_issue(&tx, &mut board, &columns, &issue)?;
            // A Drogon-only column keeps the card it was created in.
            if column.statuses.is_empty() {
                let ticket = get_ticket(&tx, &id)?;
                if ticket.column_id != column.id {
                    relocate(&tx, &ticket, &column.id)?;
                }
            }
            if !next_step.is_empty() {
                tx.execute(
                    "UPDATE work_tickets SET next_step = ?2 WHERE id = ?1",
                    params![id, next_step],
                )
                .map_err(error::from_sqlite)?;
            }
            for session in &session_ids {
                link_session_in(&tx, &id, session)?;
            }
            // Created here, not imported: the activity says so.
            tx.execute(
                "DELETE FROM work_activity WHERE ticket_id = ?1 AND kind = 'imported'",
                params![id],
            )
            .map_err(error::from_sqlite)?;
            log_activity(
                &tx,
                &id,
                "created",
                &format!("Created {} in {label} from the Work board", issue.key),
            );
            for warning in &warnings {
                log_activity(&tx, &id, "created", warning);
            }
            tx.commit().map_err(error::from_sqlite)?;
            id
        };
        let delivery = self.deliver_on_enter(&ticket_id)?;
        let ticket = {
            let conn = self.db.lock().unwrap();
            get_ticket(&conn, &ticket_id)?
        };
        let mut value = self.ticket_json(&ticket)?;
        value["delivery"] = delivery;
        value["warnings"] = json!(warnings);
        Ok(value)
    }

    /// `work.board_update`: an imported board's own settings. `projectId`
    /// is where the board's agents work: an Orca repo or folder project. It
    /// becomes the project of every ticket that had none (or had the board's
    /// previous one), and of every ticket imported later. `null` clears it.
    pub(crate) fn do_work_board_update(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["boardId", "autoImportMine", "projectId"])?;
        let mut conn = self.db.lock().unwrap();
        let tx = conn.transaction().map_err(error::from_sqlite)?;
        let board = get_board(&tx, &required(params, "boardId")?)?;
        let now = crate::now_unix_ms() as i64;
        if let Some(project) = super::clearable(params, "projectId")? {
            let project = project.map(|p| resolve_project(&tx, &p)).transpose()?;
            tx.execute(
                "UPDATE work_tickets SET project_id = ?2, updated_at = ?4
                 WHERE board_id = ?1 AND (project_id IS NULL OR project_id IS ?3)",
                params![board.id, project, board.project_id, now],
            )
            .map_err(error::from_sqlite)?;
            tx.execute(
                "UPDATE work_boards SET project_id = ?2, updated_at = ?3 WHERE id = ?1",
                params![board.id, project, now],
            )
            .map_err(error::from_sqlite)?;
        }
        if let Some(on) = bool_field(params, "autoImportMine")? {
            tx.execute(
                "UPDATE work_boards SET auto_import_mine = ?2, updated_at = ?3 WHERE id = ?1",
                params![board.id, on as i64, now],
            )
            .map_err(error::from_sqlite)?;
        }
        let result = board_json(&tx, &get_board(&tx, &board.id)?)?;
        tx.commit().map_err(error::from_sqlite)?;
        Ok(result)
    }

    /// `work.board_delete`: removes an imported board and its tickets from
    /// Drogon (the provider is untouched).
    pub(crate) fn do_work_board_delete(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["boardId"])?;
        let mut conn = self.db.lock().unwrap();
        let board = get_board(&conn, &required(params, "boardId")?)?;
        let tx = conn.transaction().map_err(error::from_sqlite)?;
        let tickets: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM work_tickets WHERE board_id = ?1",
                params![board.id],
                |r| r.get(0),
            )
            .map_err(error::from_sqlite)?;
        for sql in [
            "DELETE FROM work_ticket_sessions WHERE ticket_id IN (SELECT id FROM work_tickets WHERE board_id = ?1)",
            "DELETE FROM work_ticket_sprints WHERE ticket_id IN (SELECT id FROM work_tickets WHERE board_id = ?1)",
            "DELETE FROM work_activity WHERE ticket_id IN (SELECT id FROM work_tickets WHERE board_id = ?1)",
            "DELETE FROM work_tickets WHERE board_id = ?1",
            "DELETE FROM work_columns WHERE board_id = ?1",
            "DELETE FROM work_sprints WHERE board_id = ?1",
            "DELETE FROM work_boards WHERE id = ?1",
        ] {
            tx.execute(sql, params![board.id])
                .map_err(error::from_sqlite)?;
        }
        tx.commit().map_err(error::from_sqlite)?;
        Ok(json!({ "deleted": board.id, "name": board.name, "tickets": tickets }))
    }

    /// Pushes one ticket's unsynced status and sprint to the provider.
    /// A refusal keeps the card where it is and records the provider's error.
    pub(super) fn push_ticket(&self, ticket_id: &str) -> Result<Value, RpcError> {
        let (ticket, board, columns) = {
            let conn = self.db.lock().unwrap();
            let ticket = get_ticket(&conn, ticket_id)?;
            let Some(board_id) = ticket.ext.board_id.clone() else {
                return Err(error::invalid_argument(format!(
                    "{} is a My work ticket; there is nothing to push",
                    ticket.key
                )));
            };
            let board = get_board(&conn, &board_id)?;
            let columns = list_columns(&conn, Some(&board_id))?;
            (ticket, board, columns)
        };
        let label = provider_label(&board.provider);
        let ext_key = ticket.ext.key.clone().unwrap_or_default();
        let sprint_pending = ticket.ext.sprint_id != ticket.ext.ext_sprint_id;
        if ticket.ext.pending_status_id.is_none() && !sprint_pending {
            return Ok(
                json!({ "ticketId": ticket.id, "key": ext_key, "pushed": false, "error": null, "nothing": true }),
            );
        }
        if ticket.ext.removed_at.is_some() {
            return Err(error::invalid_argument(format!(
                "{ext_key} is not in {label} anymore"
            )));
        }
        let provider = self.board_provider(&board)?;
        let issue = IssueRef {
            key: &ext_key,
            id: ticket.ext.id.as_deref(),
        };
        let mut failure: Option<String> = None;
        let mut pushed = Vec::new();
        if let Some(pending) = &ticket.ext.pending_status_id {
            match provider.set_status(&board.external_id, issue, pending) {
                Ok(()) => {
                    let name = status_name(&board, &columns, pending);
                    let category = board
                        .statuses
                        .iter()
                        .chain(columns.iter().flat_map(|c| c.statuses.iter()))
                        .find(|s| s.id == *pending)
                        .map(|s| s.category.clone());
                    let conn = self.db.lock().unwrap();
                    conn.execute(
                        "UPDATE work_tickets SET ext_status_id = ?2, ext_status_name = ?3, ext_status_category = ?4,
                           pending_status_id = NULL, status_conflict = 0, push_error = NULL WHERE id = ?1",
                        params![ticket.id, pending, name, category],
                    )
                    .map_err(error::from_sqlite)?;
                    log_activity(
                        &conn,
                        &ticket.id,
                        "pushed",
                        &format!("Pushed to {label}: status → {name}"),
                    );
                    pushed.push("status");
                }
                Err(err) => failure = Some(err.message),
            }
        }
        if failure.is_none() && sprint_pending {
            match provider.move_to_sprint(
                &board.external_id,
                issue,
                ticket.ext.sprint_id.as_deref(),
            ) {
                Ok(()) => {
                    let conn = self.db.lock().unwrap();
                    conn.execute(
                        "UPDATE work_tickets SET ext_sprint_id = sprint_id, push_error = NULL WHERE id = ?1",
                        params![ticket.id],
                    )
                    .map_err(error::from_sqlite)?;
                    let target = match &ticket.ext.sprint_id {
                        Some(id) => list_sprints(&conn, &board.id)?
                            .into_iter()
                            .find(|s| s.id == *id)
                            .map(|s| s.name)
                            .unwrap_or_else(|| id.clone()),
                        None => "the backlog".into(),
                    };
                    log_activity(
                        &conn,
                        &ticket.id,
                        "pushed",
                        &format!("Pushed to {label}: moved to {target}"),
                    );
                    pushed.push("sprint");
                }
                Err(err) => failure = Some(err.message),
            }
        }
        if let Some(message) = &failure {
            let conn = self.db.lock().unwrap();
            conn.execute(
                "UPDATE work_tickets SET push_error = ?2 WHERE id = ?1",
                params![ticket.id, message],
            )
            .map_err(error::from_sqlite)?;
            log_activity(
                &conn,
                &ticket.id,
                "push_failed",
                &format!("{label} refused the push: {message}"),
            );
        }
        Ok(json!({
            "ticketId": ticket.id,
            "key": ext_key,
            "pushed": failure.is_none(),
            "fields": pushed,
            "error": failure,
        }))
    }

    pub(crate) fn do_work_ticket_push(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["ticketId"])?;
        let id = {
            let conn = self.db.lock().unwrap();
            get_ticket(&conn, &required(params, "ticketId")?)?.id
        };
        let mut result = self.push_ticket(&id)?;
        let ticket = {
            let conn = self.db.lock().unwrap();
            get_ticket(&conn, &id)?
        };
        result["ticket"] = self.ticket_json(&ticket)?;
        Ok(result)
    }

    /// `work.board_push`: every unsynced move on the board.
    pub(crate) fn do_work_board_push(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["boardId"])?;
        let ids: Vec<String> = {
            let conn = self.db.lock().unwrap();
            let board = get_board(&conn, &required(params, "boardId")?)?;
            let mut stmt = conn
                .prepare(
                    "SELECT id FROM work_tickets WHERE board_id = ?1 AND removed_at IS NULL AND
                     (pending_status_id IS NOT NULL OR sprint_id IS NOT ext_sprint_id) ORDER BY updated_at",
                )
                .map_err(error::from_sqlite)?;
            stmt.query_map(params![board.id], |r| r.get(0))
                .map_err(error::from_sqlite)?
                .collect::<Result<_, _>>()
                .map_err(error::from_sqlite)?
        };
        let mut results = Vec::new();
        for id in ids {
            results.push(self.push_ticket(&id)?);
        }
        let failed = results.iter().filter(|r| r["pushed"] == false).count();
        Ok(json!({ "results": results, "pushed": results.len() - failed, "failed": failed }))
    }

    /// `work.ticket_resolve`: settles a status conflict — keep the
    /// provider's status (the card goes to its column) or push ours.
    pub(crate) fn do_work_ticket_resolve(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["ticketId", "keep"])?;
        let keep = required(params, "keep")?;
        let (ticket, enter) = {
            let conn = self.db.lock().unwrap();
            let ticket = get_ticket(&conn, &required(params, "ticketId")?)?;
            if ticket.ext.board_id.is_none() {
                return Err(error::invalid_argument(format!(
                    "{} is a My work ticket",
                    ticket.key
                )));
            }
            if ticket.ext.pending_status_id.is_none() {
                return Err(error::invalid_argument(format!(
                    "{} has no unsynced move to resolve",
                    ticket.ext.key.clone().unwrap_or(ticket.key.clone())
                )));
            }
            let board = get_board(&conn, ticket.ext.board_id.as_deref().unwrap())?;
            let label = provider_label(&board.provider);
            match keep.as_str() {
                "provider" | "theirs" | "remote" | "jira" | "linear" | "github" => {
                    conn.execute(
                        "UPDATE work_tickets SET pending_status_id = NULL, status_conflict = 0, push_error = NULL WHERE id = ?1",
                        params![ticket.id],
                    )
                    .map_err(error::from_sqlite)?;
                    let columns = list_columns(&conn, Some(&board.id))?;
                    let target = ticket
                        .ext
                        .status_id
                        .as_deref()
                        .and_then(|s| column_for_status(&columns, s))
                        .filter(|c| c.id != ticket.column_id)
                        .cloned();
                    let status = ticket.ext.status_name.clone().unwrap_or_default();
                    let enter = match &target {
                        Some(column) => {
                            relocate(&conn, &ticket, &column.id)?;
                            log_activity(
                                &conn,
                                &ticket.id,
                                "resolved",
                                &format!(
                                    "Kept {label}'s status {status}: moved to {}",
                                    column.name
                                ),
                            );
                            prompts_live(&conn, &ticket)?
                        }
                        None => {
                            log_activity(
                                &conn,
                                &ticket.id,
                                "resolved",
                                &format!("Kept {label}'s status {status}"),
                            );
                            false
                        }
                    };
                    (ticket, enter)
                }
                "ours" | "drogon" | "local" => {
                    conn.execute(
                        "UPDATE work_tickets SET status_conflict = 0 WHERE id = ?1",
                        params![ticket.id],
                    )
                    .map_err(error::from_sqlite)?;
                    drop(conn);
                    let result = self.push_ticket(&ticket.id)?;
                    let conn = self.db.lock().unwrap();
                    let fresh = get_ticket(&conn, &ticket.id)?;
                    drop(conn);
                    let mut value = self.ticket_json(&fresh)?;
                    value["push"] = result;
                    return Ok(value);
                }
                other => {
                    return Err(error::invalid_argument(format!(
                        "keep must be theirs (the source's status; also jira, linear, github) or ours, not {other}"
                    )));
                }
            }
        };
        let delivery = if enter {
            self.deliver_on_enter(&ticket.id)?
        } else {
            Value::Null
        };
        let fresh = {
            let conn = self.db.lock().unwrap();
            get_ticket(&conn, &ticket.id)?
        };
        let mut value = self.ticket_json(&fresh)?;
        value["delivery"] = delivery;
        Ok(value)
    }

    /// `work.ticket_sprint`: carry a ticket over to the active sprint or
    /// send it to the backlog. Unsynced until pushed, like a status move.
    pub(crate) fn do_work_ticket_sprint(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["ticketId", "to"])?;
        let to = required(params, "to")?;
        let ticket = {
            let conn = self.db.lock().unwrap();
            let ticket = get_ticket(&conn, &required(params, "ticketId")?)?;
            let Some(board_id) = ticket.ext.board_id.clone() else {
                return Err(error::invalid_argument(format!(
                    "{} is a My work ticket; it has no sprint",
                    ticket.key
                )));
            };
            let board = get_board(&conn, &board_id)?;
            if board.kind != "scrum" {
                return Err(error::invalid_argument(format!(
                    "{} is a kanban board; it has no sprints",
                    board.name
                )));
            }
            let sprints = list_sprints(&conn, &board_id)?;
            let (target, text) = match to.as_str() {
                "backlog" => (None, "Sent to the backlog".to_string()),
                "active" => {
                    let active = active_sprint(&sprints).ok_or_else(|| {
                        error::invalid_argument(format!("{} has no active sprint", board.name))
                    })?;
                    (
                        Some(active.id.clone()),
                        format!("Carried over to {}", active.name),
                    )
                }
                other => {
                    let sprint = sprints
                        .iter()
                        .find(|s| s.id == other || s.name.eq_ignore_ascii_case(other))
                        .ok_or_else(|| {
                            error::not_found(format!("{} has no sprint {other}", board.name))
                        })?;
                    if sprint.state == "closed" {
                        return Err(error::invalid_argument(format!(
                            "{} is closed; it takes no issues",
                            sprint.name
                        )));
                    }
                    (Some(sprint.id.clone()), format!("Moved to {}", sprint.name))
                }
            };
            if target == ticket.ext.sprint_id {
                return Err(error::invalid_argument(format!(
                    "{} is already {}",
                    ticket.ext.key.clone().unwrap_or(ticket.key.clone()),
                    if target.is_some() {
                        "in that sprint"
                    } else {
                        "in the backlog"
                    }
                )));
            }
            conn.execute(
                "UPDATE work_tickets SET sprint_id = ?2, push_error = NULL, updated_at = ?3 WHERE id = ?1",
                params![ticket.id, target, crate::now_unix_ms() as i64],
            )
            .map_err(error::from_sqlite)?;
            let synced = target == ticket.ext.ext_sprint_id;
            log_activity(
                &conn,
                &ticket.id,
                "sprint",
                &if synced {
                    format!("{text} (matches {})", provider_label(&board.provider))
                } else {
                    format!("{text}; not synced to {}", provider_label(&board.provider))
                },
            );
            get_ticket(&conn, &ticket.id)?
        };
        self.ticket_json(&ticket)
    }

    /// `work.ticket_session_start`: a new session in the ticket's
    /// workspace, linked to the ticket (the normal harness start).
    pub(crate) fn do_work_ticket_session_start(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["ticketId", "harnessId", "prompt"])?;
        let ticket = {
            let conn = self.db.lock().unwrap();
            get_ticket(&conn, &required(params, "ticketId")?)?
        };
        let workspace = if let Some(workspace) = self.configured_ticket_workspace(&ticket)? {
            workspace
        } else if let Some(workspace) = self.ticket_own_workspace(&ticket)? {
            workspace
        } else {
            self.ticket_workspace(&ticket)?.ok_or_else(|| {
                error::invalid_argument(format!(
                    "{} has no workspace or project to start a session in: choose where the board's agents work (Agents work in), or set the ticket's project",
                    ticket.key
                ))
            })?
        };
        let harness = match str_field(params, "harnessId")? {
            Some(h) => validate_harness(h)?,
            None => {
                let column = {
                    let conn = self.db.lock().unwrap();
                    get_column(&conn, &ticket.column_id)?
                };
                self.default_harness(&column)
            }
        };
        let prompt = str_field(params, "prompt")?
            .filter(|p| !p.trim().is_empty())
            .map(|p| bounded_text(p, "prompt", MAX_MESSAGE, false))
            .transpose()?;
        let key = ticket.ext.key.clone().unwrap_or_else(|| ticket.key.clone());
        let launched = self.start_agent(crate::sessions::StartRequest {
            workspace_id: &workspace,
            harness_id: &harness,
            prompt: prompt.as_deref(),
            resume_of: None,
            title: Some(format!("{key} · {harness}")),
        })?;
        let new_id = launched["id"].as_str().unwrap_or_default().to_string();
        {
            let conn = self.db.lock().unwrap();
            link_session_in(&conn, &ticket.id, &new_id)?;
            if ticket.workspace_id.as_deref() != Some(workspace.as_str()) {
                conn.execute(
                    "UPDATE work_tickets SET workspace_id = ?2 WHERE id = ?1",
                    params![ticket.id, workspace],
                )
                .map_err(error::from_sqlite)?;
            }
            log_activity(
                &conn,
                &ticket.id,
                "session",
                &format!("Started a {harness} session"),
            );
        }
        let fresh = {
            let conn = self.db.lock().unwrap();
            get_ticket(&conn, &ticket.id)?
        };
        let mut value = self.ticket_json(&fresh)?;
        value["session"] = launched;
        Ok(value)
    }

    /// The ticket's own workspace, where its sessions start: the one made
    /// for it earlier, else a new one in its project — a worktree of a git
    /// project, a named workspace over a folder project's folder — shown in
    /// the sidebar under the project. `None` without a project (the caller
    /// then uses the ticket's workspace, if any).
    pub(super) fn ticket_own_workspace(&self, ticket: &Ticket) -> Result<Option<String>, RpcError> {
        // Still there, not archived, and in the ticket's current project (a
        // board moved to another project starts fresh there).
        let existing = {
            let conn = self.db.lock().unwrap();
            conn.query_row(
                "SELECT t.workspace_id FROM work_ticket_workspaces t JOIN worktrees w ON w.workspace_id = t.workspace_id
                 WHERE t.ticket_id = ?1 AND w.is_archived = 0 AND w.project_id IS ?2",
                params![ticket.id, ticket.project_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(error::from_sqlite)?
        };
        if existing.is_some() {
            return Ok(existing);
        }
        let Some(project_id) = &ticket.project_id else {
            return Ok(None);
        };
        let kind = {
            let conn = self.db.lock().unwrap();
            conn.query_row(
                "SELECT kind FROM projects WHERE id = ?1",
                params![project_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(error::from_sqlite)?
            .ok_or_else(|| error::not_found(format!("project {project_id} not found")))?
        };
        // Named by the key the owner reads on the card: the provider's
        // (FT-19018), else Drogon's own.
        let key = ticket.ext.key.as_deref().unwrap_or(&ticket.key);
        let name = if kind == "git" {
            ticket_worktree_slug(key, &ticket.title)
        } else {
            ticket_workspace_title(key, &ticket.title)
        };
        if kind == "folder-group" {
            return self.ticket_folder_workspace(ticket, project_id).map(Some);
        }
        if kind != "git" {
            // An Orca folder repo has one checkout: the ticket works there.
            return Ok(None);
        }
        // The name may be taken (an archived worktree keeps its branch):
        // the next free `-2`, `-3`… takes it.
        let mut attempt = 1;
        let created = loop {
            let candidate = if attempt == 1 {
                name.clone()
            } else {
                format!("{name}-{attempt}")
            };
            match self
                .orca
                .worktree_create(project_id, &candidate, &format!("Sessions for {key}"))
            {
                Ok(created) => break created,
                Err(e) if attempt < 6 && e.message.contains("exist") => attempt += 1,
                Err(e) => return Err(e),
            }
        };
        let workspace = created["id"]
            .as_str()
            .ok_or_else(|| error::internal_error("the new worktree has no id"))?
            .to_string();
        self.refresh_mirror(true);
        let conn = self.db.lock().unwrap();
        conn.execute(
            "INSERT INTO work_ticket_workspaces (ticket_id, workspace_id) VALUES (?1, ?2)
             ON CONFLICT(ticket_id) DO UPDATE SET workspace_id = excluded.workspace_id",
            params![ticket.id, workspace],
        )
        .map_err(error::from_sqlite)?;
        log_activity(
            &conn,
            &ticket.id,
            "session",
            &format!("Made a workspace for this ticket: {name}"),
        );
        Ok(Some(workspace))
    }

    /// A folder project's ticket works in its own folder workspace, the way
    /// Orca users keep one per ticket: one already named for the ticket's
    /// key (`MODPRESALE-1149`, `MODPRESALE-1149-…`, `MODPRESALE-1149 …`), else
    /// a new one named `<key> <title>`.
    fn ticket_folder_workspace(
        &self,
        ticket: &Ticket,
        project_id: &str,
    ) -> Result<String, RpcError> {
        let key = ticket.ext.key.as_deref().unwrap_or(&ticket.key).to_string();
        let named = {
            let conn = self.db.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT id, name FROM workspaces WHERE project_id = ?1 AND is_archived = 0
                     ORDER BY id",
                )
                .map_err(error::from_sqlite)?;
            let rows = stmt
                .query_map(params![project_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(error::from_sqlite)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(error::from_sqlite)?;
            rows.into_iter()
                .find(|(_, name)| names_ticket(name, &key))
                .map(|(id, _)| id)
        };
        let workspace = match named {
            Some(id) => id,
            None => {
                let title: String = ticket.title.chars().take(80).collect();
                let name = format!("{key} {}", title.trim()).trim().to_string();
                let id = self.orca.folder_workspace_create(project_id, &name).map_err(|e| {
                    if e.code == "orca_unsupported" {
                        error::invalid_argument(format!(
                            "{key} has no folder workspace in this folder project, and this Orca cannot make one for the board: create one named {key} in Orca, or link a session"
                        ))
                    } else {
                        e
                    }
                })?;
                self.refresh_mirror(true);
                let conn = self.db.lock().unwrap();
                log_activity(
                    &conn,
                    &ticket.id,
                    "session",
                    &format!("Made a folder workspace for this ticket: {name}"),
                );
                id
            }
        };
        let conn = self.db.lock().unwrap();
        conn.execute(
            "INSERT INTO work_ticket_workspaces (ticket_id, workspace_id) VALUES (?1, ?2)
             ON CONFLICT(ticket_id) DO UPDATE SET workspace_id = excluded.workspace_id",
            params![ticket.id, workspace],
        )
        .map_err(error::from_sqlite)?;
        Ok(workspace)
    }

    /// `work.ticket_session_rename`: the name a linked session goes by on
    /// this ticket (empty restores the session's own title).
    pub(crate) fn do_work_ticket_session_rename(&self, params: &Value) -> Result<Value, RpcError> {
        reject_unknown(params, &["ticketId", "sessionId", "title"])?;
        let ticket = {
            let conn = self.db.lock().unwrap();
            let ticket = get_ticket(&conn, &required(params, "ticketId")?)?;
            let title = str_field(params, "title")?
                .map(|t| bounded_text(t, "title", MAX_NAME, true))
                .transpose()?
                .filter(|t| !t.is_empty());
            let changed = conn
                .execute(
                    "UPDATE work_ticket_sessions SET label = ?3 WHERE ticket_id = ?1 AND session_id = ?2",
                    params![ticket.id, required(params, "sessionId")?, title],
                )
                .map_err(error::from_sqlite)?;
            if changed == 0 {
                return Err(error::not_found(
                    "that session is not linked to this ticket",
                ));
            }
            ticket
        };
        self.ticket_json(&ticket)
    }

    /// Scheduled sync: each imported board every [`SYNC_INTERVAL_MS`].
    pub(super) fn tick_work_sync(&self, now: i64) {
        let boards = {
            let conn = self.db.lock().unwrap();
            list_boards(&conn).unwrap_or_default()
        };
        for board in boards {
            // A source the owner turned off is left alone, not failed.
            if !self.source_enabled(&board.provider)
                || board
                    .last_synced_at
                    .is_some_and(|at| now - at < SYNC_INTERVAL_MS)
            {
                continue;
            }
            if let Err(err) = self.sync_board(&board) {
                eprintln!("[work] sync of {} failed: {}", board.name, err.message);
            }
        }
    }
}

/// A git worktree (and branch) name for a ticket: its key and title in
/// lowercase words joined by `-`, at most 60 characters.
pub(super) fn ticket_worktree_slug(key: &str, title: &str) -> String {
    let mut slug = String::new();
    for c in format!("{key} {title}").chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let mut slug: String = slug.chars().take(60).collect();
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "ticket".to_string()
    } else {
        slug
    }
}

/// A folder workspace's sidebar title for a ticket: `KEY · Title`.
pub(super) fn ticket_workspace_title(key: &str, title: &str) -> String {
    let title = title.trim();
    let text = if title.is_empty() {
        key.to_string()
    } else {
        format!("{key} · {title}")
    };
    text.chars().take(80).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_icons_follow_status_names_and_categories() {
        assert_eq!(icon_for("To Do", "new"), "todo");
        assert_eq!(icon_for("In Progress", "indeterminate"), "in_progress");
        assert_eq!(icon_for("Code Review", "indeterminate"), "review");
        assert_eq!(icon_for("QA", "indeterminate"), "qa");
        assert_eq!(icon_for("Testing", "indeterminate"), "qa");
        assert_eq!(icon_for("Blocked", "indeterminate"), "blocked");
        assert_eq!(icon_for("Backlog", "new"), "backlog");
        assert_eq!(icon_for("Shipped", "done"), "done");
        assert_eq!(icon_for("Doing", ""), "in_progress");
    }

    #[test]
    fn unused_columns_start_collapsed() {
        for name in ["Canceled", "Cancelled", "Duplicate", "Won't Do", "Archived"] {
            assert!(starts_collapsed(name), "{name}");
        }
        for name in ["Done", "In Review", "Backlog", "Todo"] {
            assert!(!starts_collapsed(name), "{name}");
        }
    }

    #[test]
    fn ticket_workspaces_are_named_after_the_ticket() {
        assert_eq!(
            ticket_worktree_slug("FT-19018", "S20 MR Reviews — Carlos"),
            "ft-19018-s20-mr-reviews-carlos"
        );
        assert_eq!(ticket_worktree_slug("", "  "), "ticket");
        let long = ticket_worktree_slug("APP-1", &"word ".repeat(40));
        assert!(long.len() <= 60 && !long.ends_with('-'), "{long}");
        assert_eq!(
            ticket_workspace_title("FT-19018", " S20 MR Reviews — Carlos "),
            "FT-19018 · S20 MR Reviews — Carlos"
        );
        assert_eq!(ticket_workspace_title("FT-1", ""), "FT-1");
    }

    #[test]
    fn clip_bounds_by_characters() {
        assert_eq!(clip("  héllo  ", 3), "hél");
        assert_eq!(clip("ok", 10), "ok");
    }
}

/// Whether a folder workspace's name is for the ticket `key`: the key alone
/// or followed by a separator (`MODPRESALE-1149-fix`, `MODPRESALE-1149 Fix`),
/// never a longer key (`MODPRESALE-11490`).
pub(super) fn names_ticket(name: &str, key: &str) -> bool {
    let name = name.trim();
    if name.len() < key.len() || !name.is_char_boundary(key.len()) {
        return false;
    }
    let (head, rest) = name.split_at(key.len());
    head.eq_ignore_ascii_case(key)
        && rest
            .chars()
            .next()
            .is_none_or(|c| !c.is_ascii_alphanumeric())
}

#[cfg(test)]
mod folder_workspace_name_tests {
    use super::names_ticket;

    #[test]
    fn a_folder_workspace_is_the_tickets_by_its_key() {
        assert!(names_ticket("MODPRESALE-1149", "MODPRESALE-1149"));
        assert!(names_ticket(
            "MODPRESALE-1047-mixed-schedules",
            "MODPRESALE-1047"
        ));
        assert!(names_ticket("modpresale-796 Fix totals", "MODPRESALE-796"));
        assert!(!names_ticket("MODPRESALE-11490", "MODPRESALE-1149"));
        assert!(!names_ticket("Landing page", "MODPRESALE-1149"));
        assert!(!names_ticket("MOD", "MODPRESALE-1149"));
    }
}
