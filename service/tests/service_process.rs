//! The service as Orca's plugin runs it: a real `work-board-svc` process in
//! an installed-plugin layout (`plugins/clioo.work-board/<hash>/` plus
//! `current`), over the fake Orca. Its HTTP RPC, its UI files, the
//! `work-board` launcher agents run, `{board.cli}` in prompts, and its
//! lifecycle: a newer installed version takes over on the same port, and a
//! removed or disabled plugin stops it.

mod common;

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

struct Installed {
    _root: tempfile::TempDir,
    user_data: PathBuf,
    plugin_dir: PathBuf,
    data: PathBuf,
    state: PathBuf,
    children: Vec<Child>,
}

impl Drop for Installed {
    fn drop(&mut self) {
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
        // A handed-over service is not our child: stop it by its state.
        if let Some(pid) = self.state().and_then(|s| s["pid"].as_i64()) {
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
    }
}

fn install_version(plugin_dir: &Path, hash: &str) -> PathBuf {
    let root = plugin_dir.join(hash);
    std::fs::create_dir_all(root.join("bin")).unwrap();
    std::fs::create_dir_all(root.join("web")).unwrap();
    std::fs::write(root.join("orca-plugin.json"), "{}").unwrap();
    std::fs::write(
        root.join("web/index.html"),
        format!("<!doctype html><title>Work board {hash}</title>"),
    )
    .unwrap();
    std::os::unix::fs::symlink(
        env!("CARGO_BIN_EXE_work-board-svc"),
        root.join("bin/work-board-svc"),
    )
    .unwrap();
    std::fs::write(plugin_dir.join("current"), hash).unwrap();
    root
}

impl Installed {
    fn new() -> Self {
        let board = common::Board::new();
        let root = tempfile::tempdir().unwrap();
        // The fake Orca's state and CLI wrapper move into this layout.
        let user_data = root.path().join("userdata");
        std::fs::create_dir_all(&user_data).unwrap();
        std::fs::copy(
            board.user_data.join("fake-orca.json"),
            user_data.join("fake-orca.json"),
        )
        .unwrap();
        std::fs::copy(board.root.path().join("orca"), root.path().join("orca")).unwrap();
        let plugin_dir = user_data.join("plugins").join("clioo.work-board");
        install_version(&plugin_dir, "aaaa");
        let data = user_data.join("plugins-data").join("clioo.work-board");
        let state = data.join("service.json");
        let mut installed = Installed {
            _root: root,
            user_data,
            plugin_dir,
            data,
            state,
            children: Vec::new(),
        };
        installed.start("aaaa", None);
        installed
    }

    fn start(&mut self, hash: &str, port: Option<u16>) {
        let mut command = Command::new(self.plugin_dir.join(hash).join("bin/work-board-svc"));
        command
            .arg("--state")
            .arg(&self.state)
            .arg("--plugin-root")
            .arg(self.plugin_dir.join(hash))
            .args(["--plugin-key", "clioo.work-board"])
            .arg("--user-data")
            .arg(&self.user_data)
            .arg("--orca-cli")
            .arg(self.user_data.parent().unwrap().join("orca"))
            .arg("--data")
            .arg(&self.data)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(port) = port {
            command.args(["--port", &port.to_string()]);
        }
        self.children.push(command.spawn().unwrap());
        self.wait_for("the service to record its state", || {
            self.state().filter(|s| {
                s["pid"].is_u64() && s["root"].as_str().is_some_and(|r| r.ends_with(hash))
            })
        });
    }

    fn state(&self) -> Option<Value> {
        serde_json::from_str(&std::fs::read_to_string(&self.state).ok()?).ok()
    }

    fn port(&self) -> u16 {
        self.state().unwrap()["port"].as_u64().unwrap() as u16
    }

