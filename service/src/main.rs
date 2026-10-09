//! The Work board service the Orca plugin starts: a loopback HTTP server
//! for the board UI (`/`), its RPC (`POST /rpc`) and agent events from the
//! plugin worker (`POST /events/agent-status`), plus the tick that sends
//! scheduled column prompts, watches pull requests and syncs imported
//! boards. It records `{pid, port, root, version}` in its state file and
//! stops by itself when its plugin is disabled or removed, and hands over
//! to a newer installed version of the plugin (same port).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use work_board_svc::{Engine, now_unix_ms, orca};

/// How often the tick runs (column schedules, PR watch, board sync).
const TICK_EVERY: Duration = Duration::from_secs(15);

struct Args {
    state: PathBuf,
    plugin_root: PathBuf,
    plugin_key: String,
    user_data: PathBuf,
    orca_cli: PathBuf,
    data: PathBuf,
    web: PathBuf,
    port: Option<u16>,
}

fn parse_args() -> Args {
    let args: Vec<String> = std::env::args().collect();
    let get = |name: &str| -> Option<String> {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let need = |name: &str| {
        get(name).unwrap_or_else(|| {
            eprintln!("work-board-svc: missing {name}");
            std::process::exit(2);
        })
    };
    let plugin_root = PathBuf::from(need("--plugin-root"));
    Args {
        state: PathBuf::from(need("--state")),
        plugin_key: need("--plugin-key"),
        user_data: PathBuf::from(need("--user-data")),
        orca_cli: PathBuf::from(need("--orca-cli")),
        data: PathBuf::from(need("--data")),
        web: get("--web")
            .map(PathBuf::from)
            .unwrap_or_else(|| plugin_root.join("web")),
        port: get("--port").and_then(|p| p.parse().ok()),
        plugin_root,
    }
}

/// Why the service should stop now, if it should.
fn lifecycle_check(args: &Args) -> Option<&'static str> {
    if !args.plugin_root.join("orca-plugin.json").exists() {
        return Some("removed");
    }
    if disabled_in(&args.user_data, &args.plugin_key) {
        return Some("disabled");
    }
    // Orca keeps each installed version in its own folder and names the
    // active one in `current`; a newer one takes over.
    let current = args.plugin_root.parent().map(|p| p.join("current"));
    if let Some(current) = current
        && let Ok(hash) = std::fs::read_to_string(&current)
        && let Some(own) = args.plugin_root.file_name().and_then(|n| n.to_str())
    {
        let hash = hash.trim();
        if !hash.is_empty()
            && hash != own
            && current
                .with_file_name(hash)
                .join("orca-plugin.json")
                .exists()
        {
            return Some("updated");
        }
    }
    None
}

/// Disabled when the plugin system is off or the plugin is listed as
/// disabled in any Orca profile's settings.
fn disabled_in(user_data: &Path, key: &str) -> bool {
    orca::all_profile_settings(user_data)
        .iter()
        .any(|settings| {
            settings["pluginSystemEnabled"] == false
                || settings["disabledPlugins"]
                    .as_array()
                    .is_some_and(|list| list.iter().any(|v| v == key))
        })
}

