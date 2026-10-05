//! `work-board`: the board's command line, for agents in Orca terminals
//! (column prompts name it as `{board.cli}`) and for scripts. It talks to
//! the running Work board service over its loopback RPC; it never opens the
//! board's database itself.
//!
//!   work-board board [--board <id|name>] [--sprint <id|backlog>]
//!   work-board ticket show <key>
//!   work-board ticket move --ticket <key> --column <name> [--index <n>]
//!   work-board ticket create --title <t> [--column <c>] [--project <p>] [--description <d>]
//!   work-board ticket update --ticket <key> [--title <t>] [--description <d>] [--next-step <s>] [--pr <pr>]
//!   work-board ticket link --ticket <key> --session <terminal handle>
//!   work-board sends [--ticket <key>] [--column <c>]
//!   work-board rpc <method> [<json params>]
//!
//! Every command prints the service's JSON answer; an error exits 1 with
//! the message on stderr.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::time::Duration;

use serde_json::{Map, Value, json};

const USAGE: &str = "usage: work-board <board | ticket show|move|create|update|link | sends | rpc> …\n\
  work-board board [--board <id|name>] [--sprint <id|backlog>]\n\
  work-board ticket show <key>\n\
  work-board ticket move --ticket <key> --column <name> [--index <n>]\n\
  work-board ticket create --title <t> [--column <c>] [--project <p>] [--description <d>]\n\
  work-board ticket update --ticket <key> [--title <t>] [--description <d>] [--next-step <s>] [--pr <pr>]\n\
  work-board ticket link --ticket <key> --session <terminal handle>\n\
  work-board sends [--ticket <key>] [--column <c>]\n\
  work-board rpc <method> [<json params>]";

/// Flags after the command words, as `--name value` pairs.
fn flags(args: &[String]) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    let mut i = 0;
    while i < args.len() {
        let Some(name) = args[i].strip_prefix("--") else {
            return Err(format!("unexpected argument {}", args[i]));
        };
        let value = args
            .get(i + 1)
            .ok_or_else(|| format!("--{name} needs a value"))?;
        out.insert(name.to_string(), Value::String(value.clone()));
        i += 2;
    }
    Ok(out)
}

/// Maps a command onto one RPC call.
pub fn plan(args: &[String]) -> Result<(String, Value), String> {
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let rename = |f: &Map<String, Value>, pairs: &[(&str, &str)]| -> Result<Value, String> {
        let mut params = Map::new();
        for (key, value) in f {
            let Some((_, to)) = pairs.iter().find(|(from, _)| from == key) else {
                return Err(format!("unknown flag --{key}"));
            };
            let value = if *to == "index" {
                json!(
                    value
                        .as_str()
                        .and_then(|v| v.parse::<u64>().ok())
                        .ok_or("--index must be a number")?
                )
            } else {
                value.clone()
            };
            params.insert((*to).to_string(), value);
        }
        Ok(Value::Object(params))
    };
    match words.as_slice() {
        ["board", rest @ ..] => {
            let f = flags(&args[args.len() - rest.len()..])?;
            Ok((
                "work.board".into(),
                rename(
                    &f,
                    &[
                        ("board", "boardId"),
                        ("sprint", "sprintId"),
                        ("project", "projectId"),
                    ],
                )?,
            ))
        }
        ["ticket", "show", key] => Ok(("work.ticket_show".into(), json!({ "ticketId": key }))),
        ["ticket", verb @ ("move" | "create" | "update" | "link"), ..] => {
            let f = flags(&args[2..])?;
            let (method, pairs): (&str, &[(&str, &str)]) = match *verb {
                "move" => (
                    "work.ticket_move",
                    &[
                        ("ticket", "ticketId"),
                        ("column", "columnId"),
                        ("index", "index"),
                    ],
                ),
                "create" => (
                    "work.ticket_create",
                    &[
                        ("title", "title"),
                        ("column", "columnId"),
                        ("project", "projectId"),
                        ("description", "description"),
                        ("board", "boardId"),
                        ("pr", "prUrl"),
                    ],
                ),
                "update" => (
                    "work.ticket_update",
                    &[
                        ("ticket", "ticketId"),
                        ("title", "title"),
                        ("description", "description"),
                        ("next-step", "nextStep"),
                        ("pr", "prUrl"),
                    ],
                ),
                _ => (
                    "work.ticket_link_session",
                    &[("ticket", "ticketId"), ("session", "sessionId")],
                ),
            };
            Ok((method.into(), rename(&f, pairs)?))
        }
        ["sends", ..] => {
            let f = flags(&args[1..])?;
            Ok((
                "work.sends".into(),
                rename(
                    &f,
                    &[
                        ("ticket", "ticketId"),
                        ("column", "columnId"),
                        ("limit", "limit"),
                    ],
                )?,
            ))
        }
        ["rpc", method] => Ok(((*method).into(), json!({}))),
        ["rpc", method, params] => Ok((
            (*method).into(),
            serde_json::from_str(params).map_err(|e| format!("params must be JSON: {e}"))?,
        )),
        _ => Err(USAGE.to_string()),
    }
}

