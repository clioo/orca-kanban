//! Ticket sessions are Orca terminals. A session's id is its Orca terminal
//! handle (`term_…`); the board keeps a row per session it started or was
//! asked to link (harness, the agent's own conversation id when the board
//! chose it, the title it was given), and reads liveness and agent state
//! from Orca:
//!
//! - live: the handle is among `orca terminal list` (the agent runs as the
//!   terminal's foreground command followed by `exit`, so the terminal
//!   closes when the agent exits);
//! - exited: it was live and Orca no longer lists it;
//! - unverifiable: Orca could not be read, which never proves an exit.
//!
//! Starting an agent types `<agent> <Orca's default args> <resume> <prompt>;
//! exit` into a new terminal of the ticket's worktree. A stopped session
//! resumes its own conversation, never the folder's latest (folder
//! workspaces share one folder, and a conversation can last days):
//!
//! - Claude and Pi sessions the board starts get a board-chosen
//!   `--session-id`;
//! - while any linked session runs, the board records the pane it runs in and
//!   the conversation Orca's agent hooks report for that pane (its id and
//!   transcript), and Orca's record of a pane it put to sleep fills in what
//!   was missed;
//! - resuming uses that id: Claude `--resume <id>`, Pi `--session <file>`
//!   (or `--session-id <id>`), Codex `resume <id>`, OpenCode `--session <id>`.
//!   Only a session with no recorded conversation falls back to the agent's
//!   most-recent-in-this-folder entrypoint.
//!
//! Prompts travel through a 0600 file read by the shell
//! (`"$(cat …; rm -f …)"`), never through the typed command line.

use std::path::PathBuf;
use std::time::Instant;

use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::engine::{Engine, now_unix_ms, rfc3339};
use crate::error;
use crate::orca::board_agent_state;
use crate::protocol::RpcError;

pub const HARNESSES: &[&str] = &["claude", "codex", "opencode", "pi", "antigravity"];

/// How often running sessions' conversations are read from Orca.
pub(crate) const CONVERSATIONS_TTL: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Debug, Clone)]
pub(crate) struct SessionRow {
    pub id: String,
    pub workspace_id: String,
    pub harness_id: Option<String>,
    pub agent_session_id: Option<String>,
    pub title: Option<String>,
    pub prompt_preview: Option<String>,
    #[allow(dead_code)]
    pub verdict: String,
    pub created_at: i64,
    pub pane_key: Option<String>,
    pub agent_session_path: Option<String>,
}

fn row_from(r: &rusqlite::Row) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        harness_id: r.get(2)?,
        agent_session_id: r.get(3)?,
        title: r.get(4)?,
        prompt_preview: r.get(5)?,
        verdict: r.get(6)?,
        created_at: r.get(7)?,
        pane_key: r.get(8)?,
        agent_session_path: r.get(9)?,
    })
}

const SESSION_SELECT: &str = "SELECT id, workspace_id, harness_id, agent_session_id, title, prompt_preview, verdict, created_at, pane_key, agent_session_path FROM sessions";

pub(crate) fn get_row(
    conn: &rusqlite::Connection,
    id: &str,
) -> Result<Option<SessionRow>, RpcError> {
    conn.query_row(
        &format!("{SESSION_SELECT} WHERE id = ?1"),
        params![id],
        row_from,
    )
    .optional()
    .map_err(error::from_sqlite)
}

/// A single-quoted shell word.
pub fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// Characters a launcher token may carry unquoted.
fn is_plain_word(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=:@+,".contains(c))
}

fn preview(prompt: &str) -> String {
    let flat: String = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(120).collect()
}

/// What a start request asks for.
pub(crate) struct StartRequest<'a> {
    pub workspace_id: &'a str,
    pub harness_id: &'a str,
    pub prompt: Option<&'a str>,
    /// The session this one resumes (its row says how).
    pub resume_of: Option<&'a str>,
    pub title: Option<String>,
    /// The agent's own session name (Claude and Pi `--name`), so the
    /// conversation is found by its ticket in the agent's session list.
    pub session_name: Option<String>,
}

impl Engine {
    /// The next liveness read goes to Orca (an agent just changed state).
    pub fn mark_live_stale(&self) {
        self.live.lock().unwrap().read_at = None;
        *self.conversations_read_at.lock().unwrap() = None;
    }