fn bind(port: Option<u16>) -> tiny_http::Server {
    // A handover reuses the previous port, which its predecessor is still
    // releasing: retry it briefly before taking any free one.
    if let Some(port) = port {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if let Ok(server) = tiny_http::Server::http(("127.0.0.1", port)) {
                return server;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    tiny_http::Server::http("127.0.0.1:0").unwrap_or_else(|e| {
        eprintln!("work-board-svc: cannot listen: {e}");
        std::process::exit(1);
    })
}

fn main() {
    let raw: Vec<String> = std::env::args().collect();
    if raw.get(1).map(String::as_str) == Some("cli") {
        std::process::exit(work_board_svc::cli::main(&raw[2..]));
    }
    let args = parse_args();
    // Orca writes its settings a moment after a change: a plugin just
    // re-enabled can still read as disabled. Look again before giving up.
    let mut refusal = lifecycle_check(&args);
    for _ in 0..30 {
        if refusal != Some("disabled") {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
        refusal = lifecycle_check(&args);
    }
    if let Some(reason) = refusal {
        eprintln!("work-board-svc: not starting ({reason})");
        return;
    }
    let mut orca = orca::Orca::new(args.orca_cli.clone(), args.user_data.clone());
    let helper = args.plugin_root.join("bin").join("orca-rpc.cjs");
    match orca::Orca::app_rpc_runner(&args.orca_cli, &helper) {
        Some(runner) => orca = orca.with_rpc(runner),
        None => eprintln!(
            "work-board-svc: folder projects limited to those with a folder workspace (no Orca runtime helper)"
        ),
    }
    let engine = match Engine::open(&args.data, orca) {
        Ok(engine) => Arc::new(engine),
        Err(e) => {
            eprintln!("work-board-svc: cannot open the board: {e}");
            std::process::exit(1);
        }
    };
    // The command line agents run (`{board.cli}` in column prompts).
    let launcher = args.data.join("bin").join("work-board");
    match args
        .plugin_root
        .parent()
        .map(|dir| work_board_svc::cli::write_launcher(&launcher, dir, &args.state))
    {
        Some(Ok(())) => engine.set_board_cli(launcher),
        Some(Err(e)) => eprintln!("work-board-svc: cannot write the work-board launcher: {e}"),
        None => {}
    }
    let server = Arc::new(bind(args.port));
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    let pid = std::process::id();
    let state = json!({
        "pid": pid,
        "port": port,
        "root": args.plugin_root,
        "version": env!("CARGO_PKG_VERSION"),
    });
    if let Some(dir) = args.state.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&args.state, state.to_string());
    eprintln!(
        "work-board-svc {} pid={pid} port={port}",
        env!("CARGO_PKG_VERSION")
    );

    for _ in 0..8 {
        let server = server.clone();
        let engine = engine.clone();
        let web = args.web.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                handle(&engine, &web, request);
            }
        });
    }
    {
        let engine = engine.clone();
        std::thread::spawn(move || {
            engine.refresh_mirror(true);
            loop {
                if engine.is_quiescent() {
                    return;
                }
                let started = Instant::now();
                engine.refresh_mirror(false);
                engine.tick_work(now_unix_ms() as f64);
                engine.sweep_prompt_files();
                std::thread::sleep(TICK_EVERY.saturating_sub(started.elapsed()));
            }
        });
    }
    loop {
        std::thread::sleep(Duration::from_secs(1));
        let Some(reason) = lifecycle_check(&args) else {
            continue;
        };
        eprintln!("work-board-svc exiting: plugin {reason}");
        engine.quiesce();
        server.unblock();
        // Still ours: keep only the port, so the board comes back at the
        // same address (no pid: nothing runs).
        if std::fs::read_to_string(&args.state)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .is_some_and(|s| s["pid"] == pid)
        {
            let _ = std::fs::write(
                &args.state,
                json!({ "port": port, "stopped": true }).to_string(),
            );
        }
        if reason == "updated" {
            hand_over(&args, port);
        }
        std::process::exit(0);
    }
}

