//! The board engine: its SQLite store, the Orca mirror (projects =
//! Orca repos, workspaces = Orca worktrees, sessions = Orca terminals the
//! board knows), and the `work.*` method table the web UI calls.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use crate::error;
use crate::jira::JiraState;
use crate::orca::{Agent, Orca, Terminal};
use crate::protocol::RpcError;

pub const DB_FILE: &str = "work-board.db";
/// How long a read of Orca's terminals and agents stays fresh.
pub(crate) const LIVE_TTL: Duration = Duration::from_millis(1500);
/// How long the repo/worktree mirror stays fresh.
const MIRROR_TTL: Duration = Duration::from_secs(5);

/// The last read of Orca's live terminals and their agents.
#[derive(Default)]
pub struct LiveView {
    pub read_at: Option<Instant>,
    pub terminals: HashMap<String, Terminal>,
    /// Agents by pane key (`tabId:leafId`).
    pub agents: HashMap<String, Agent>,
    /// Orca could not be read: liveness is unverifiable, never "exited".
    pub error: Option<String>,
}

pub struct Engine {
    pub db: Mutex<Connection>,
    pub data_dir: PathBuf,
    pub jira: JiraState,
    pub orca: Orca,
    pub(crate) live: Mutex<LiveView>,
    mirror_read_at: Mutex<Option<Instant>>,
    quiescent: AtomicBool,
    board_cli: Mutex<Option<PathBuf>>,
}