    /// Re-reads Orca's live terminals and agents (throttled unless forced)
    /// and settles the board's session rows: a known live row Orca no
    /// longer lists is exited; a listed one is live.
    pub(crate) fn refresh_live(&self, force: bool) {
        {
            let live = self.live.lock().unwrap();
            if !force
                && live
                    .read_at
                    .is_some_and(|at| at.elapsed() < crate::engine::LIVE_TTL)
            {
                return;
            }
        }
        let terminals = self.orca.terminals();
        let agents = self.orca.agents();
        let mut live = self.live.lock().unwrap();
        live.read_at = Some(Instant::now());
        match terminals {
            Ok(list) => {
                live.error = None;
                live.terminals = list.into_iter().map(|t| (t.handle.clone(), t)).collect();
            }
            Err(e) => {
                // Nothing is known about any terminal now; rows keep their
                // last verdict and read as unverifiable until Orca answers.
                live.error = Some(e.message);
                live.terminals.clear();
                live.agents.clear();
                return;
            }
        }
        if let Ok(list) = agents {
            live.agents = list.into_iter().map(|a| (a.pane_key.clone(), a)).collect();
        }
        let handles: Vec<String> = live.terminals.keys().cloned().collect();
        drop(live);
        let conn = self.db.lock().unwrap();
        let now = now_unix_ms() as i64;
        let known: Vec<(String, String)> = conn
            .prepare("SELECT id, verdict FROM sessions")
            .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
            .unwrap_or_default();
        for (id, verdict) in known {
            let listed = handles.contains(&id);
            if listed && verdict != "live" {
                let _ = conn.execute(
                    "UPDATE sessions SET verdict = 'live', ended_at = NULL WHERE id = ?1",
                    params![id],
                );
            } else if !listed && verdict == "live" {
                let _ = conn.execute(
                    "UPDATE sessions SET verdict = 'exited', ended_at = ?2 WHERE id = ?1",
                    params![id, now],
                );
            }
        }
        drop(conn);
        self.record_conversations();
    }

    /// For every running session the board knows: the pane it runs in, and
    /// the conversation Orca's agent hooks report there (the latest one, so
    /// a `/new` inside the agent is followed).
    fn record_conversations(&self) {
        self.record_conversations_now(false);
    }

    /// `force` reads Orca now; otherwise at most every
    /// [`CONVERSATIONS_TTL`] (each read runs Orca's runtime client).
    pub(crate) fn record_conversations_now(&self, force: bool) {
        let panes: Vec<(String, String)> = {
            let live = self.live.lock().unwrap();
            live.terminals
                .values()
                .filter_map(|t| Some((t.handle.clone(), t.pane_key.clone()?)))
                .collect()
        };
        if panes.is_empty() {
            return;
        }
        let known: Vec<(String, String)> = {
            let conn = self.db.lock().unwrap();
            panes
                .into_iter()
                .filter(|(handle, _)| get_row(&conn, handle).ok().flatten().is_some())
                .collect()
        };
        if known.is_empty() {
            return;
        }
        {
            let mut read = self.conversations_read_at.lock().unwrap();
            if !force && read.is_some_and(|at| at.elapsed() < CONVERSATIONS_TTL) {
                return;
            }
            *read = Some(Instant::now());
        }
        let reported = self.orca.provider_sessions();
        let conn = self.db.lock().unwrap();
        for (handle, pane) in known {
            let Ok(Some(row)) = get_row(&conn, &handle) else {
                continue;
            };
            if row.pane_key.as_deref() != Some(pane.as_str()) {
                let _ = conn.execute(
                    "UPDATE sessions SET pane_key = ?2 WHERE id = ?1",
                    params![handle, pane],
                );
            }
            if let Some(seen) = reported.get(&handle).or_else(|| reported.get(&pane))
                && row.harness_id.as_deref().is_none_or(|h| h == seen.agent)
                && HARNESSES.contains(&seen.agent.as_str())
                && is_plain_word(&seen.id)
                && (row.agent_session_id.as_deref() != Some(seen.id.as_str())
                    || row.agent_session_path != seen.path)
            {
                let _ = conn.execute(
                    "UPDATE sessions SET agent_session_id = ?2, agent_session_path = ?3,
                     harness_id = COALESCE(harness_id, ?4) WHERE id = ?1",
                    params![handle, seen.id, seen.path, seen.agent],
                );
            }
        }
    }