/// One RPC call to the service whose state file is `state`.
pub fn call(state: &Path, method: &str, params: &Value) -> Result<Value, String> {
    let text = std::fs::read_to_string(state).map_err(|_| {
        "The Work board is not running: open it in Orca (Open Work board).".to_string()
    })?;
    let state: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let port = state["port"]
        .as_u64()
        .filter(|_| state["pid"].is_u64())
        .ok_or("The Work board is not running: open it in Orca (Open Work board).")?;
    let body = json!({ "method": method, "params": params }).to_string();
    let mut stream = TcpStream::connect(("127.0.0.1", port as u16))
        .map_err(|e| format!("cannot reach the Work board on port {port}: {e}"))?;
    stream.set_read_timeout(Some(Duration::from_secs(300))).ok();
    write!(
        stream,
        "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .map_err(|e| e.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|e| e.to_string())?;
    let payload = response
        .split_once("\r\n\r\n")
        .map(|(_, b)| b)
        .unwrap_or("");
    let reply: Value = serde_json::from_str(payload.trim())
        .map_err(|_| "the Work board gave no answer".to_string())?;
    if reply["ok"] == true {
        Ok(reply["result"].clone())
    } else {
        Err(reply["error"]["message"]
            .as_str()
            .unwrap_or("the Work board refused the call")
            .to_string())
    }
}

/// `work-board-svc cli --state <file> <command…>`
pub fn main(args: &[String]) -> i32 {
    let Some(at) = args.iter().position(|a| a == "--state") else {
        eprintln!("work-board: missing --state");
        return 2;
    };
    let Some(state) = args.get(at + 1) else {
        eprintln!("work-board: missing --state value");
        return 2;
    };
    let rest: Vec<String> = args[at + 2..].to_vec();
    if rest.is_empty() || rest[0] == "--help" || rest[0] == "help" {
        println!("{USAGE}");
        return 0;
    }
    let (method, params) = match plan(&rest) {
        Ok(planned) => planned,
        Err(message) => {
            eprintln!("work-board: {message}");
            return 2;
        }
    };
    match call(Path::new(state), &method, &params) {
        Ok(result) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&result).unwrap_or_default()
            );
            0
        }
        Err(message) => {
            eprintln!("work-board: {message}");
            1
        }
    }
}

/// The launcher agents run: it finds the installed plugin version through
/// Orca's `current` marker, so it keeps working across updates.
pub fn write_launcher(path: &Path, plugin_dir: &Path, state: &Path) -> std::io::Result<()> {
    let quote = |p: &Path| crate::sessions::shell_quote(&p.to_string_lossy());
    let script = format!(
        "#!/bin/sh\n# The Work board's command line (written by the Work board service).\nroot={}\nexec \"$root/$(cat \"$root/current\")/bin/work-board-svc\" cli --state {} \"$@\"\n",
        quote(plugin_dir),
        quote(state)
    );
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, script)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(text: &[&str]) -> Vec<String> {
        text.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn commands_map_onto_board_calls() {
        assert_eq!(
            plan(&args(&[
                "ticket", "move", "--ticket", "DRG-1", "--column", "Done", "--index", "0"
            ]))
            .unwrap(),
            (
                "work.ticket_move".into(),
                json!({"ticketId": "DRG-1", "columnId": "Done", "index": 0})
            )
        );
        assert_eq!(
            plan(&args(&["ticket", "show", "APP-1"])).unwrap(),
            ("work.ticket_show".into(), json!({"ticketId": "APP-1"}))
        );
        assert_eq!(
            plan(&args(&[
                "ticket",
                "update",
                "--ticket",
                "DRG-1",
                "--next-step",
                "Ship"
            ]))
            .unwrap(),
            (
                "work.ticket_update".into(),
                json!({"ticketId": "DRG-1", "nextStep": "Ship"})
            )
        );
        assert_eq!(
            plan(&args(&["board", "--board", "7"])).unwrap(),
            ("work.board".into(), json!({"boardId": "7"}))
        );
        assert_eq!(
            plan(&args(&["rpc", "work.sources", "{}"])).unwrap(),
            ("work.sources".into(), json!({}))
        );
        assert!(
            plan(&args(&["ticket", "move", "--nope", "x"]))
                .unwrap_err()
                .contains("--nope")
        );
        assert!(
            plan(&args(&["ticket", "move", "--ticket"]))
                .unwrap_err()
                .contains("needs a value")
        );
        assert!(plan(&args(&["dance"])).unwrap_err().starts_with("usage:"));
        assert!(
            plan(&args(&["rpc", "x", "{"]))
                .unwrap_err()
                .contains("JSON")
        );
    }
}