impl Engine {
    pub fn open(data_dir: &Path, orca: Orca) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir)
            .map_err(|e| format!("cannot create {}: {e}", data_dir.display()))?;
        let mut conn = Connection::open(data_dir.join(DB_FILE)).map_err(|e| e.to_string())?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        let previous = conn
            .query_row(
                "SELECT version FROM schema_versions WHERE component = 'work'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .ok();
        if previous.is_some_and(|version| version < crate::work::SCHEMA_VERSION) {
            let backup = data_dir.join(format!(
                "work-board-before-v{}-{}.db",
                crate::work::SCHEMA_VERSION,
                uuid::Uuid::new_v4()
            ));
            conn.execute("VACUUM INTO ?1", params![backup.to_string_lossy().as_ref()])
                .map_err(|e| format!("cannot back up board before schema upgrade: {e}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&backup, std::fs::Permissions::from_mode(0o600))
                    .map_err(|e| e.to_string())?;
            }
        }
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        apply_mirror_schema(&tx).map_err(|e| e.to_string())?;
        crate::work::apply_pending_steps_in_tx(&tx).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(Self {
            db: Mutex::new(conn),
            data_dir: data_dir.to_path_buf(),
            jira: JiraState::new(data_dir),
            orca,
            live: Mutex::new(LiveView::default()),
            mirror_read_at: Mutex::new(None),
            quiescent: AtomicBool::new(false),
            board_cli: Mutex::new(None),
        })
    }

    /// Where the `work-board` launcher is, for `{board.cli}` in prompts.
    pub fn set_board_cli(&self, path: PathBuf) {
        *self.board_cli.lock().unwrap() = Some(path);
    }

    /// `{board.cli}`: the launcher's path as one shell word.
    pub(crate) fn board_cli_word(&self) -> String {
        match &*self.board_cli.lock().unwrap() {
            Some(path) => crate::sessions::shell_quote(&path.to_string_lossy()),
            None => "work-board".to_string(),
        }
    }

    pub fn is_quiescent(&self) -> bool {
        self.quiescent.load(Ordering::Acquire)
    }

    pub fn quiesce(&self) {
        self.quiescent.store(true, Ordering::Release);
    }

    /// One `work.*` (or `orca.*`) call from the UI.
    pub fn dispatch(&self, method: &str, params: &Value) -> Result<Value, RpcError> {
        if method != "work.sources" && method.starts_with("work.") {
            // Every board read resolves projects and workspaces by id.
            self.refresh_mirror(false);
        }
        match method {
            "work.board" => self.work_board(params),
            "work.ticket_show" => self.work_ticket_show(params),
            "work.sends" => self.work_sends(params),
            "work.column_preview" => self.work_column_preview(params),
            "work.column_create" => self.do_work_column_create(params),
            "work.column_update" => self.do_work_column_update(params),
            "work.column_delete" => self.do_work_column_delete(params),
            "work.column_send" => self.do_work_column_send(params),
            "work.ticket_create" => self.do_work_ticket_create(params),
            "work.ticket_update" => self.do_work_ticket_update(params),
            "work.ticket_move" => self.do_work_ticket_move(params),
            "work.ticket_delete" => self.do_work_ticket_delete(params),
            "work.ticket_link_session" => self.do_work_ticket_link_session(params),
            "work.ticket_unlink_session" => self.do_work_ticket_unlink_session(params),
            "work.session_open" => self.do_work_session_open(params),
            "work.provider_boards" => self.work_provider_boards(params),
            "work.import_preview" => self.work_import_preview(params),
            "work.board_import" => self.do_work_board_import(params),
            "work.board_sync" => self.do_work_board_sync(params),
            "work.board_push" => self.do_work_board_push(params),
            "work.board_delete" => self.do_work_board_delete(params),
            "work.board_update" => self.do_work_board_update(params),
            "work.create_options" => self.work_create_options(params),
            "work.ticket_push" => self.do_work_ticket_push(params),
            "work.ticket_resolve" => self.do_work_ticket_resolve(params),
            "work.ticket_sprint" => self.do_work_ticket_sprint(params),
            "work.ticket_session_start" => self.do_work_ticket_session_start(params),
            "work.ticket_session_rename" => self.do_work_ticket_session_rename(params),
            "work.sources" => self.work_sources(params),
            "work.source_update" => self.do_work_source_update(params),
            "work.source_connect" => self.work_source_connect(params),
            "work.source_disconnect" => self.do_work_source_disconnect(params),
            "orca.workspaces" => self.orca_workspaces(),
            "orca.sessions" => self.orca_sessions(params),
            "orca.session_focus" => self.orca_session_focus(params),
            "board.status" => Ok(json!({ "version": env!("CARGO_PKG_VERSION") })),
            "board.migration_status" => self.migration_status(params),
            "board.migrate_from_drogon" => self.migrate_from_drogon(params),
            _ => Err(error::method_not_found(method)),
        }
    }

    // ----------------------------------------------------------- mirror --

    /// Re-reads Orca's repos and worktrees into `projects`, `workspaces`
    /// and `worktrees` (rows Orca no longer lists are dropped). Throttled
    /// unless forced; a failed read keeps the previous mirror.
    pub fn refresh_mirror(&self, force: bool) {
        {
            let read = self.mirror_read_at.lock().unwrap();
            if !force && read.is_some_and(|at| at.elapsed() < MIRROR_TTL) {
                return;
            }
        }
        let (repos, worktrees) = match (self.orca.repos(), self.orca.worktrees()) {
            (Ok(r), Ok(w)) => (r, w),
            (Err(e), _) | (_, Err(e)) => {
                eprintln!(
                    "[work-board] cannot read Orca repos/worktrees: {}",
                    e.message
                );
                return;
            }
        };
        // Folder projects (`pre-sales`) and their folder workspaces sit beside
        // repos in Orca; an Orca that cannot list them keeps the rest working.
        let folder_workspaces = self.orca.folder_workspaces().unwrap_or_else(|e| {
            eprintln!(
                "[work-board] cannot read Orca folder workspaces: {}",
                e.message
            );
            Vec::new()
        });
        let folder_projects = self.orca.folder_projects(&folder_workspaces);
        let conn = self.db.lock().unwrap();
        let result = (|| -> rusqlite::Result<()> {
            let tx = conn.unchecked_transaction()?;
            tx.execute("DELETE FROM projects", [])?;
            tx.execute("DELETE FROM workspaces", [])?;
            tx.execute("DELETE FROM worktrees", [])?;
            for repo in &repos {
                let (Some(id), Some(path)) = (repo["id"].as_str(), repo["path"].as_str()) else {
                    continue;
                };
                let name = repo["displayName"].as_str().unwrap_or(id);
                let kind = if repo["kind"] == "git" {
                    "git"
                } else {
                    "folder"
                };
                tx.execute(
                    "INSERT OR REPLACE INTO projects (id, name, path, kind) VALUES (?1, ?2, ?3, ?4)",
                    params![id, name, path, kind],
                )?;
            }
            for wt in &worktrees {
                let (Some(id), Some(path)) = (wt["id"].as_str(), wt["path"].as_str()) else {
                    continue;
                };
                let repo = wt["repoId"].as_str();
                let name = wt["displayName"]
                    .as_str()
                    .filter(|n| !n.is_empty())
                    .unwrap_or(path);
                let archived = wt["isArchived"] == true;
                let created = wt["createdAt"].as_i64().unwrap_or(0);
                tx.execute(
                    "INSERT OR REPLACE INTO workspaces (id, name, path, project_id, is_archived) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![id, name, path, repo, archived as i64],
                )?;
                tx.execute(
                    "INSERT OR REPLACE INTO worktrees (workspace_id, project_id, path, is_archived, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![id, repo, path, archived as i64, created],
                )?;
            }
            for project in &folder_projects {
                tx.execute(
                    "INSERT OR REPLACE INTO projects (id, name, path, kind) VALUES (?1, ?2, ?3, 'folder-group')",
                    params![project.id, project.name, project.path],
                )?;
            }
            for ws in &folder_workspaces {
                tx.execute(
                    "INSERT OR REPLACE INTO workspaces (id, name, path, project_id, is_archived) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![ws.id, ws.name, ws.path, ws.project_id, ws.archived as i64],
                )?;
                tx.execute(
                    "INSERT OR REPLACE INTO worktrees (workspace_id, project_id, path, is_archived, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![ws.id, ws.project_id, ws.path, ws.archived as i64, ws.created_at],
                )?;
            }
            tx.commit()
        })();
        drop(conn);
        match result {
            Ok(()) => *self.mirror_read_at.lock().unwrap() = Some(Instant::now()),
            Err(e) => eprintln!("[work-board] cannot store the Orca mirror: {e}"),
        }
    }

    /// The worktrees a ticket can work in, for the UI's pickers.
    fn orca_workspaces(&self) -> Result<Value, RpcError> {
        self.refresh_mirror(false);
        let conn = self.db.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT w.id, w.name, w.path, w.project_id, p.name FROM workspaces w LEFT JOIN projects p ON p.id = w.project_id
                 WHERE w.is_archived = 0 ORDER BY p.name COLLATE NOCASE, w.path = p.path DESC, w.name COLLATE NOCASE",
            )
            .map_err(error::from_sqlite)?;
        let rows = stmt
            .query_map([], |r| {
                let name: String = r.get(1)?;
                let project: Option<String> = r.get(4)?;
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "name": match &project { Some(p) if *p != name => format!("{p} · {name}"), _ => name },
                    "path": r.get::<_, String>(2)?,
                    "projectId": r.get::<_, Option<String>>(3)?,
                }))
            })
            .map_err(error::from_sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error::from_sqlite)?;
        Ok(json!({ "workspaces": rows }))
    }

    /// Orca's default agent, unless it is not one the board launches.
    pub(crate) fn orca_default_agent(&self) -> Option<String> {
        self.orca.settings()["defaultTuiAgent"]
            .as_str()
            .filter(|id| crate::sessions::HARNESSES.contains(id))
            .map(str::to_owned)
    }

    /// `gh pr view` for a project's pull request: the fields the PR watch
    /// fingerprints (`state`, `isDraft`, `mergeable`, `reviewDecision`,
    /// `checks.state`, `updatedAt`).
    pub(crate) fn pr_view(&self, project_id: &str, number: i64) -> Result<Value, RpcError> {
        let path: String = {
            let conn = self.db.lock().unwrap();
            conn.query_row(
                "SELECT path FROM projects WHERE id = ?1",
                params![project_id],
                |r| r.get(0),
            )
            .map_err(|_| error::not_found(format!("project {project_id} not found")))?
        };
        let output = std::process::Command::new(gh_bin())
            .args([
                "pr",
                "view",
                &number.to_string(),
                "--json",
                "state,isDraft,mergeable,reviewDecision,statusCheckRollup,updatedAt,url",
            ])
            .current_dir(&path)
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| RpcError::new("gh_unavailable", format!("cannot run gh: {e}")))?;
        if !output.status.success() {
            return Err(RpcError::new(
                "gh_failed",
                String::from_utf8_lossy(&output.stderr)
                    .trim()
                    .chars()
                    .take(500)
                    .collect::<String>(),
            ));
        }
        let mut pull: Value = serde_json::from_slice(&output.stdout)
            .map_err(|_| RpcError::new("gh_failed", "gh pr view gave no JSON"))?;
        pull["checks"] = json!({ "state": checks_state(&pull["statusCheckRollup"]) });
        Ok(json!({ "pull": pull }))
    }
}

