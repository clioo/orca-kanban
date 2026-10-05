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
}

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
        Self { cli, user_data }
    }

    pub fn user_data(&self) -> &Path {
        &self.user_data
    }

    /// Runs `orca <args> --json` and returns its `result`, or its error.
    pub fn call(&self, args: &[&str]) -> Result<Value, RpcError> {
        let mut child = Command::new(&self.cli)
            .args(args)
            .arg("--json")
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
                    format!("cannot run the orca CLI ({}): {e}", self.cli.display()),
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
                            "orca {} did not answer within {}s",
                            args.first().unwrap_or(&""),
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
                format!("orca {} gave no JSON reply", args.first().unwrap_or(&"")),
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
    /// and default args), read from its profile store. Empty when unreadable.
    pub fn settings(&self) -> Value {
        let profiles = self.user_data.join("profiles");
        let mut paths: Vec<PathBuf> = std::fs::read_dir(&profiles)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|e| e.path().join("orca-data.json"))
                    .collect()
            })
            .unwrap_or_default();
        // The default profile first, the rest in name order.
        paths.sort_by_key(|p| (!p.to_string_lossy().contains("local-default"), p.clone()));
        for path in paths {
            if let Ok(text) = std::fs::read_to_string(&path)
                && let Ok(data) = serde_json::from_str::<Value>(&text)
                && data["settings"].is_object()
            {
                return data["settings"].clone();
            }
        }
        json!({})
    }
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
