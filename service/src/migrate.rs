//! Bringing a Drogon Work board over to Orca.
//!
//! The board's tables are Drogon's own, so columns, tickets, imported
//! boards, sprints, sends and activity copy over as they are. What changes
//! is what they point at:
//!
//! - a Drogon project becomes the Orca repo at the same path;
//! - a Drogon workspace becomes the Orca worktree at the same path;
//! - a Drogon agent session becomes a stopped board session in that
//!   worktree carrying the agent's own conversation id, so opening it (or a
//!   column prompt) resumes the same conversation in an Orca terminal.
//!
//! Anything without a counterpart in Orca is cleared and reported (add the
//! folder to Orca and pick it again). The Jira, Linear and GitHub
//! connections (sealed tokens and their key) are copied too. Drogon's
//! database is opened read-only and never changed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};

use crate::engine::Engine;
use crate::error;
use crate::protocol::RpcError;

const DROGON_DB: &str = "drogon.sqlite3";
const MIGRATED_KEY: &str = "migrated_from_drogon";

/// Tables copied as-is (their ids stay Drogon's; references are remapped).
const WORK_TABLES: &[&str] = &[
    "work_columns",
    "work_tickets",
    "work_key_counters",
    "work_sends",
    "work_boards",
    "work_sprints",
    "work_ticket_sprints",
    "work_activity",
    "work_sources",
];

fn default_drogon_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("Drogon")
    })
}

fn open_drogon(dir: &Path) -> Result<Connection, RpcError> {
    let path = dir.join(DROGON_DB);
    if !path.is_file() {
        return Err(error::not_found(format!(
            "no Drogon board at {}",
            dir.display()
        )));
    }
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| error::internal_error(format!("cannot open Drogon's database: {e}")))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(error::from_sqlite)?;
    Ok(conn)
}

fn has_table(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

fn columns_of(conn: &Connection, table: &str) -> Result<Vec<String>, RpcError> {
    conn.prepare(&format!("PRAGMA table_info({table})"))
        .and_then(|mut s| s.query_map([], |r| r.get::<_, String>(1))?.collect())
        .map_err(error::from_sqlite)
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0)
}

/// Copies a directory's files (not recursively), keeping 0600 modes.
fn copy_dir(from: &Path, to: &Path) -> Result<usize, RpcError> {
    let Ok(entries) = std::fs::read_dir(from) else {
        return Ok(0);
    };
    std::fs::create_dir_all(to).map_err(|e| error::internal_error(e.to_string()))?;
    let mut copied = 0;
    for entry in entries.flatten() {
        if entry.path().is_file() {
            let data =
                std::fs::read(entry.path()).map_err(|e| error::internal_error(e.to_string()))?;
            crate::integrations::seal::write_file_600(&to.join(entry.file_name()), &data)
                .map_err(error::internal_error)?;
            copied += 1;
        }
    }
    Ok(copied)
}

impl Engine {
    fn drogon_dir(params: &Value) -> Result<PathBuf, RpcError> {
        match params["drogonDataDir"].as_str() {
            Some(dir) if !dir.trim().is_empty() => Ok(PathBuf::from(dir.trim())),
            _ => default_drogon_dir()
                .ok_or_else(|| error::invalid_argument("drogonDataDir is required")),
        }
    }

    /// `board.migration_status`: whether a Drogon board is there to bring
    /// over, how big it is, and whether it was brought over already.
    pub(crate) fn migration_status(&self, params: &Value) -> Result<Value, RpcError> {
        let migrated: Option<String> = {
            let conn = self.db.lock().unwrap();
            conn.query_row(
                "SELECT value FROM board_meta WHERE key = ?1",
                params![MIGRATED_KEY],
                |r| r.get(0),
            )
            .optional()
            .map_err(error::from_sqlite)?
        };
        let dir = Self::drogon_dir(params).ok();
        let found = dir
            .as_ref()
            .and_then(|d| open_drogon(d).ok().map(|c| (d.clone(), c)));
        let (tickets, boards) = match &found {
            Some((_, conn)) if has_table(conn, "work_tickets") => (
                count(conn, "SELECT COUNT(*) FROM work_tickets"),
                count(conn, "SELECT COUNT(*) FROM work_boards"),
            ),
            _ => (0, 0),
        };
        Ok(json!({
            "drogonDataDir": found.as_ref().map(|(d, _)| d.to_string_lossy().to_string()),
            "drogonTickets": tickets,
            "drogonBoards": boards,
            "migrated": migrated.and_then(|m| serde_json::from_str::<Value>(&m).ok()),
        }))
    }

