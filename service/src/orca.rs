//! The Orca the board lives in, reached through that Orca's own `orca` CLI
//! (`ORCA_USER_DATA_PATH` names the instance, so an isolated test Orca and
//! the developer's never mix). Every call is bounded; a CLI that hangs is
//! killed and reported, never waited on forever.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::protocol::RpcError;

const CALL_TIMEOUT: Duration = Duration::from_secs(30);

pub struct Orca {
    cli: PathBuf,
    user_data: PathBuf,
    rpc: Option<RpcRunner>,
}

/// How runtime methods the CLI has no command for (folder projects and
/// their folder workspaces) are reached: Orca's own runtime client, run by
/// Orca's own Node (see `plugin/orca-rpc.cjs`). Tests point it at the fake.
#[derive(Clone, Debug)]
pub struct RpcRunner {
    pub program: PathBuf,
    pub prefix: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// A folder project (Orca "project group" backed by a folder), such as
/// `pre-sales`: its folder workspaces are separate named contexts on it.
#[derive(Debug, Clone)]
pub struct FolderProject {
    /// `folder-workspace:<groupId>`, the repo id Orca reports for its workspaces.
    pub id: String,
    pub group_id: String,
    pub name: String,
    pub path: String,
}

/// One folder workspace (`folder:<id>`) of a folder project.
#[derive(Debug, Clone)]
pub struct FolderWorkspace {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub path: String,
    pub archived: bool,
    pub created_at: i64,
}

const FOLDER_PROJECT_PREFIX: &str = "folder-workspace:";

/// A live Orca terminal as `orca terminal list` reports it.
#[derive(Debug, Clone)]
pub struct Terminal {
    pub handle: String,
    pub worktree_id: String,
    pub title: Option<String>,
    pub pane_key: Option<String>,
    pub last_output_at: Option<i64>,
}

/// One agent Orca tracks in a pane (`orca worktree ps`).
#[derive(Debug, Clone)]
pub struct Agent {
    pub pane_key: String,
    pub state: String,
    pub agent_type: Option<String>,
    pub prompt: Option<String>,
    pub updated_at: Option<i64>,
}

impl Orca {
    pub fn new(cli: PathBuf, user_data: PathBuf) -> Self {
        Self {
            cli,
            user_data,
            rpc: None,
        }
    }

    pub fn with_rpc(mut self, rpc: RpcRunner) -> Self {
        self.rpc = Some(rpc);
        self
    }