    /// A session as the UI's `Session` row. `row` may be absent for a live
    /// Orca terminal the board has not linked yet.
    fn session_json(&self, id: &str, row: Option<&SessionRow>) -> Value {
        let live = self.live.lock().unwrap();
        let terminal = live.terminals.get(id);
        let agent = terminal
            .and_then(|t| t.pane_key.as_ref())
            .and_then(|p| live.agents.get(p));
        let verdict = if terminal.is_some() {
            "live"
        } else if live.error.is_some() {
            "unverifiable"
        } else {
            "exited"
        };
        let harness = row.and_then(|r| r.harness_id.clone()).or_else(|| {
            agent
                .and_then(|a| a.agent_type.clone())
                .filter(|t| HARNESSES.contains(&t.as_str()))
        });
        let (agent_state, authority, state_at) = match (verdict, agent) {
            ("live", Some(a)) => (
                board_agent_state(&a.state),
                Some("hook"),
                a.updated_at.map(rfc3339),
            ),
            ("live", None) => ("unknown", None, None),
            ("exited", _) => ("exited", None, None),
            _ => ("unknown", None, None),
        };
        let workspace = terminal
            .map(|t| t.worktree_id.clone())
            .or_else(|| row.map(|r| r.workspace_id.clone()))
            .unwrap_or_default();
        let title = row
            .and_then(|r| r.title.clone())
            .or_else(|| terminal.and_then(|t| t.title.clone()));
        let created = row
            .map(|r| r.created_at)
            .or(terminal.and_then(|t| t.last_output_at))
            .unwrap_or(0);
        json!({
            "id": id,
            "workspaceId": workspace,
            "hostId": "local",
            "incarnation": id,
            "command": harness.clone().unwrap_or_else(|| "shell".to_string()),
            "args": [],
            "cols": 0,
            "rows": 0,
            "verdict": verdict,
            "exitCode": null,
            "createdAt": rfc3339(created),
            "agentState": agent_state,
            "agentStateAt": state_at,
            "agentStateAuthority": authority,
            "agentPromptPreview": row.and_then(|r| r.prompt_preview.clone()).or_else(|| agent.and_then(|a| a.prompt.clone())),
            "harnessId": harness,
            "title": title,
            "agentSessionId": row.and_then(|r| r.agent_session_id.clone()),
        })
    }

