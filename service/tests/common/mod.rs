//! A board engine over a fake `orca` CLI (tests/fixtures/fake-orca.mjs)
//! whose state file the tests read and edit: Orca repos, worktrees,
//! terminals (with the command each was created with and every line sent to
//! it) and the agents Orca tracks.
#![allow(dead_code)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use work_board_svc::Engine;
use work_board_svc::orca::Orca;

pub fn node() -> String {
    std::env::var("WORK_BOARD_NODE").unwrap_or_else(|_| "node".to_string())
}

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

pub struct Board {
    pub root: tempfile::TempDir,
    pub engine: Engine,
    pub user_data: PathBuf,
}

pub const REPO_ID: &str = "repo-drogon";

#[allow(clippy::new_without_default)]
impl Board {
    /// A board over a fake Orca with one git repo named `Drogon` (tickets
    /// key as `DRG-n`) and its main worktree.
    pub fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let user_data = root.path().join("orca-user-data");
        std::fs::create_dir_all(&user_data).unwrap();
        let cli = root.path().join("orca");
        std::fs::write(
            &cli,
            format!(
                "#!/bin/sh\nexec '{}' '{}' \"$@\"\n",
                node(),
                repo_root().join("tests/fixtures/fake-orca.mjs").display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let project = root.path().join("Drogon");
        std::fs::create_dir_all(&project).unwrap();
        let path = project.to_string_lossy().to_string();
        let state = json!({
            "repos": [{ "id": REPO_ID, "path": path, "displayName": "Drogon", "kind": "git" }],
            "worktrees": [{
                "id": format!("{REPO_ID}::{path}"), "repoId": REPO_ID, "path": path,
                "displayName": "main", "isMainWorktree": true, "isArchived": false, "createdAt": 1
            }],
            "terminals": [], "agents": {}, "calls": [], "counter": 0
        });
        std::fs::write(user_data.join("fake-orca.json"), state.to_string()).unwrap();
        let engine =
            Engine::open(&root.path().join("data"), Orca::new(cli, user_data.clone())).unwrap();
        Board {
            root,
            engine,
            user_data,
        }
    }

    pub fn main_worktree(&self) -> String {
        format!("{REPO_ID}::{}", self.root.path().join("Drogon").display())
    }

    pub fn state(&self) -> Value {
        serde_json::from_str(
            &std::fs::read_to_string(self.user_data.join("fake-orca.json")).unwrap(),
        )
        .unwrap()
    }

    pub fn edit(&self, f: impl FnOnce(&mut Value)) {
        let mut state = self.state();
        f(&mut state);
        std::fs::write(self.user_data.join("fake-orca.json"), state.to_string()).unwrap();
        // The next read goes to Orca.
        self.engine.mark_live_stale();
    }

    /// Orca settings the board reads (default agent, command overrides,
    /// default args), as Orca stores them.
    pub fn orca_settings(&self, settings: Value) {
        let dir = self.user_data.join("profiles").join("local-default");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("orca-data.json"),
            json!({ "settings": settings }).to_string(),
        )
        .unwrap();
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        self.engine
            .dispatch(method, &params)
            .map_err(|e| format!("{}: {}", e.code, e.message))
    }

    pub fn ok(&self, method: &str, params: Value) -> Value {
        self.call(method, params)
            .unwrap_or_else(|e| panic!("{method}: {e}"))
    }

    pub fn err(&self, method: &str, params: Value) -> String {
        match self.call(method, params) {
            Ok(v) => panic!("{method} unexpectedly succeeded: {v}"),
            Err(e) => e,
        }
    }

    pub fn column(&self, name: &str) -> Value {
        self.ok("work.board", json!({}))["columns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .cloned()
            .unwrap_or_else(|| panic!("column {name} missing"))
    }

    pub fn ticket(&self, title: &str, column: &str) -> Value {
        self.ok(
            "work.ticket_create",
            json!({"title": title, "projectId": REPO_ID, "columnId": column, "prUrl": "#7"}),
        )
    }

    pub fn prompt_column(&self, name: &str, message: &str) -> Value {
        let column = self.column(name);
        self.ok(
            "work.column_update",
            json!({"columnId": column["id"], "sendOnEnter": true, "message": message}),
        )
    }

    /// A terminal the user opened in Orca (not started by the board).
    pub fn user_terminal(&self, agent: Option<&str>) -> String {
        let worktree = self.main_worktree();
        let mut handle = String::new();
        self.edit(|state| {
            let n = state["counter"].as_i64().unwrap_or(0) + 1;
            state["counter"] = json!(n);
            handle = format!("term_user{n}");
            state["terminals"].as_array_mut().unwrap().push(json!({
                "handle": handle, "worktreeId": worktree, "title": "Terminal",
                "tabId": format!("tab-u{n}"), "leafId": format!("leaf-u{n}"), "lastOutputAt": 1000 + n,
                "command": "", "inputs": [], "live": true
            }));
            if let Some(agent) = agent {
                state["agents"][format!("tab-u{n}:leaf-u{n}")] = json!({ "state": "idle", "agentType": agent });
            }
        });
        handle
    }

    pub fn terminal(&self, handle: &str) -> Value {
        self.state()["terminals"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["handle"] == handle)
            .cloned()
            .unwrap_or_else(|| panic!("no terminal {handle}"))
    }

    pub fn inputs(&self, handle: &str) -> Vec<String> {
        self.terminal(handle)["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    }

    /// The terminal closes (its agent exited).
    pub fn close(&self, handle: &str) {
        let handle = handle.to_string();
        self.edit(|state| {
            for t in state["terminals"].as_array_mut().unwrap() {
                if t["handle"] == handle.as_str() {
                    t["live"] = json!(false);
                }
            }
        });
    }

    pub fn terminals_created(&self) -> Vec<Value> {
        self.state()["terminals"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| !t["handle"].as_str().unwrap().starts_with("term_user"))
            .cloned()
            .collect()
    }

    /// The prompt a typed launch command reads from its prompt file.
    pub fn prompt_of(&self, command: &str) -> String {
        let start = command
            .find("$(cat '")
            .expect("command carries a prompt file")
            + 7;
        let end = command[start..].find('\'').unwrap() + start;
        std::fs::read_to_string(&command[start..end]).unwrap()
    }
}

pub fn linked_ids(ticket: &Value) -> Vec<String> {
    ticket["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_string())
        .collect()
}