/// One word for a PR's checks: `failure`, `pending`, `success` or `none`.
fn checks_state(rollup: &Value) -> &'static str {
    let Some(items) = rollup.as_array().filter(|a| !a.is_empty()) else {
        return "none";
    };
    let mut pending = false;
    for item in items {
        let conclusion = item["conclusion"]
            .as_str()
            .or(item["state"].as_str())
            .unwrap_or("")
            .to_ascii_uppercase();
        let status = item["status"]
            .as_str()
            .unwrap_or("COMPLETED")
            .to_ascii_uppercase();
        if matches!(
            conclusion.as_str(),
            "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED"
        ) {
            return "failure";
        }
        if status != "COMPLETED" || matches!(conclusion.as_str(), "PENDING" | "EXPECTED" | "") {
            pending = true;
        }
    }
    if pending { "pending" } else { "success" }
}

static GH_OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Tests point the board at a fake `gh` (process-wide).
pub fn set_gh_bin_override(path: Option<PathBuf>) {
    *GH_OVERRIDE.lock().unwrap_or_else(|p| p.into_inner()) = path;
}

/// The `gh` CLI: on PATH, else Homebrew's or /usr/local's.
pub(crate) fn gh_bin() -> PathBuf {
    if let Some(path) = GH_OVERRIDE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
    {
        return path;
    }
    find_on_path("gh")
        .or_else(|| {
            ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]
                .iter()
                .map(PathBuf::from)
                .find(|p| p.is_file())
        })
        .unwrap_or_else(|| PathBuf::from("gh"))
}