    /// `board.migrate_from_drogon`: brings a Drogon Work board over. Refuses
    /// over a board that already has tickets unless `replace` is true.
    pub(crate) fn migrate_from_drogon(&self, params: &Value) -> Result<Value, RpcError> {
        let dir = Self::drogon_dir(params)?;
        let replace = params["replace"] == true;
        let source = open_drogon(&dir)?;
        if !has_table(&source, "work_tickets") {
            return Err(error::not_found("that Drogon has no Work board"));
        }
        self.refresh_mirror(true);
        self.refresh_live(true);

        // Drogon id → path, for projects and workspaces.
        let drogon_paths = |sql: &str| -> Result<HashMap<String, String>, RpcError> {
            source
                .prepare(sql)
                .and_then(|mut s| {
                    s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                        .collect()
                })
                .map_err(error::from_sqlite)
        };
        let project_paths = if has_table(&source, "projects") {
            drogon_paths("SELECT id, path FROM projects")?
        } else {
            HashMap::new()
        };
        let workspace_paths = drogon_paths("SELECT id, path FROM workspaces")?;

        let conn = self.db.lock().unwrap();
        let existing = count(&conn, "SELECT COUNT(*) FROM work_tickets");
        if existing > 0 && !replace {
            return Err(error::invalid_argument(format!(
                "this board already has {existing} tickets; pass replace to overwrite them with Drogon's"
            )));
        }
        // Orca path → id (paths compared canonically: /tmp vs /private/tmp).
        let canonical = |p: &str| {
            std::fs::canonicalize(p)
                .map(|c| c.to_string_lossy().to_string())
                .unwrap_or_else(|_| p.to_string())
        };
        let orca_ids = |sql: &str| -> Result<HashMap<String, String>, RpcError> {
            let rows: Vec<(String, String)> = conn
                .prepare(sql)
                .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
                .map_err(error::from_sqlite)?;
            Ok(rows
                .into_iter()
                .map(|(id, path)| (canonical(&path), id))
                .collect())
        };
        let orca_repos = orca_ids("SELECT id, path FROM projects")?;
        let orca_worktrees = orca_ids("SELECT id, path FROM workspaces")?;
        // Only projects the board uses are worth reporting when Orca lacks them.
        let used: std::collections::HashSet<String> = source
            .prepare(
                "SELECT project_id FROM work_tickets WHERE project_id IS NOT NULL
                 UNION SELECT project_id FROM work_boards WHERE project_id IS NOT NULL",
            )
            .and_then(|mut st| st.query_map([], |r| r.get::<_, String>(0))?.collect())
            .map_err(error::from_sqlite)?;
        let mut unmapped: Vec<String> = Vec::new();
        let mut project_map: HashMap<String, Option<String>> = HashMap::new();
        for (id, path) in &project_paths {
            let mapped = orca_repos.get(&canonical(path)).cloned();
            if mapped.is_none() && used.contains(id) {
                unmapped.push(path.clone());
            }
            project_map.insert(id.clone(), mapped);
        }
        let mut workspace_map: HashMap<String, Option<String>> = HashMap::new();
        for (id, path) in &workspace_paths {
            workspace_map.insert(id.clone(), orca_worktrees.get(&canonical(path)).cloned());
        }

        let tx = conn.unchecked_transaction().map_err(error::from_sqlite)?;
        let mut copied: HashMap<&str, i64> = HashMap::new();
        for table in WORK_TABLES {
            if !has_table(&source, table) {
                continue;
            }
            tx.execute(&format!("DELETE FROM {table}"), [])
                .map_err(error::from_sqlite)?;
            let theirs = columns_of(&source, table)?;
            let ours = columns_of(&tx, table)?;
            let shared: Vec<&String> = theirs.iter().filter(|c| ours.contains(c)).collect();
            let list = shared
                .iter()
                .map(|c| c.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            let marks = (1..=shared.len())
                .map(|i| format!("?{i}"))
                .collect::<Vec<_>>()
                .join(", ");
            let mut read = source
                .prepare(&format!("SELECT {list} FROM {table}"))
                .map_err(error::from_sqlite)?;
            let mut rows = read.query([]).map_err(error::from_sqlite)?;
            let mut n = 0;
            while let Some(row) = rows.next().map_err(error::from_sqlite)? {
                let mut values: Vec<rusqlite::types::Value> = (0..shared.len())
                    .map(|i| row.get::<_, rusqlite::types::Value>(i))
                    .collect::<Result<_, _>>()
                    .map_err(error::from_sqlite)?;
                for (i, column) in shared.iter().enumerate() {
                    let remap = match (*table, column.as_str()) {
                        (_, "project_id") => Some(&project_map),
                        ("work_tickets", "workspace_id") => Some(&workspace_map),
                        _ => None,
                    };
                    if let (Some(map), rusqlite::types::Value::Text(id)) = (remap, &values[i]) {
                        values[i] = match map.get(id).cloned().flatten() {
                            Some(mapped) => rusqlite::types::Value::Text(mapped),
                            None => rusqlite::types::Value::Null,
                        };
                    }
                }
                tx.execute(
                    &format!("INSERT OR REPLACE INTO {table} ({list}) VALUES ({marks})"),
                    rusqlite::params_from_iter(values),
                )
                .map_err(error::from_sqlite)?;
                n += 1;
            }
            copied.insert(table, n);
        }

        // Each ticket's own workspace, where it was mapped.
        tx.execute("DELETE FROM work_ticket_workspaces", [])
            .map_err(error::from_sqlite)?;
        if has_table(&source, "work_ticket_workspaces") {
            let pairs: Vec<(String, String)> = source
                .prepare("SELECT ticket_id, workspace_id FROM work_ticket_workspaces")
                .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
                .map_err(error::from_sqlite)?;
            for (ticket, workspace) in pairs {
                if let Some(Some(mapped)) = workspace_map.get(&workspace) {
                    tx.execute("INSERT OR REPLACE INTO work_ticket_workspaces (ticket_id, workspace_id) VALUES (?1, ?2)", params![ticket, mapped])
                        .map_err(error::from_sqlite)?;
                }
            }
        }

        // Linked sessions: an agent session in a mapped worktree comes over
        // as a stopped board session that resumes its conversation.
        tx.execute("DELETE FROM work_ticket_sessions", [])
            .map_err(error::from_sqlite)?;
        let links: Vec<(String, String, i64, Option<String>)> = source
            .prepare("SELECT ticket_id, session_id, linked_at, label FROM work_ticket_sessions")
            .and_then(|mut s| {
                s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                    .collect()
            })
            .map_err(error::from_sqlite)?;
        let mut sessions_brought = 0;
        let mut sessions_dropped = 0;
        for (ticket, session, linked_at, label) in links {
            let found: Option<(String, Option<String>, Option<String>)> = source
                .query_row(
                    "SELECT workspace_id, harness_id, agent_session_id FROM sessions WHERE id = ?1",
                    params![session],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(error::from_sqlite)?;
            let Some((workspace, Some(harness), agent_session)) = found else {
                sessions_dropped += 1;
                continue;
            };
            let Some(Some(worktree)) = workspace_map.get(&workspace) else {
                sessions_dropped += 1;
                continue;
            };
            let id = format!("drogon-{session}");
            tx.execute(
                "INSERT OR IGNORE INTO sessions (id, workspace_id, harness_id, agent_session_id, title, verdict, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'exited', ?6)",
                params![id, worktree, harness, agent_session, label, linked_at],
            )
            .map_err(error::from_sqlite)?;
            tx.execute(
                "INSERT OR IGNORE INTO work_ticket_sessions (ticket_id, session_id, linked_at, label) VALUES (?1, ?2, ?3, ?4)",
                params![ticket, id, linked_at, label],
            )
            .map_err(error::from_sqlite)?;
            sessions_brought += 1;
        }
        unmapped.sort();
        unmapped.dedup();
        let summary = json!({
            "from": dir.to_string_lossy(),
            "at": crate::now_unix_ms() as i64,
            "tickets": copied.get("work_tickets").copied().unwrap_or(0),
            "columns": copied.get("work_columns").copied().unwrap_or(0),
            "boards": copied.get("work_boards").copied().unwrap_or(0),
            "sessions": sessions_brought,
            "sessionsDropped": sessions_dropped,
            "unmappedProjects": unmapped,
        });
        tx.execute(
            "INSERT OR REPLACE INTO board_meta (key, value) VALUES (?1, ?2)",
            params![MIGRATED_KEY, summary.to_string()],
        )
        .map_err(error::from_sqlite)?;
        tx.commit().map_err(error::from_sqlite)?;
        drop(conn);

        let mut summary = summary;
        summary["connections"] = json!({
            "work": copy_dir(&dir.join("integrations").join("work"), &self.data_dir.join("integrations").join("work"))?,
            "jira": copy_dir(&dir.join("integrations").join("jira"), &self.data_dir.join("integrations").join("jira"))?,
        });
        Ok(summary)
    }
}