/// Starts the newly installed version's service on this port.
fn hand_over(args: &Args, port: u16) {
    let Some(parent) = args.plugin_root.parent() else {
        return;
    };
    let Ok(hash) = std::fs::read_to_string(parent.join("current")) else {
        return;
    };
    let root = parent.join(hash.trim());
    let bin = root.join("bin").join("work-board-svc");
    let mut command = std::process::Command::new(&bin);
    command
        .args(["--state"])
        .arg(&args.state)
        .args(["--plugin-root"])
        .arg(&root)
        .args(["--plugin-key", &args.plugin_key])
        .args(["--user-data"])
        .arg(&args.user_data)
        .args(["--orca-cli"])
        .arg(&args.orca_cli)
        .args(["--data"])
        .arg(&args.data)
        .args(["--port", &port.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(args.data.join("service.log"))
                .map(std::process::Stdio::from)
                .unwrap_or_else(|_| std::process::Stdio::null()),
        );
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    if let Err(e) = command.spawn() {
        eprintln!("work-board-svc: handover to {} failed: {e}", bin.display());
    }
}

fn respond_json(request: tiny_http::Request, status: u16, body: &Value) {
    let header = tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap();
    let _ = request.respond(
        tiny_http::Response::from_string(body.to_string())
            .with_status_code(status)
            .with_header(header)
            .with_header(tiny_http::Header::from_bytes("Cache-Control", "no-store").unwrap()),
    );
}

fn handle(engine: &Engine, web: &Path, mut request: tiny_http::Request) {
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("/").to_string();
    let method = request.method().clone();
    // The board is loopback-only; a request carrying another site's Origin
    // (a page in some other tab) is refused, never executed.
    let origin = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Origin"))
        .map(|h| h.value.as_str().to_string());
    let host = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Host"))
        .map(|h| h.value.as_str().to_string())
        .unwrap_or_default();
    if let Some(origin) = &origin
        && origin != &format!("http://{host}")
    {
        return respond_json(
            request,
            403,
            &json!({ "ok": false, "error": { "code": "forbidden", "message": "cross-origin request" } }),
        );
    }
    match (method, path.as_str()) {
        (tiny_http::Method::Post, "/rpc") => {
            let mut body = String::new();
            if request
                .as_reader()
                .take(4 * 1024 * 1024)
                .read_to_string(&mut body)
                .is_err()
            {
                return respond_json(
                    request,
                    400,
                    &json!({ "ok": false, "error": { "code": "invalid_request", "message": "unreadable body" } }),
                );
            }
            let call: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let Some(name) = call["method"].as_str() else {
                return respond_json(
                    request,
                    400,
                    &json!({ "ok": false, "error": { "code": "invalid_request", "message": "method is required" } }),
                );
            };
            let params = if call["params"].is_null() {
                json!({})
            } else {
                call["params"].clone()
            };
            let reply = match engine.dispatch(name, &params) {
                Ok(result) => json!({ "ok": true, "result": result }),
                Err(e) => {
                    json!({ "ok": false, "error": { "code": e.code, "message": e.message, "retryable": e.retryable } })
                }
            };
            respond_json(request, 200, &reply);
        }
        (tiny_http::Method::Post, "/events/agent-status") => {
            // A pane's agent changed state: the next read is fresh.
            engine.mark_live_stale();
            respond_json(request, 200, &json!({ "ok": true }));
        }
        (tiny_http::Method::Post, "/events/worktrees") => {
            engine.refresh_mirror(true);
            respond_json(request, 200, &json!({ "ok": true }));
        }
        (tiny_http::Method::Get, _) => serve_static(web, &path, request),
        _ => respond_json(request, 405, &json!({ "ok": false })),
    }
}

fn serve_static(web: &Path, path: &str, request: tiny_http::Request) {
    let relative = path.trim_start_matches('/');
    let safe = !relative
        .split('/')
        .any(|seg| seg == ".." || seg.starts_with('.'));
    let mut file = web.join(if relative.is_empty() {
        "index.html"
    } else {
        relative
    });
    if !safe || !file.is_file() {
        // The UI is a single page: unknown paths get it too.
        file = web.join("index.html");
    }
    let Ok(bytes) = std::fs::read(&file) else {
        let _ = request.respond(
            tiny_http::Response::from_string("The board UI is missing from this install.")
                .with_status_code(500),
        );
        return;
    };
    let mime = match file.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("woff2") => "font/woff2",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    };
    let cache = if file.file_name().is_some_and(|n| n == "index.html") {
        "no-store"
    } else {
        "public, max-age=31536000, immutable"
    };
    let _ = request.respond(
        tiny_http::Response::from_data(bytes)
            .with_header(tiny_http::Header::from_bytes("Content-Type", mime).unwrap())
            .with_header(tiny_http::Header::from_bytes("Cache-Control", cache).unwrap()),
    );
}