pub(crate) fn find_on_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    })
}

fn apply_mirror_schema(tx: &rusqlite::Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'git'
        );
        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            project_id TEXT,
            is_archived INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS worktrees (
            workspace_id TEXT PRIMARY KEY,
            project_id TEXT,
            path TEXT NOT NULL,
            is_archived INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            harness_id TEXT,
            agent_session_id TEXT,
            title TEXT,
            prompt_preview TEXT,
            verdict TEXT NOT NULL DEFAULT 'live',
            created_at INTEGER NOT NULL,
            ended_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS board_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
}

/// Milliseconds since the Unix epoch.
pub fn now_unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// `YYYY-MM-DDTHH:MM:SSZ` for a millisecond epoch.
pub fn rfc3339(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_formats_utc() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_790_565_600_123), "2026-09-28T03:20:00Z");
        assert_eq!(rfc3339(951_782_400_000), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn checks_collapse_to_one_word() {
        assert_eq!(checks_state(&json!([])), "none");
        assert_eq!(
            checks_state(&json!([{"status":"COMPLETED","conclusion":"SUCCESS"}])),
            "success"
        );
        assert_eq!(
            checks_state(&json!([{"status":"IN_PROGRESS","conclusion":""}])),
            "pending"
        );
        assert_eq!(
            checks_state(
                &json!([{"status":"COMPLETED","conclusion":"SUCCESS"},{"status":"COMPLETED","conclusion":"FAILURE"}])
            ),
            "failure"
        );
        assert_eq!(checks_state(&json!([{"state":"PENDING"}])), "pending");
    }
}