    fn wait_for<T>(&self, what: &str, mut f: impl FnMut() -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(v) = f() {
                return v;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn http(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
        origin: Option<&str>,
    ) -> (u16, String) {
        let mut args = vec![
            "-s".to_string(),
            "-o".into(),
            "-".into(),
            "-w".into(),
            "\n%{http_code}".into(),
            "-X".into(),
            method.into(),
        ];
        if let Some(body) = body {
            args.extend([
                "-H".into(),
                "content-type: application/json".into(),
                "--data-binary".into(),
                body.into(),
            ]);
        }
        if let Some(origin) = origin {
            args.extend(["-H".into(), format!("Origin: {origin}")]);
        }
        args.push(format!("http://127.0.0.1:{}{path}", self.port()));
        let out = Command::new("curl").args(&args).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let (body, code) = text.rsplit_once('\n').unwrap();
        (code.parse().unwrap(), body.to_string())
    }

    fn rpc(&self, method: &str, params: Value) -> Value {
        let (code, body) = self.http(
            "POST",
            "/rpc",
            Some(&json!({"method": method, "params": params}).to_string()),
            None,
        );
        assert_eq!(code, 200);
        let reply: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(reply["ok"], true, "{method}: {reply}");
        reply["result"].clone()
    }

    fn launcher(&self) -> PathBuf {
        self.data.join("bin").join("work-board")
    }

    fn work_board(&self, args: &[&str]) -> (i32, Value, String) {
        let out = Command::new(self.launcher()).args(args).output().unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        (
            out.status.code().unwrap_or(-1),
            serde_json::from_str(&stdout).unwrap_or(Value::Null),
            String::from_utf8_lossy(&out.stderr).to_string(),
        )
    }
}

/// Running (a zombie, exited but not yet reaped by this test, is not).
fn alive(pid: i64) -> bool {
    let out = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let stat = String::from_utf8_lossy(&out.stdout).trim().to_string();
    !stat.is_empty() && !stat.starts_with('Z')
}

#[test]
fn the_service_serves_the_board_and_its_command_line() {
    let s = Installed::new();
    let (code, html) = s.http("GET", "/", None, None);
    assert_eq!(code, 200);
    assert!(html.contains("Work board aaaa"));
    let (code, _) = s.http("GET", "/some/route", None, None);
    assert_eq!(code, 200, "the single page answers every path");
    let (code, body) = s.http(
        "POST",
        "/rpc",
        Some(r#"{"method":"work.board"}"#),
        Some("http://evil.example"),
    );
    assert_eq!(code, 403, "{body}");
    assert_eq!(
        s.rpc("board.status", json!({}))["version"],
        env!("CARGO_PKG_VERSION")
    );

    // The launcher agents run.
    let launcher = std::fs::read_to_string(s.launcher()).unwrap();
    assert!(launcher.contains("cat \"$root/current\""), "{launcher}");
    let (code, created, err) = s.work_board(&[
        "ticket",
        "create",
        "--title",
        "From an agent",
        "--project",
        "Drogon",
    ]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(created["key"], "DRG-1");
    let (code, moved, err) =
        s.work_board(&["ticket", "move", "--ticket", "DRG-1", "--column", "Review"]);
    assert_eq!(code, 0, "{err}");
    assert_eq!(
        moved["columnId"],
        s.rpc("work.board", json!({}))["columns"][2]["id"]
    );
    let (code, _, err) =
        s.work_board(&["ticket", "move", "--ticket", "DRG-9", "--column", "Review"]);
    assert_eq!(code, 1);
    assert!(err.contains("not found"), "{err}");
    let (code, _, err) = s.work_board(&["dance"]);
    assert_eq!(code, 2);
    assert!(err.contains("usage:"));

    // {board.cli} is that launcher, quoted as one shell word.
    s.rpc("work.column_update", json!({"columnId": "Review", "message": "When done: {board.cli} ticket move --ticket {ticket.key} --column \"{column.next}\""}));
    let preview = s.rpc("work.column_preview", json!({"columnId": "Review"}));
    let message = preview["previews"][0]["message"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        message,
        format!(
            "When done: '{}' ticket move --ticket DRG-1 --column \"QA\"",
            s.launcher().display()
        )
    );
}

#[test]
fn a_newer_installed_version_takes_over_on_the_same_port() {
    let s = Installed::new();
    let first = s.state().unwrap();
    s.rpc(
        "work.ticket_create",
        json!({"title": "Survives the update"}),
    );
    let port = s.port();
    install_version(&s.plugin_dir, "bbbb");
    let next = s.wait_for("the new version", || {
        s.state().filter(|st| {
            st["root"].as_str().is_some_and(|r| r.ends_with("bbbb")) && st["pid"].is_u64()
        })
    });
    assert_ne!(next["pid"], first["pid"]);
    assert_eq!(next["port"], port);
    s.wait_for("the old one to exit", || {
        (!alive(first["pid"].as_i64().unwrap())).then_some(())
    });
    let (_, html) = s.wait_for("the new UI", || {
        let reply = std::panic::catch_unwind(|| s.http("GET", "/", None, None)).ok()?;
        reply.1.contains("bbbb").then_some(reply)
    });
    assert!(html.contains("Work board bbbb"));
    assert_eq!(
        s.rpc("work.board", json!({}))["tickets"][0]["title"],
        "Survives the update"
    );
}

#[test]
fn a_removed_or_disabled_plugin_stops_its_service() {
    let mut s = Installed::new();
    let pid = s.state().unwrap()["pid"].as_i64().unwrap();
    let port = s.port();
    let profile = s.user_data.join("profiles").join("local-default");
    std::fs::create_dir_all(&profile).unwrap();
    std::fs::write(
        profile.join("orca-data.json"),
        json!({"settings": {"pluginSystemEnabled": true, "disabledPlugins": ["clioo.work-board"]}})
            .to_string(),
    )
    .unwrap();
    s.wait_for("disabled: the service exits", || {
        (!alive(pid)).then_some(())
    });
    let state = s.state().unwrap();
    assert_eq!(state["port"], port, "the port is kept for next time");
    assert!(state["pid"].is_null());
    let (code, _, err) = s.work_board(&["board"]);
    assert_eq!(code, 1);
    assert!(err.contains("not running"), "{err}");

    std::fs::write(
        profile.join("orca-data.json"),
        json!({"settings": {"pluginSystemEnabled": true, "disabledPlugins": []}}).to_string(),
    )
    .unwrap();
    s.start("aaaa", Some(port));
    assert_eq!(s.port(), port, "back at the same address");
    let pid = s.state().unwrap()["pid"].as_i64().unwrap();
    std::fs::remove_file(s.plugin_dir.join("aaaa").join("orca-plugin.json")).unwrap();
    s.wait_for("removed: the service exits", || (!alive(pid)).then_some(()));
}
