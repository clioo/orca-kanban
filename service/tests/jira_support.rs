//! Shared support for the source fixture tests: spawns the fake Jira server
//! (tests/fixtures/jira/fake-jira-server.mjs) on an ephemeral port and
//! drives a board engine over the fake Orca. Every test talks ONLY to the
//! fixtures; the fixture token is the literal string `fixture-token`.
#![allow(dead_code)]

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};

use serde_json::{Value, json};
use tempfile::TempDir;
use work_board_svc::protocol::RpcError;

#[path = "common/mod.rs"]
pub mod common;

pub const FIXTURE_TOKEN: &str = "fixture-token";
pub const FIXTURE_EMAIL: &str = "carlos@example.com";

/// Kills the fixture child on drop.
pub struct FixtureServer {
    child: Child,
    pub port: u16,
    log_dir: TempDir,
}

impl Drop for FixtureServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[allow(clippy::new_without_default)]
impl FixtureServer {
    pub fn new() -> Self {
        Self::spawn(None)
    }

    pub fn with_data(file: &str) -> Self {
        Self::spawn(Some(file))
    }

    fn spawn(data: Option<&str>) -> Self {
        let script = common::repo_root().join("tests/fixtures/jira/fake-jira-server.mjs");
        let log_dir = TempDir::new().expect("fixture log dir");
        let mut command = Command::new(common::node());
        command.arg(&script);
        if let Some(file) = data {
            command
                .arg("--data")
                .arg(script.parent().unwrap().join("data").join(file));
        }
        let mut child = command
            .arg("--port")
            .arg("0")
            .arg("--log")
            .arg(log_dir.path().join("requests.jsonl"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn fake jira server");
        let line = BufReader::new(child.stdout.take().unwrap())
            .lines()
            .next()
            .unwrap()
            .unwrap();
        let port: u16 = line
            .trim()
            .strip_prefix("LISTEN ")
            .unwrap()
            .parse()
            .unwrap();
        FixtureServer {
            child,
            port,
            log_dir,
        }
    }

    pub fn site_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn request_log(&self) -> Vec<Value> {
        let Ok(text) = std::fs::read_to_string(self.log_dir.path().join("requests.jsonl")) else {
            return Vec::new();
        };
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    pub fn control(&self, path: &str, body: Value) {
        let output = Command::new("curl")
            .args([
                "-sS",
                "-f",
                "-X",
                "POST",
                "-H",
                "content-type: application/json",
                "-d",
            ])
            .arg(body.to_string())
            .arg(format!("{}/__fixture/{path}", self.site_url()))
            .output()
            .expect("curl");
        assert!(
            output.status.success(),
            "fixture control {path} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    pub fn last_search_request(&self) -> Value {
        self.request_log()
            .into_iter()
            .rev()
            .find(|e| e.get("jql").is_some())
            .expect("a search request")
    }
}

/// A board over the fake Orca (one git repo `Drogon`).
pub struct TestContext {
    pub board: common::Board,
}

impl TestContext {
    pub fn open() -> Self {
        Self {
            board: common::Board::new(),
        }
    }

    pub fn data_dir(&self) -> std::path::PathBuf {
        self.board.root.path().join("data")
    }

    pub fn jira_dir(&self) -> std::path::PathBuf {
        self.board
            .root
            .path()
            .join("data")
            .join("integrations")
            .join("jira")
    }

    pub fn call(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.board.engine.dispatch(method, &params)
    }

    pub fn ok(&self, method: &str, params: Value) -> Value {
        self.call(method, params.clone())
            .unwrap_or_else(|e| panic!("{method} should succeed, got {e:?}"))
    }

    pub fn err(&self, method: &str, params: Value) -> RpcError {
        match self.call(method, params) {
            Ok(v) => panic!("{method} should fail, got {v}"),
            Err(e) => e,
        }
    }

    /// Connects Jira in Work → Sources, as the UI does.
    pub fn connect(&self, server: &FixtureServer) -> Value {
        self.ok(
            "work.source_connect",
            json!({"provider": "jira", "siteUrl": server.site_url(), "email": FIXTURE_EMAIL, "apiKey": FIXTURE_TOKEN}),
        )
    }

    /// Adds a folder or git repo to the fake Orca (its main worktree too)
    /// and returns `{id}` like a project.
    pub fn add_repo(&self, path: &Path, kind: &str) -> Value {
        let path_text = std::fs::canonicalize(path)
            .unwrap_or(path.to_path_buf())
            .to_string_lossy()
            .to_string();
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = format!(
            "repo-{}-{}",
            path.file_name().unwrap().to_string_lossy().to_lowercase(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        self.board.edit(|s| {
            s["repos"].as_array_mut().unwrap().push(json!({"id": id, "path": path_text, "displayName": name, "kind": kind}));
            s["worktrees"].as_array_mut().unwrap().push(json!({
                "id": format!("{id}::{path_text}"), "repoId": id, "path": path_text, "displayName": "main",
                "isMainWorktree": true, "isArchived": false, "createdAt": 2
            }));
        });
        self.board.engine.refresh_mirror(true);
        json!({ "id": id, "workspaceId": format!("{id}::{path_text}") })
    }

    pub fn tick(&self, now_ms: f64) {
        self.board.engine.tick_work(now_ms);
    }
}

/// True when the token files on disk are sealed (not plaintext).
pub fn token_files_sealed(jira_dir: &Path) -> bool {
    let entries: Vec<_> = std::fs::read_dir(jira_dir.join("tokens"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert!(!entries.is_empty());
    entries
        .iter()
        .all(|path| std::fs::read(path).unwrap().starts_with(b"v1."))
}