    /// The linked sessions of a ticket as session rows, plus `{id,
    /// missing: true}` for a link whose session the board no longer knows.
    pub(crate) fn session_rows(&self, ids: &[String]) -> Result<Vec<Value>, RpcError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        self.refresh_live(false);
        let rows: Vec<(String, Option<SessionRow>)> = {
            let conn = self.db.lock().unwrap();
            ids.iter()
                .map(|id| Ok((id.clone(), get_row(&conn, id)?)))
                .collect::<Result<_, RpcError>>()?
        };
        Ok(rows
            .into_iter()
            .map(|(id, row)| match row {
                Some(row) => self.session_json(&id, Some(&row)),
                None => {
                    let listed = self.live.lock().unwrap().terminals.contains_key(&id);
                    if listed {
                        self.session_json(&id, None)
                    } else {
                        json!({ "id": id, "missing": true })
                    }
                }
            })
            .collect())
    }

    /// The session's row as JSON when Orca lists it live.
    pub(crate) fn live_session_json(&self, id: &str) -> Option<Value> {
        self.refresh_live(true);
        let row = {
            let conn = self.db.lock().unwrap();
            get_row(&conn, id).ok().flatten()
        };
        let value = self.session_json(id, row.as_ref());
        (value["verdict"] == "live").then_some(value)
    }

    /// Makes sure a session id the UI or CLI names is one the board can
    /// link: a known row, or a live Orca terminal (adopted with what Orca
    /// says about it).
    pub(crate) fn ensure_session_row(&self, id: &str) -> Result<(), RpcError> {
        {
            let conn = self.db.lock().unwrap();
            if get_row(&conn, id)?.is_some() {
                return Ok(());
            }
        }
        self.refresh_live(true);
        let (terminal, agent_type) = {
            let live = self.live.lock().unwrap();
            let terminal = live.terminals.get(id).cloned();
            let agent = terminal
                .as_ref()
                .and_then(|t| t.pane_key.as_ref())
                .and_then(|p| live.agents.get(p))
                .and_then(|a| a.agent_type.clone());
            (terminal, agent)
        };
        let terminal =
            terminal.ok_or_else(|| error::not_found(format!("session {id} not found")))?;
        let harness = agent_type.filter(|t| HARNESSES.contains(&t.as_str()));
        let conn = self.db.lock().unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, workspace_id, harness_id, title, verdict, created_at, pane_key) VALUES (?1, ?2, ?3, ?4, 'live', ?5, ?6)",
            params![id, terminal.worktree_id, harness, terminal.title, now_unix_ms() as i64, terminal.pane_key],
        )
        .map_err(error::from_sqlite)?;
        drop(conn);
        // What Orca already knows about it.
        self.record_conversations_now(true);
        Ok(())
    }

    /// Types a prompt into a live session.
    pub(crate) fn session_send(&self, id: &str, message: &str) -> Result<(), RpcError> {
        self.orca.terminal_send(id, message).map(|_| ())
    }

    /// Starts an agent in a worktree (a fresh one, or the resume of a
    /// stopped session, which the new session then replaces on every ticket
    /// that linked it). Returns the new session row plus `agentResume`
    /// (`resumed` or `fresh`).
    pub(crate) fn start_agent(&self, request: StartRequest<'_>) -> Result<Value, RpcError> {
        if !HARNESSES.contains(&request.harness_id) {
            return Err(error::invalid_argument(format!(
                "harnessId must be one of: {}",
                HARNESSES.join(", ")
            )));
        }
        let prior = match request.resume_of {
            Some(id) => {
                let conn = self.db.lock().unwrap();
                get_row(&conn, id)?
            }
            None => None,
        };
        let harness = request.harness_id;
        // What the stopped session was running: recorded while it ran, or
        // what Orca kept for its pane when it put the workspace to sleep.
        let conversation = prior.as_ref().and_then(|prior| {
            let recorded = prior
                .agent_session_id
                .clone()
                .filter(|id| is_plain_word(id))
                .map(|id| crate::orca::ProviderSession {
                    agent: harness.to_string(),
                    id,
                    path: prior.agent_session_path.clone(),
                });
            recorded.or_else(|| {
                let pane = prior.pane_key.as_deref()?;
                self.orca
                    .slept_provider_session(pane)
                    .or_else(|| self.orca.provider_sessions().remove(pane))
                    .filter(|s| s.agent == harness && is_plain_word(&s.id))
            })
        });
        let (resume_args, resumed, agent_session, agent_path) =
            resume_plan(harness, prior.is_some(), conversation);
        let settings = self.orca.settings();
        let command = settings["agentCmdOverrides"][harness]
            .as_str()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| default_command(harness).to_string());
        let default_args = settings["agentDefaultArgs"][harness]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_string();
        let mut line = if is_plain_word(&command) {
            command.clone()
        } else {
            shell_quote(&command)
        };
        if !default_args.is_empty() {
            // Orca's own per-agent defaults, typed as the user wrote them.
            line.push(' ');
            line.push_str(&default_args);
        }
        for arg in &resume_args {
            line.push(' ');
            line.push_str(&if is_plain_word(arg) {
                arg.clone()
            } else {
                shell_quote(arg)
            });
        }
        if let Some(name) = request
            .session_name
            .as_deref()
            .filter(|_| matches!(harness, "claude" | "pi"))
        {
            line.push_str(" --name ");
            line.push_str(&shell_quote(name));
        }
        if let Some(prompt) = request.prompt.map(str::trim).filter(|p| !p.is_empty()) {
            let file = self.write_prompt_file(prompt)?;
            let read = format!(
                "\"$(cat {q}; rm -f {q})\"",
                q = shell_quote(&file.to_string_lossy())
            );
            match harness {
                "claude" => line.push_str(&format!(" -- {read}")),
                "opencode" => line.push_str(&format!(" --prompt={read}")),
                "antigravity" => line.push_str(&format!(" --prompt-interactive {read}")),
                _ => line.push_str(&format!(" {read}")),
            }
        }
        // The terminal ends with the agent, so "listed" means "running".
        line.push_str("; exit");
        let title = request.title.unwrap_or_else(|| harness.to_string());
        let handle = self
            .orca
            .terminal_create(request.workspace_id, &title, &line)?;
        {
            let conn = self.db.lock().unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO sessions (id, workspace_id, harness_id, agent_session_id, title, prompt_preview, verdict, created_at, agent_session_path)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'live', ?7, ?8)",
                params![
                    handle,
                    request.workspace_id,
                    harness,
                    agent_session,
                    title,
                    request.prompt.map(preview),
                    now_unix_ms() as i64,
                    agent_path
                ],
            )
            .map_err(error::from_sqlite)?;
            if let Some(prior) = &prior {
                let _ = crate::work::relink_resumed_session(&conn, &prior.id, &handle);
                // The replaced session keeps no links; its row goes too.
                let _ = conn.execute("DELETE FROM sessions WHERE id = ?1", params![prior.id]);
            }
        }
        self.refresh_live(true);
        let row = {
            let conn = self.db.lock().unwrap();
            get_row(&conn, &handle)?
        };
        let mut value = self.session_json(&handle, row.as_ref());
        value["agentResume"] = json!(if resumed { "resumed" } else { "fresh" });
        Ok(value)
    }

    fn write_prompt_file(&self, prompt: &str) -> Result<PathBuf, RpcError> {
        let dir = self.data_dir.join("prompts");
        std::fs::create_dir_all(&dir).map_err(|e| error::internal_error(e.to_string()))?;
        let path = dir.join(format!("{}.txt", uuid::Uuid::new_v4()));
        crate::integrations::seal::write_file_600(&path, prompt.as_bytes())
            .map_err(error::internal_error)?;
        Ok(path)
    }

    /// Prompt files a terminal never read (it closed first) older than a day.
    pub fn sweep_prompt_files(&self) {
        let Ok(entries) = std::fs::read_dir(self.data_dir.join("prompts")) else {
            return;
        };
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() > 86_400);
            if old {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// `orca.sessions`: every live Orca terminal, for the ticket's "link a
    /// session" picker (live ones first is all there is: Orca keeps no
    /// record of closed terminals).
    pub(crate) fn orca_sessions(&self, params: &Value) -> Result<Value, RpcError> {
        self.refresh_live(true);
        let workspace = params["workspaceId"].as_str();
        let handles: Vec<String> = {
            let live = self.live.lock().unwrap();
            if let Some(e) = &live.error {
                return Err(RpcError::new("orca_unavailable", e.clone()));
            }
            let mut list: Vec<_> = live
                .terminals
                .values()
                .filter(|t| workspace.is_none_or(|w| t.worktree_id == w))
                .cloned()
                .collect();
            list.sort_by_key(|t| std::cmp::Reverse(t.last_output_at.unwrap_or(0)));
            list.into_iter().map(|t| t.handle).collect()
        };
        let rows: Vec<Value> = handles
            .iter()
            .map(|h| {
                let row = {
                    let conn = self.db.lock().unwrap();
                    get_row(&conn, h).ok().flatten()
                };
                self.session_json(h, row.as_ref())
            })
            .collect();
        Ok(json!({ "sessions": rows }))
    }

    /// `orca.session_focus`: shows a live session's terminal in Orca.
    pub(crate) fn orca_session_focus(&self, params: &Value) -> Result<Value, RpcError> {
        let id = params["sessionId"]
            .as_str()
            .ok_or_else(|| error::invalid_argument("sessionId is required"))?;
        self.orca.terminal_switch(id)?;
        Ok(json!({ "focused": id }))
    }
}