    /// The runner for an installed Orca: `<App>/Contents/MacOS/Orca` as
    /// Node, with the plugin's helper. `None` when `cli` is not inside an
    /// Orca.app (then folder projects are read from `worktree ps` only).
    pub fn app_rpc_runner(cli: &Path, helper: &Path) -> Option<RpcRunner> {
        let contents = cli.parent()?.parent()?.parent()?;
        let app = contents.parent()?;
        let electron = contents.join("MacOS").join("Orca");
        (contents.file_name()? == "Contents" && electron.is_file() && helper.is_file()).then(|| {
            RpcRunner {
                program: electron,
                prefix: vec![
                    helper.to_string_lossy().to_string(),
                    app.to_string_lossy().to_string(),
                ],
                env: vec![("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string())],
            }
        })
    }

    pub fn user_data(&self) -> &Path {
        &self.user_data
    }

    /// Runs `orca <args> --json` and returns its `result`, or its error.
    pub fn call(&self, args: &[&str]) -> Result<Value, RpcError> {
        let mut full: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        full.push("--json".to_string());
        self.run(&self.cli, &full, &[], args.first().unwrap_or(&""))
    }

    /// A runtime method by name (`folderWorkspace.create`, …).
    pub fn rpc(&self, method: &str, params: &Value) -> Result<Value, RpcError> {
        let Some(runner) = &self.rpc else {
            return Err(RpcError::new(
                "orca_unsupported",
                "this Orca cannot be asked for folder projects here",
            ));
        };
        let mut args = runner.prefix.clone();
        args.push(method.to_string());
        args.push(params.to_string());
        self.run(&runner.program, &args, &runner.env, method)
    }

    fn run(
        &self,
        program: &Path,
        args: &[String],
        env: &[(String, String)],
        what: &str,
    ) -> Result<Value, RpcError> {
        let mut child = Command::new(program)
            .args(args)
            .envs(env.iter().map(|(k, v)| (k, v)))
            .env("ORCA_USER_DATA_PATH", &self.user_data)
            // A terminal's identity must never leak into a board call.
            .env_remove("ORCA_TERMINAL_HANDLE")
            .env_remove("ORCA_PANE_KEY")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                RpcError::new(
                    "orca_unavailable",
                    format!("cannot run the orca CLI ({}): {e}", program.display()),
                )
            })?;
        let mut stdout = child.stdout.take().expect("piped");
        let reader = std::thread::spawn(move || {
            let mut out = String::new();
            let _ = stdout.read_to_string(&mut out);
            out
        });
        let deadline = Instant::now() + CALL_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(RpcError::new(
                        "orca_timeout",
                        format!(
                            "orca {what} did not answer within {}s",
                            CALL_TIMEOUT.as_secs()
                        ),
                    ));
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(e) => return Err(RpcError::new("orca_unavailable", e.to_string())),
            }
        }
        let out = reader.join().unwrap_or_default();
        let reply: Value = serde_json::from_str(out.trim()).map_err(|_| {
            RpcError::new(
                "orca_unavailable",
                format!("orca {what} gave no JSON reply"),
            )
        })?;
        if reply["ok"] == true {
            Ok(reply["result"].clone())
        } else {
            let code = reply["error"]["code"].as_str().unwrap_or("orca_error");
            let message = reply["error"]["message"]
                .as_str()
                .unwrap_or("orca call failed");
            Err(RpcError::new(format!("orca_{code}"), message.to_string()))
        }
    }

    pub fn repos(&self) -> Result<Vec<Value>, RpcError> {
        Ok(self.call(&["repo", "list"])?["repos"]
            .as_array()
            .cloned()
            .unwrap_or_default())
    }

    pub fn worktrees(&self) -> Result<Vec<Value>, RpcError> {
        Ok(
            self.call(&["worktree", "list", "--limit", "10000"])?["worktrees"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
        )
    }

    pub fn terminals(&self) -> Result<Vec<Terminal>, RpcError> {
        let result = self.call(&["terminal", "list", "--limit", "10000"])?;
        Ok(result["terminals"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|t| {
                        Some(Terminal {
                            handle: t["handle"].as_str()?.to_string(),
                            worktree_id: t["worktreeId"].as_str().unwrap_or_default().to_string(),
                            title: t["title"].as_str().map(str::to_owned),
                            pane_key: match (t["tabId"].as_str(), t["leafId"].as_str()) {
                                (Some(tab), Some(leaf)) => Some(format!("{tab}:{leaf}")),
                                _ => None,
                            },
                            last_output_at: t["lastOutputAt"].as_i64(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Every agent Orca tracks, keyed by pane (`tabId:leafId`).
    pub fn agents(&self) -> Result<Vec<Agent>, RpcError> {
        let result = self.call(&["worktree", "ps", "--limit", "10000"])?;
        let mut out = Vec::new();
        for worktree in result["worktrees"].as_array().into_iter().flatten() {
            for agent in worktree["agents"].as_array().into_iter().flatten() {
                if let Some(pane) = agent["paneKey"].as_str() {
                    out.push(Agent {
                        pane_key: pane.to_string(),
                        state: agent["state"].as_str().unwrap_or("unknown").to_string(),
                        agent_type: agent["agentType"].as_str().map(str::to_owned),
                        prompt: agent["prompt"]
                            .as_str()
                            .filter(|p| !p.is_empty())
                            .map(str::to_owned),
                        updated_at: agent["updatedAt"]
                            .as_i64()
                            .or(agent["stateStartedAt"].as_i64()),
                    });
                }
            }
        }
        Ok(out)
    }

    /// Folder workspaces, as `orca worktree ps` lists them.
    pub fn folder_workspaces(&self) -> Result<Vec<FolderWorkspace>, RpcError> {
        let result = self.call(&["worktree", "ps", "--limit", "10000"])?;
        Ok(result["worktrees"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|w| w["workspaceKind"] == "folder-workspace")
            .filter_map(|w| {
                Some(FolderWorkspace {
                    id: w["worktreeId"].as_str()?.to_string(),
                    project_id: w["repoId"].as_str()?.to_string(),
                    name: w["displayName"].as_str().unwrap_or_default().to_string(),
                    path: w["path"].as_str().unwrap_or_default().to_string(),
                    archived: w["isArchived"] == true,
                    created_at: w["createdAt"].as_i64().unwrap_or(0),
                })
            })
            .collect())
    }

    /// Folder projects: Orca's folder-backed project groups. Without the
    /// runtime helper, the ones that already have a folder workspace.
    pub fn folder_projects(&self, workspaces: &[FolderWorkspace]) -> Vec<FolderProject> {
        if let Ok(result) = self.rpc("projectGroup.list", &json!({})) {
            return result["groups"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|g| {
                    let group_id = g["id"].as_str()?.to_string();
                    let path = g["parentPath"].as_str().filter(|p| !p.trim().is_empty())?;
                    Some(FolderProject {
                        id: format!("{FOLDER_PROJECT_PREFIX}{group_id}"),
                        group_id,
                        name: g["name"].as_str().unwrap_or("Folder project").to_string(),
                        path: path.to_string(),
                    })
                })
                .collect();
        }
        let ps = self.call(&["worktree", "ps", "--limit", "10000"]).ok();
        let mut seen = std::collections::HashSet::new();
        let names: std::collections::HashMap<String, String> = ps
            .iter()
            .flat_map(|r| r["worktrees"].as_array().cloned().unwrap_or_default())
            .filter_map(|w| {
                Some((
                    w["repoId"].as_str()?.to_string(),
                    w["repo"].as_str()?.to_string(),
                ))
            })
            .collect();
        workspaces
            .iter()
            .filter(|w| seen.insert(w.project_id.clone()))
            .filter_map(|w| {
                let group_id = w
                    .project_id
                    .strip_prefix(FOLDER_PROJECT_PREFIX)?
                    .to_string();
                Some(FolderProject {
                    id: w.project_id.clone(),
                    group_id,
                    name: names
                        .get(&w.project_id)
                        .cloned()
                        .unwrap_or_else(|| w.path.clone()),
                    path: w.path.clone(),
                })
            })
            .collect()
    }

    /// A new folder workspace in a folder project; returns its `folder:<id>`.
    pub fn folder_workspace_create(
        &self,
        project_id: &str,
        name: &str,
    ) -> Result<String, RpcError> {
        let group = project_id
            .strip_prefix(FOLDER_PROJECT_PREFIX)
            .ok_or_else(|| RpcError::new("invalid_argument", "not a folder project"))?;
        let created = self.rpc(
            "folderWorkspace.create",
            &json!({ "projectGroupId": group, "name": name }),
        )?;
        created["folderWorkspace"]["id"]
            .as_str()
            .map(|id| format!("folder:{id}"))
            .ok_or_else(|| RpcError::new("orca_error", "Orca made no folder workspace"))
    }

    /// A visible terminal in a worktree running `command` in its login
    /// shell; returns the terminal handle.
    pub fn terminal_create(
        &self,
        worktree_id: &str,
        title: &str,
        command: &str,
    ) -> Result<String, RpcError> {
        let selector = format!("id:{worktree_id}");
        let result = self.call(&[
            "terminal",
            "create",
            "--worktree",
            &selector,
            "--title",
            title,
            "--command",
            command,
        ])?;
        result["terminal"]["handle"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| RpcError::new("orca_error", "orca terminal create returned no handle"))
    }

    /// Types `text` into a terminal and presses Return.
    pub fn terminal_send(&self, handle: &str, text: &str) -> Result<Value, RpcError> {
        let result = self.call(&[
            "terminal",
            "send",
            "--terminal",
            handle,
            "--text",
            text,
            "--enter",
        ])?;
        if result["send"]["accepted"] == false {
            return Err(RpcError::new(
                "orca_refused",
                "Orca did not accept the input for that terminal",
            ));
        }
        Ok(result)
    }

    /// Brings a terminal (and its worktree) to the front of Orca.
    pub fn terminal_switch(&self, handle: &str) -> Result<Value, RpcError> {
        self.call(&["terminal", "switch", "--terminal", handle])
    }

    pub fn worktree_create(
        &self,
        repo_id: &str,
        name: &str,
        comment: &str,
    ) -> Result<Value, RpcError> {
        let selector = format!("id:{repo_id}");
        Ok(self.call(&[
            "worktree",
            "create",
            "--repo",
            &selector,
            "--name",
            name,
            "--comment",
            comment,
        ])?["worktree"]
            .clone())
    }

    /// Orca's own settings (the default agent, per-agent command overrides
    /// and default args) for the default profile, else the first readable
    /// one. Empty when unreadable.
    pub fn settings(&self) -> Value {
        let mut dirs = profile_dirs(&self.user_data.join("profiles"));
        // The default profile first, the rest in name order.
        dirs.sort_by_key(|p| (!p.to_string_lossy().contains("local-default"), p.clone()));
        dirs.iter()
            .find_map(|dir| profile_settings(dir))
            .unwrap_or_else(|| json!({}))
    }
}

fn profile_dirs(profiles: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(profiles)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

/// Every Orca profile's settings (for the plugin's disabled check).
pub fn all_profile_settings(user_data: &Path) -> Vec<Value> {
    profile_dirs(&user_data.join("profiles"))
        .iter()
        .filter_map(|dir| profile_settings(dir))
        .collect()
}

/// One profile's settings. Orca 1.4.22x keeps profile state in SQLite
/// (`profile-state.db`, document `settings`) and leaves `orca-data.json` as
/// a frozen export; earlier Orcas keep it in `orca-data.json`. Read-only:
/// Orca owns both.
pub fn profile_settings(dir: &Path) -> Option<Value> {
    let db = dir.join("profile-state.db");
    if db.is_file() {
        let read = || -> rusqlite::Result<String> {
            let conn = rusqlite::Connection::open_with_flags(
                &db,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            conn.busy_timeout(Duration::from_secs(2))?;
            conn.query_row(
                "SELECT payload FROM profile_state_documents WHERE domain = 'settings'",
                [],
                |r| r.get(0),
            )
        };
        match read()
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        {
            Some(settings) if settings.is_object() => return Some(settings),
            // A store being written or of another shape: the legacy file is
            // better than nothing, never worse than the last good read.
            _ => {}
        }
    }
    let text = std::fs::read_to_string(dir.join("orca-data.json")).ok()?;
    let data: Value = serde_json::from_str(&text).ok()?;
    data["settings"]
        .is_object()
        .then(|| data["settings"].clone())
}

/// Orca's agent state words onto the board's (`working`, `idle`,
/// `needs_input`, `unknown`).
pub fn board_agent_state(orca_state: &str) -> &'static str {
    match orca_state {
        "working" | "running" | "busy" => "working",
        "done" | "idle" | "ready" => "idle",
        s if s.contains("wait")
            || s.contains("permission")
            || s.contains("input")
            || s.contains("attention")
            || s.contains("blocked") =>
        {
            "needs_input"
        }
        _ => "unknown",
    }
}