/// The CLI each agent installs.
fn default_command(harness: &str) -> &'static str {
    match harness {
        "claude" => "claude",
        "codex" => "codex",
        "opencode" => "opencode",
        "pi" => "pi",
        "antigravity" => "agy",
        _ => "claude",
    }
}

/// How to start `harness`: the resume arguments, whether it resumes, and
/// the conversation id (and transcript) the new session runs.
fn resume_plan(
    harness: &str,
    resuming: bool,
    conversation: Option<crate::orca::ProviderSession>,
) -> (Vec<String>, bool, Option<String>, Option<String>) {
    let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    if resuming {
        if let Some(c) = conversation {
            let id = c.id.clone();
            let path = c.path.clone().filter(|p| std::path::Path::new(p).is_file());
            let exact = match harness {
                "claude" => Some(args(&["--resume", &id])),
                // The transcript names the exact conversation wherever it
                // lives; the id finds it in this folder's sessions.
                "pi" => Some(match &path {
                    Some(p) => vec!["--session".to_string(), p.clone()],
                    None => args(&["--session-id", &id]),
                }),
                "codex" => Some(args(&["resume", &id])),
                "opencode" => Some(args(&["--session", &id])),
                _ => None,
            };
            if let Some(exact) = exact {
                return (exact, true, Some(id), path);
            }
        }
        // No recorded conversation: the agent's most recent in this folder.
        return match harness {
            "codex" => (args(&["resume", "--last"]), true, None, None),
            "claude" | "opencode" | "pi" | "antigravity" => {
                (args(&["--continue"]), true, None, None)
            }
            _ => (Vec::new(), false, None, None),
        };
    }
    // A fresh Claude or Pi session gets an id the board knows from the start.
    if matches!(harness, "claude" | "pi") {
        let id = uuid::Uuid::new_v4().to_string();
        return (args(&["--session-id", &id]), false, Some(id), None);
    }
    (Vec::new(), false, None, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_words_are_quoted_safely() {
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert!(is_plain_word("--session-id"));
        assert!(!is_plain_word("a;b"));
        assert!(!is_plain_word("$(x)"));
        assert_eq!(preview("  fix\n the   bug  "), "fix the bug");
    }
}
