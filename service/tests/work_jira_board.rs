//! Work boards imported from Jira (`work.board_import` / `board_sync` /
//! `ticket_push` / `ticket_resolve` / `ticket_sprint`), through the public
//! `Engine` API against the stateful fake Jira (`data/agile-site.json`):
//! transitions really change status there, and the tests change "Jira" from
//! the outside through the fixture's control endpoint, the way a teammate
//! would. No test contacts Atlassian. Sessions are a shell fixture named
//! `claude` on PATH, so on-enter prompts after a "Moved by Jira" are
//! observed as real session starts.

#![cfg(unix)]

#[path = "jira_support.rs"]
mod support;

use std::io::Write as _;
use std::os::unix::fs::PermissionsExt;
use std::sync::Mutex;

use serde_json::{Value, json};
use support::{FixtureServer, TestContext};

/// PATH is process-global.
static ENV_LOCK: Mutex<()> = Mutex::new(());

struct Board {
    ctx: TestContext,
    server: FixtureServer,
    project_id: String,
    board_id: String,
    _project_dir: tempfile::TempDir,
    _path: PathGuard,
}

struct PathGuard {
    previous: Option<std::ffi::OsString>,
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl Drop for PathGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(v) => unsafe { std::env::set_var("PATH", v) },
            None => unsafe { std::env::remove_var("PATH") },
        }
    }
}

/// A `claude` stand-in that echoes argv and stays alive like a TUI.
fn fake_claude_on_path() -> PathGuard {
    let guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let dir = tempfile::tempdir().unwrap().keep();
    let path = dir.join("claude");
    let mut script = std::fs::File::create(&path).unwrap();
    script
        .write_all(b"#!/bin/sh\nfor arg in \"$@\"; do echo \"ARG:$arg\"; done\nwhile IFS= read -r line; do echo \"you said: $line\"; done\n")
        .unwrap();
    drop(script);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let previous = std::env::var_os("PATH");
    let joined = std::env::join_paths(
        std::iter::once(dir).chain(
            previous
                .as_ref()
                .map(std::env::split_paths)
                .into_iter()
                .flatten(),
        ),
    )
    .unwrap();
    unsafe { std::env::set_var("PATH", joined) };
    PathGuard {
        previous,
        _guard: guard,
    }
}

impl Board {
    /// Jira connected, a Drogon project named `Drogon`, and board 7
    /// ("Platform Delivery") imported with six chosen issues.
    fn imported() -> Self {
        let path = fake_claude_on_path();
        let server = FixtureServer::with_data("agile-site.json");
        let ctx = TestContext::open();
        ctx.connect(&server);
        let project_dir = tempfile::tempdir().unwrap();
        let folder = project_dir.path().join("Drogon");
        std::fs::create_dir_all(&folder).unwrap();
        let project = ctx.add_repo(&folder, "folder");
        let project_id = project["id"].as_str().unwrap().to_string();
        let imported = ctx.ok(
            "work.board_import",
            json!({
                "externalBoardId": "7",
                "issueKeys": ["APP-142", "APP-128", "APP-130", "APP-110", "APP-122", "APP-150"],
                "projectId": project_id,
            }),
        );
        assert_eq!(imported["imported"], 6);
        assert_eq!(imported["refreshed"], 0);
        let board_id = imported["board"]["id"].as_str().unwrap().to_string();
        Board {
            ctx,
            server,
            project_id,
            board_id,
            _project_dir: project_dir,
            _path: path,
        }
    }

    fn view(&self, sprint: Option<&str>) -> Value {
        let mut params = json!({"boardId": self.board_id});
        if let Some(sprint) = sprint {
            params["sprintId"] = json!(sprint);
        }
        self.ctx.ok("work.board", params)
    }

    fn keys(view: &Value) -> Vec<String> {
        let mut keys: Vec<String> = view["tickets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["externalKey"].as_str().unwrap().to_string())
            .collect();
        keys.sort();
        keys
    }

    fn column(&self, name: &str) -> Value {
        self.view(None)["columns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .cloned()
            .unwrap_or_else(|| panic!("column {name} missing"))
    }

    /// The ticket for a Jira key, wherever its sprint is.
    fn ticket(&self, key: &str) -> Value {
        self.ctx
            .ok("work.ticket_show", json!({"ticketId": self.ticket_id(key)}))
    }

    fn ticket_id(&self, key: &str) -> String {
        for sprint in ["active", "backlog", "24", "23", "26"] {
            if let Some(t) = self.view(Some(sprint))["tickets"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["externalKey"] == key)
            {
                return t["id"].as_str().unwrap().to_string();
            }
        }
        panic!("{key} is on no view of the board");
    }

    fn column_name_of(&self, ticket: &Value) -> String {
        self.view(None)["columns"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == ticket["columnId"])
            .map(|c| c["name"].as_str().unwrap().to_string())
            .unwrap_or_default()
    }

    fn sync(&self) -> Value {
        self.ctx
            .ok("work.board_sync", json!({"boardId": self.board_id}))
    }

    fn move_to(&self, key: &str, column: &str) -> Value {
        let column = self.column(column);
        self.ctx.ok(
            "work.ticket_move",
            json!({"ticketId": self.ticket_id(key), "columnId": column["id"]}),
        )
    }

    /// The issue as Jira holds it right now.
    fn jira_issue(&self, key: &str) -> Value {
        self.ctx
            .ok("work.import_preview", json!({"externalBoardId": "7"}))["issues"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["key"] == key)
            .cloned()
            .unwrap_or_else(|| panic!("{key} not in Jira"))
    }

    fn activity(&self, key: &str) -> Vec<String> {
        self.ticket(key)["activity"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["text"].as_str().unwrap().to_string())
            .collect()
    }
}

#[test]
fn import_lists_boards_and_brings_only_the_chosen_issues() {
    let path = fake_claude_on_path();
    let server = FixtureServer::with_data("agile-site.json");
    let ctx = TestContext::open();
    // Not connected: the provider says so in the user's words.
    let refused = ctx.err("work.provider_boards", json!({}));
    assert_eq!(refused.code, "jira_not_connected");
    assert!(refused.message.contains("Connect it in Work → Sources"));
    assert!(
        ctx.err("work.provider_boards", json!({"provider": "gitlab"}))
            .message
            .contains("unknown ticket source gitlab")
    );
    ctx.connect(&server);

    let boards = ctx.ok("work.provider_boards", json!({}));
    assert_eq!(boards["provider"], "jira");
    let names: Vec<&str> = boards["boards"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Platform Delivery", "Ops Kanban"]);
    assert_eq!(boards["boards"][0]["kind"], "scrum");
    assert_eq!(boards["boards"][0]["importedBoardId"], Value::Null);
    // Your two open issues (APP-142, APP-128) sit in Sprint 25 of board 7:
    // they are that board's own. Board 9 frames the same project APP but
    // holds none of them through a sprint, so it only shares the project's.
    assert_eq!(boards["boards"][0]["assignedOpen"], 2);
    assert_eq!(boards["boards"][0]["assignedInProject"], 2);
    assert_eq!(boards["boards"][1]["assignedOpen"], 0);
    assert_eq!(boards["boards"][1]["assignedInProject"], 2);
    // One bounded search for your unresolved issues' project and sprint,
    // after reading where the site keeps its Sprint field.
    let log = server.request_log();
    assert!(
        log.iter()
            .any(|r| r["path"].as_str().is_some_and(|p| p.ends_with("/field")))
    );
    let search = log
        .into_iter()
        .find(|r| {
            r["jql"].as_str().is_some_and(|j| {
                j.starts_with("assignee = currentUser() AND resolution = Unresolved")
            })
        })
        .expect("the recommendation search reached Jira");
    assert_eq!(search["fields"], json!(["project", "customfield_10020"]));
    assert_eq!(search["maxResults"], 100);

    let preview = ctx.ok("work.import_preview", json!({"externalBoardId": "7"}));
    assert_eq!(preview["columns"].as_array().unwrap().len(), 5);
    assert_eq!(preview["columns"][2]["statuses"][0]["name"], "In Review");
    let sprints: Vec<&str> = preview["sprints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        sprints,
        ["Sprint 23", "Sprint 24", "Sprint 25", "Sprint 26"]
    );
    assert_eq!(preview["issues"].as_array().unwrap().len(), 11);
    let backlog = ctx.ok(
        "work.import_preview",
        json!({"externalBoardId": "7", "scope": "backlog"}),
    );
    assert_eq!(backlog["issues"].as_array().unwrap().len(), 2);
    let sprint = ctx.ok(
        "work.import_preview",
        json!({"externalBoardId": "7", "scope": "sprint:25"}),
    );
    assert_eq!(sprint["issues"].as_array().unwrap().len(), 6);
    assert!(
        ctx.err(
            "work.import_preview",
            json!({"externalBoardId": "7", "scope": "nope"})
        )
        .message
        .contains("scope")
    );
    assert!(
        ctx.err("work.import_preview", json!({"externalBoardId": "404"}))
            .message
            .contains("not found")
    );

    assert!(
        ctx.err("work.board_import", json!({"externalBoardId": "7"}))
            .message
            .contains("choose the issues")
    );
    assert!(
        ctx.err(
            "work.board_import",
            json!({"externalBoardId": "7", "issueKeys": ["APP-142", "APP-999"]})
        )
        .message
        .contains("APP-999 is not on Platform Delivery")
    );

    let imported = ctx.ok(
        "work.board_import",
        json!({"externalBoardId": "7", "issueKeys": ["app-142", "APP-128"]}),
    );
    assert_eq!(imported["imported"], 2);
    let board_id = imported["board"]["id"].as_str().unwrap().to_string();
    assert_eq!(imported["board"]["name"], "Platform Delivery");
    assert_eq!(imported["board"]["provider"], "jira");
    assert_eq!(imported["board"]["kind"], "scrum");
    // The catalogue holds the site's other statuses too (Blocked), so a
    // Drogon column can map one the Jira board has no column for.
    assert!(
        imported["board"]["statuses"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["name"] == "Blocked")
    );

    // Choosing more later adds; issues already in are refreshed, not doubled.
    let again = ctx.ok(
        "work.board_import",
        json!({"externalBoardId": "7", "issueKeys": ["APP-128", "APP-130"]}),
    );
    assert_eq!(again["imported"], 1);
    assert_eq!(again["refreshed"], 1);
    assert_eq!(again["board"]["id"], board_id);
    let boards = ctx.ok("work.provider_boards", json!({}));
    assert_eq!(boards["boards"][0]["importedBoardId"], board_id.as_str());
    let preview = ctx.ok("work.import_preview", json!({"externalBoardId": "7"}));
    let marked = preview["issues"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["importedTicketId"].is_string())
        .count();
    assert_eq!(marked, 3);

    // Columns come from the Jira board, each mapped to its statuses.
    let view = ctx.ok("work.board", json!({"boardId": board_id}));
    let columns: Vec<(&str, &str, &str)> = view["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["name"].as_str().unwrap(),
                c["icon"].as_str().unwrap(),
                c["statuses"][0]["name"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        columns,
        [
            ("To Do", "todo", "To Do"),
            ("In Progress", "in_progress", "In Progress"),
            ("Review", "review", "In Review"),
            ("QA", "qa", "QA"),
            ("Done", "done", "Done"),
        ]
    );
    // The board picker: My work first, then each imported board.
    let pickers: Vec<&str> = view["boards"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["name"].as_str().unwrap())
        .collect();
    assert_eq!(pickers, ["My work", "Platform Delivery"]);
    // My work stays separate: imported tickets are not on it.
    let local = ctx.ok("work.board", json!({}));
    assert_eq!(local["board"]["id"], "local");
    assert!(local["tickets"].as_array().unwrap().is_empty());
    assert_eq!(local["columns"].as_array().unwrap().len(), 5);
    assert!(
        local["columns"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| c["boardId"].is_null())
    );

    // A kanban board has no sprints: everything is on one view.
    let kanban = ctx.ok(
        "work.board_import",
        json!({"externalBoardId": "9", "all": true}),
    );
    assert_eq!(kanban["imported"], 11);
    let kview = ctx.ok("work.board", json!({"boardId": kanban["board"]["id"]}));
    assert_eq!(kview["view"]["kind"], "all");
    assert_eq!(kview["tickets"].as_array().unwrap().len(), 11);
    let doing = kview["columns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "Doing")
        .unwrap();
    assert_eq!(doing["statuses"].as_array().unwrap().len(), 2);
    let ticket = kview["tickets"][0]["id"].clone();
    assert!(
        ctx.err(
            "work.ticket_sprint",
            json!({"ticketId": ticket, "to": "active"})
        )
        .message
        .contains("kanban")
    );

    // Removing an imported board leaves Jira and My work alone.
    let deleted = ctx.ok(
        "work.board_delete",
        json!({"boardId": kanban["board"]["id"]}),
    );
    assert_eq!(deleted["tickets"], 11);
    assert_eq!(
        ctx.ok("work.board", json!({}))["boards"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(
        ctx.err("work.board", json!({"boardId": deleted["deleted"]}))
            .message
            .contains("not found")
    );
    drop(path);
}

#[test]
fn imported_tickets_carry_jira_fields_and_a_hidden_drogon_key() {
    let b = Board::imported();
    let view = b.view(None);
    assert_eq!(view["view"]["kind"], "sprint");
    assert_eq!(view["view"]["sprint"]["name"], "Sprint 25");
    assert_eq!(view["view"]["sprint"]["state"], "active");
    assert_eq!(view["view"]["readOnly"], false);
    assert_eq!(view["view"]["promptsPaused"], false);
    assert_eq!(Board::keys(&view), ["APP-128", "APP-130", "APP-142"]);

    let t = b.ticket("APP-128");
    assert!(
        t["key"].as_str().unwrap().starts_with("DRG-"),
        "Drogon key {}",
        t["key"]
    );
    assert_eq!(t["externalKey"], "APP-128");
    assert_eq!(
        t["externalUrl"],
        format!("{}/browse/APP-128", b.server.site_url())
    );
    assert_eq!(t["title"], "Handle session resume after PR review");
    assert!(
        t["description"]
            .as_str()
            .unwrap()
            .contains("context restoration")
    );
    assert_eq!(t["issueType"], "Task");
    assert_eq!(t["priority"], "Medium");
    assert_eq!(t["assignee"], "Jon Doe");
    assert_eq!(t["externalStatus"]["name"], "In Review");
    assert_eq!(t["sync"], "synced");
    assert_eq!(t["projectId"], b.project_id.as_str());
    assert_eq!(b.column_name_of(&t), "Review");
    assert_eq!(t["sprintName"], "Sprint 25");
    assert_eq!(t["carriedFrom"], "Sprint 24");
    let timeline: Vec<(String, String)> = t["sprints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["name"].as_str().unwrap().to_string(),
                s["outcome"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        timeline,
        [
            ("Sprint 24".to_string(), "carried over".to_string()),
            ("Sprint 25".to_string(), "active".to_string())
        ]
    );
    assert!(
        b.activity("APP-128")
            .iter()
            .any(|a| a == "Imported APP-128 from Jira (In Review)")
    );
    // Jira owns title and description.
    let refused = b.ctx.err(
        "work.ticket_update",
        json!({"ticketId": t["id"], "title": "Mine"}),
    );
    assert!(
        refused
            .message
            .contains("title comes from Jira for APP-128")
    );
    // Drogon-side fields stay editable.
    let updated = b.ctx.ok(
        "work.ticket_update",
        json!({"ticketId": t["id"], "nextStep": "Resume flow", "prUrl": "#84"}),
    );
    assert_eq!(updated["prNumber"], 84);
    // A ticket created in an imported board's column is a new Jira issue
    // (a_ticket_created_on_a_jira_board_… covers it), never a Drogon-only one.
    let created = b.ctx.ok(
        "work.ticket_create",
        json!({"title": "x", "columnId": b.column("Review")["id"]}),
    );
    assert_eq!(created["provider"], "jira");
    assert!(created["externalKey"].as_str().unwrap().starts_with("APP-"));
    // A card only moves within its board.
    let local = b.ctx.ok("work.board", json!({}))["columns"][0]["id"].clone();
    assert!(
        b.ctx
            .err(
                "work.ticket_move",
                json!({"ticketId": t["id"], "columnId": local})
            )
            .message
            .contains("another board")
    );
}

#[test]
fn sprint_views_the_backlog_and_a_closed_sprints_outcome() {
    let b = Board::imported();
    let sprints: Vec<(String, String)> = b.view(None)["view"]["sprints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["name"].as_str().unwrap().to_string(),
                s["state"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(sprints[1], ("Sprint 24".to_string(), "closed".to_string()));
    assert_eq!(sprints[2], ("Sprint 25".to_string(), "active".to_string()));

    // Backlog: not in a sprint, and not finished in a closed one.
    let backlog = b.view(Some("backlog"));
    assert_eq!(backlog["view"]["kind"], "backlog");
    assert_eq!(backlog["view"]["promptsPaused"], true);
    assert_eq!(Board::keys(&backlog), ["APP-122", "APP-150"]);

    // A closed sprint: everything that passed through it, read-only.
    let closed = b.view(Some("Sprint 24"));
    assert_eq!(closed["view"]["readOnly"], true);
    assert_eq!(closed["view"]["promptsPaused"], true);
    assert_eq!(Board::keys(&closed), ["APP-110", "APP-122", "APP-128"]);
    let outcome = &closed["view"]["outcome"];
    let id = |key: &str| b.ticket_id(key);
    assert_eq!(outcome["completed"], json!([id("APP-110")]));
    assert_eq!(outcome["carried"][0]["ticketId"], id("APP-128").as_str());
    assert_eq!(outcome["carried"][0]["toSprintName"], "Sprint 25");
    assert_eq!(outcome["carried"][0]["pending"], false);
    assert_eq!(outcome["backlog"][0]["ticketId"], id("APP-122").as_str());
    assert!(
        b.ctx
            .err(
                "work.board",
                json!({"boardId": b.board_id, "sprintId": "Sprint 99"})
            )
            .message
            .contains("no sprint Sprint 99")
    );

    // Read-only: no moves in the closed sprint, nor of what finished there.
    let done = b.column("Done");
    let refused = b.ctx.err(
        "work.ticket_move",
        json!({"ticketId": id("APP-122"), "columnId": done["id"], "sprintId": "24"}),
    );
    assert!(
        refused
            .message
            .contains("Sprint 24 is closed and read-only")
    );
    let refused = b.ctx.err(
        "work.ticket_move",
        json!({"ticketId": id("APP-110"), "columnId": b.column("To Do")["id"]}),
    );
    assert!(refused.message.contains("Sprint 24 is closed"));
    // Prompts are paused outside the active sprint.
    let review = b.column("To Do");
    b.ctx.ok(
        "work.column_update",
        json!({"columnId": review["id"], "message": "Look at {ticket.key}"}),
    );
    let refused = b
        .ctx
        .err("work.column_send", json!({"ticketId": id("APP-122")}));
    assert!(refused.message.contains("prompts are paused"));

    // Carry over: the ticket joins the active sprint now, unsynced.
    assert!(
        b.ctx
            .err(
                "work.ticket_sprint",
                json!({"ticketId": id("APP-122"), "to": "24"})
            )
            .message
            .contains("closed")
    );
    assert!(
        b.ctx
            .err(
                "work.ticket_sprint",
                json!({"ticketId": id("APP-122"), "to": "backlog"})
            )
            .message
            .contains("already in the backlog")
    );
    let carried = b.ctx.ok(
        "work.ticket_sprint",
        json!({"ticketId": id("APP-122"), "to": "active"}),
    );
    assert_eq!(carried["sprintName"], "Sprint 25");
    assert_eq!(carried["sprintPending"], true);
    assert_eq!(carried["sync"], "pending");
    assert_eq!(carried["carriedFrom"], "Sprint 24");
    assert!(Board::keys(&b.view(None)).contains(&"APP-122".to_string()));
    assert_eq!(b.view(None)["board"]["pendingCount"], 1);
    let closed = b.view(Some("24"));
    assert_eq!(
        closed["view"]["outcome"]["carried"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        b.jira_issue("APP-122")["sprint"],
        Value::Null,
        "Jira is untouched until pushed"
    );
    // A sync before the push keeps the unsynced carry-over.
    b.sync();
    assert_eq!(b.ticket("APP-122")["sprintPending"], true);

    let pushed = b
        .ctx
        .ok("work.ticket_push", json!({"ticketId": id("APP-122")}));
    assert_eq!(pushed["pushed"], true);
    assert_eq!(pushed["fields"], json!(["sprint"]));
    assert_eq!(pushed["ticket"]["sync"], "synced");
    assert_eq!(b.jira_issue("APP-122")["sprint"]["name"], "Sprint 25");
    assert!(
        b.activity("APP-122")
            .iter()
            .any(|a| a == "Pushed to Jira: moved to Sprint 25")
    );
    assert_eq!(b.view(None)["board"]["pendingCount"], 0);

    // Send to backlog, then Jira moves it elsewhere first: Jira wins.
    let sent = b.ctx.ok(
        "work.ticket_sprint",
        json!({"ticketId": id("APP-122"), "to": "backlog"}),
    );
    assert_eq!(sent["sprintPending"], true);
    b.server.control("issue/APP-122", json!({"sprintId": 26}));
    b.sync();
    let t = b.ticket("APP-122");
    assert_eq!(t["sprintName"], "Sprint 26");
    assert_eq!(t["sprintPending"], false);
    assert!(
        b.activity("APP-122")
            .iter()
            .any(|a| a
                == "Jira moved it to Sprint 26; your unsynced move to the backlog was dropped")
    );
    // Nothing left to push is not an error.
    assert_eq!(
        b.ctx
            .ok("work.ticket_push", json!({"ticketId": id("APP-122")}))["nothing"],
        true
    );
    // A refused sprint push keeps the change and shows Jira's error.
    b.server.control("sprint/26", json!({"state": "closed"}));
    b.ctx.ok(
        "work.ticket_sprint",
        json!({"ticketId": id("APP-150"), "to": "26"}),
    ); // still future locally
    let refused = b
        .ctx
        .ok("work.ticket_push", json!({"ticketId": id("APP-150")}));
    assert_eq!(refused["pushed"], false);
    assert!(
        refused["error"]
            .as_str()
            .unwrap()
            .contains("Issues can only be moved to an open sprint"),
        "{refused}"
    );
    let t = b.ticket("APP-150");
    assert_eq!(t["sync"], "error");
    assert_eq!(t["sprintPending"], true);
}

#[test]
fn a_local_move_waits_for_push_and_a_refusal_keeps_the_card() {
    let b = Board::imported();
    // Drop into a mapped column: Drogon only, marked unsynced.
    let moved = b.move_to("APP-142", "In Progress");
    assert_eq!(moved["sync"], "pending");
    assert_eq!(moved["pendingStatus"]["name"], "In Progress");
    assert_eq!(b.jira_issue("APP-142")["status"]["name"], "To Do");
    assert_eq!(b.view(None)["board"]["pendingCount"], 1);
    assert!(
        b.activity("APP-142")
            .iter()
            .any(|a| a == "Moved To Do → In Progress; not synced to Jira")
    );
    // Back where Jira has it: in sync again, nothing to push.
    let back = b.move_to("APP-142", "To Do");
    assert_eq!(back["sync"], "synced");
    assert_eq!(back["pendingStatus"], Value::Null);

    // Push: Jira transitions for real.
    b.move_to("APP-142", "Review");
    let pushed = b.ctx.ok(
        "work.ticket_push",
        json!({"ticketId": b.ticket_id("APP-142")}),
    );
    assert_eq!(pushed["pushed"], true, "{pushed}");
    assert_eq!(pushed["ticket"]["externalStatus"]["name"], "In Review");
    assert_eq!(pushed["ticket"]["sync"], "synced");
    assert_eq!(b.jira_issue("APP-142")["status"]["name"], "In Review");
    assert!(
        b.activity("APP-142")
            .iter()
            .any(|a| a == "Pushed to Jira: status → In Review")
    );
    // A sync afterwards changes nothing.
    let synced = b.sync();
    assert_eq!(synced["moved"], 0);
    assert_eq!(synced["conflicts"], 0);

    // An unmapped Drogon column moves the card in Drogon only.
    let parking = b.ctx.ok(
        "work.column_create",
        json!({"boardId": b.board_id, "name": "Parking", "icon": "backlog"}),
    );
    assert_eq!(parking["boardId"], b.board_id.as_str());
    assert_eq!(parking["statuses"], json!([]));
    let parked = b.move_to("APP-130", "Parking");
    assert_eq!(parked["sync"], "synced");
    assert!(
        b.activity("APP-130")
            .iter()
            .any(|a| a == "Moved In Progress → Parking (a board-only column)")
    );

    // A column mapped to a status Jira's workflow cannot reach: the push is
    // refused, the card stays, the error shows.
    let blocked = b.ctx.ok(
        "work.column_create",
        json!({"boardId": b.board_id, "name": "Blocked", "icon": "blocked"}),
    );
    let mapped = b.ctx.ok(
        "work.column_update",
        json!({"columnId": blocked["id"], "statusIds": ["Blocked"]}),
    );
    assert_eq!(mapped["statuses"][0]["id"], "10102");
    assert!(
        b.ctx
            .err(
                "work.column_update",
                json!({"columnId": blocked["id"], "statusIds": ["Nope"]})
            )
            .message
            .contains("has no status Nope")
    );
    b.move_to("APP-130", "Blocked");
    let refused = b.ctx.ok("work.board_push", json!({"boardId": b.board_id}));
    assert_eq!(refused["failed"], 1);
    assert_eq!(refused["pushed"], 0);
    assert!(
        refused["results"][0]["error"]
            .as_str()
            .unwrap()
            .contains("no transition"),
        "{refused}"
    );
    let t = b.ticket("APP-130");
    assert_eq!(t["sync"], "error");
    assert_eq!(b.column_name_of(&t), "Blocked");
    assert!(
        t["pushError"]
            .as_str()
            .unwrap()
            .contains("reachable: To Do, In Review, QA, Done")
    );
    assert_eq!(b.jira_issue("APP-130")["status"]["name"], "In Progress");
    assert!(
        b.activity("APP-130")
            .iter()
            .any(|a| a.starts_with("Jira refused the push:"))
    );
    // Jira's own refusal (the issue is gone there) reads as Jira's error.
    b.move_to("APP-128", "QA");
    b.server.control("issue/APP-128", json!({"deleted": true}));
    let gone = b.ctx.ok(
        "work.ticket_push",
        json!({"ticketId": b.ticket_id("APP-128")}),
    );
    assert_eq!(gone["pushed"], false);
    assert!(
        gone["error"].as_str().unwrap().contains("does not exist"),
        "{gone}"
    );
    // My work tickets have nothing to push.
    let local = b.ctx.ok("work.ticket_create", json!({"title": "Local"}));
    assert!(
        b.ctx
            .err("work.ticket_push", json!({"ticketId": local["id"]}))
            .message
            .contains("My work ticket")
    );
}

#[test]
fn jira_changes_move_cards_fire_prompts_and_flag_conflicts_unmapped_and_removed() {
    let b = Board::imported();
    // Review sends its prompt on enter.
    let review = b.column("Review");
    b.ctx.ok(
        "work.column_update",
        json!({"columnId": review["id"], "sendOnEnter": true, "message": "Review {ticket.key}", "harnessId": "claude"}),
    );

    // Jira moves APP-130 (no pending move): the card follows and the
    // column's prompt fires (a fresh session: nothing linked yet).
    b.server
        .control("issue/APP-130", json!({"status": "In Review"}));
    let synced = b.sync();
    assert_eq!(synced["moved"], 1, "{synced}");
    let t = b.ticket("APP-130");
    assert_eq!(b.column_name_of(&t), "Review");
    assert_eq!(t["externalStatus"]["name"], "In Review");
    assert!(
        b.activity("APP-130")
            .iter()
            .any(|a| a == "Moved by Jira: In Progress → Review")
    );
    assert_eq!(synced["deliveries"][0]["trigger"], "enter");
    assert_eq!(
        synced["deliveries"][0]["results"][0]["action"], "started",
        "{synced}"
    );
    assert_eq!(t["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(t["sends"][0]["message"], "Review APP-130");

    // A backlog ticket moved by Jira moves too, but prompts stay paused.
    b.server
        .control("issue/APP-150", json!({"status": "In Review"}));
    let synced = b.sync();
    assert_eq!(synced["moved"], 1);
    assert!(synced["deliveries"].as_array().unwrap().is_empty());

    // Jira changes status while a local move is pending: a conflict.
    b.move_to("APP-142", "QA");
    b.server.control("issue/APP-142", json!({"status": "Done"}));
    let synced = b.sync();
    assert_eq!(synced["conflicts"], 1);
    let t = b.ticket("APP-142");
    assert_eq!(t["sync"], "conflict");
    assert_eq!(t["statusConflict"], true);
    assert_eq!(t["externalStatus"]["name"], "Done");
    assert_eq!(t["pendingStatus"]["name"], "QA");
    assert_eq!(
        b.column_name_of(&t),
        "QA",
        "the card stays until the user decides"
    );
    assert!(
        b.activity("APP-142")
            .iter()
            .any(|a| a == "Jira moved it to Done while your move to QA was unsynced")
    );
    assert!(
        b.ctx
            .err(
                "work.ticket_resolve",
                json!({"ticketId": t["id"], "keep": "maybe"})
            )
            .message
            .contains("keep must be")
    );
    // Use Jira's: the card goes to Jira's column.
    let kept = b.ctx.ok(
        "work.ticket_resolve",
        json!({"ticketId": t["id"], "keep": "jira"}),
    );
    assert_eq!(kept["sync"], "synced");
    assert_eq!(b.column_name_of(&kept), "Done");
    assert!(
        b.ctx
            .err(
                "work.ticket_resolve",
                json!({"ticketId": t["id"], "keep": "jira"})
            )
            .message
            .contains("no unsynced move")
    );

    // Push ours: Jira takes our status.
    b.move_to("APP-142", "QA");
    b.server
        .control("issue/APP-142", json!({"status": "In Progress"}));
    b.sync();
    let ours = b.ctx.ok(
        "work.ticket_resolve",
        json!({"ticketId": b.ticket_id("APP-142"), "keep": "ours"}),
    );
    assert_eq!(ours["push"]["pushed"], true, "{ours}");
    assert_eq!(ours["sync"], "synced");
    assert_eq!(b.jira_issue("APP-142")["status"]["name"], "QA");

    // Jira reaching our pending status by itself settles it.
    b.move_to("APP-142", "Done");
    b.server.control("issue/APP-142", json!({"status": "Done"}));
    b.sync();
    let t = b.ticket("APP-142");
    assert_eq!(t["sync"], "synced");
    assert!(
        b.activity("APP-142")
            .iter()
            .any(|a| a == "Jira now matches your move: Done")
    );

    // A status no column maps: the card stays, flagged; mapping it moves it.
    b.server
        .control("issue/APP-128", json!({"status": "Blocked"}));
    b.sync();
    let t = b.ticket("APP-128");
    assert_eq!(t["sync"], "unmapped");
    assert_eq!(t["statusUnmapped"], true);
    assert_eq!(b.column_name_of(&t), "Review");
    assert!(
        b.activity("APP-128")
            .iter()
            .any(|a| a
                == "Jira status 'Blocked' is not mapped to a column; the card stays in Review")
    );
    let blocked = b.ctx.ok(
        "work.column_create",
        json!({"boardId": b.board_id, "name": "Blocked", "icon": "blocked"}),
    );
    b.ctx.ok(
        "work.column_update",
        json!({"columnId": blocked["id"], "statusIds": ["10102"]}),
    );
    let t = b.ticket("APP-128");
    assert_eq!(t["sync"], "synced");
    assert_eq!(b.column_name_of(&t), "Blocked");
    // Mapping moves a status between columns (one home per status).
    let review = b.column("Review");
    b.ctx.ok(
        "work.column_update",
        json!({"columnId": review["id"], "statusIds": ["10100", "10102"]}),
    );
    assert_eq!(b.column("Blocked")["statuses"], json!([]));
    assert_eq!(b.column("Review")["statuses"].as_array().unwrap().len(), 2);

    // Jira wins for the fields it owns.
    b.server.control(
        "issue/APP-128",
        json!({"summary": "Resume sessions after review"}),
    );
    b.sync();
    assert_eq!(b.ticket("APP-128")["title"], "Resume sessions after review");

    // Gone from Jira: flagged, never deleted, and back when it returns.
    b.server.control("issue/APP-150", json!({"deleted": true}));
    let synced = b.sync();
    assert_eq!(synced["removed"], 1);
    let t = b.ticket("APP-150");
    assert_eq!(t["sync"], "removed");
    assert_eq!(t["removed"], true);
    assert!(
        b.activity("APP-150")
            .iter()
            .any(|a| a == "Not in Jira anymore; kept here with its sessions")
    );
    assert_eq!(b.sync()["removed"], 0, "flagged once");
    b.server.control("issue/APP-150", json!({"deleted": false}));
    b.sync();
    assert_eq!(b.ticket("APP-150")["removed"], false);
    assert!(b.activity("APP-150").iter().any(|a| a == "Back in Jira"));
}

#[test]
fn sessions_start_from_a_ticket_and_take_a_name() {
    let b = Board::imported();
    let id = b.ticket_id("APP-128");
    let started = b.ctx.ok(
        "work.ticket_session_start",
        json!({"ticketId": id, "harnessId": "claude"}),
    );
    let session = started["session"]["id"].as_str().unwrap().to_string();
    assert_eq!(started["sessions"][0]["id"], session.as_str());
    assert!(
        started["workspaceId"].is_string(),
        "the ticket adopts the project's workspace"
    );
    let renamed = b.ctx.ok(
        "work.ticket_session_rename",
        json!({"ticketId": id, "sessionId": session, "title": "Implement"}),
    );
    assert_eq!(renamed["sessions"][0]["label"], "Implement");
    let cleared = b.ctx.ok(
        "work.ticket_session_rename",
        json!({"ticketId": id, "sessionId": session, "title": ""}),
    );
    assert!(cleared["sessions"][0].get("label").is_none());
    assert!(
        b.ctx
            .err(
                "work.ticket_session_rename",
                json!({"ticketId": id, "sessionId": "nope", "title": "x"})
            )
            .message
            .contains("not linked")
    );
    assert!(
        b.activity("APP-128")
            .iter()
            .any(|a| a == "Started a claude session")
    );
    // A board-wide project: every ticket without one takes it, and a
    // session starts there.
    let (_dir2, other) = {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("Waman");
        std::fs::create_dir_all(&folder).unwrap();
        let id = b.ctx.add_repo(&folder, "folder")["id"]
            .as_str()
            .unwrap()
            .to_string();
        (dir, id)
    };
    let moved = b.ctx.ok(
        "work.board_update",
        json!({"boardId": b.board_id, "projectId": other}),
    );
    assert_eq!(moved["projectId"], other.as_str());
    let t = b.ctx.ok("work.ticket_show", json!({"ticketId": "APP-142"}));
    assert_eq!(
        t["projectId"],
        other.as_str(),
        "the board's previous project follows the board"
    );
    let cleared = b.ctx.ok(
        "work.board_update",
        json!({"boardId": b.board_id, "projectId": null}),
    );
    assert_eq!(cleared["projectId"], Value::Null);
    let t = b.ctx.ok("work.ticket_show", json!({"ticketId": "APP-142"}));
    assert_eq!(t["projectId"], Value::Null);
    let refused = b
        .ctx
        .err("work.ticket_session_start", json!({"ticketId": "APP-142"}));
    assert!(
        refused.message.contains("Agents work in"),
        "{}",
        refused.message
    );
    b.ctx.ok(
        "work.board_update",
        json!({"boardId": b.board_id, "projectId": "Waman"}),
    );
    let started = b.ctx.ok(
        "work.ticket_session_start",
        json!({"ticketId": "APP-142", "harnessId": "claude"}),
    );
    assert!(started["workspaceId"].is_string());
    // A ticket with neither workspace nor project cannot start one.
    let local = b.ctx.ok("work.ticket_create", json!({"title": "Nowhere"}));
    assert!(
        b.ctx
            .err(
                "work.ticket_session_start",
                json!({"ticketId": local["id"]})
            )
            .message
            .contains("no workspace or project")
    );
}

#[test]
fn the_scheduler_syncs_imported_boards_every_five_minutes() {
    let b = Board::imported();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64;
    b.server
        .control("issue/APP-142", json!({"status": "In Progress"}));
    // Just imported: not due yet.
    b.ctx.tick(now + 60_000.0);
    assert_eq!(b.column_name_of(&b.ticket("APP-142")), "To Do");
    // Five minutes on: the tick syncs and the card follows Jira.
    b.ctx.tick(now + 6.0 * 60_000.0);
    assert_eq!(b.column_name_of(&b.ticket("APP-142")), "In Progress");
    assert!(b.view(None)["board"]["lastSyncedAt"].as_i64().unwrap() > 0);
    // A failed sync is recorded on the board, not thrown at the tick.
    drop(b.server);
    let failed = b.ctx.err("work.board_sync", json!({"boardId": b.board_id}));
    assert!(!failed.message.is_empty());
    assert!(
        b.ctx.ok("work.board", json!({"boardId": b.board_id}))["board"]["lastSyncError"]
            .is_string()
    );
}

#[test]
fn tickets_resolve_by_their_jira_key_unless_two_boards_share_it() {
    let b = Board::imported();
    let t = b.ctx.ok("work.ticket_show", json!({"ticketId": "app-128"}));
    assert_eq!(t["externalKey"], "APP-128");
    let drogon_key = t["key"].as_str().unwrap().to_string();
    // The same issue on a second (kanban) board: the Jira key is ambiguous.
    b.ctx.ok(
        "work.board_import",
        json!({"externalBoardId": "9", "issueKeys": ["APP-128"]}),
    );
    let refused = b
        .ctx
        .err("work.ticket_show", json!({"ticketId": "APP-128"}));
    assert!(
        refused.message.contains("more than one board"),
        "{}",
        refused.message
    );
    assert_eq!(
        b.ctx
            .ok("work.ticket_show", json!({"ticketId": drogon_key}))["externalKey"],
        "APP-128"
    );
}

/// Only what is yours, plus what you pick: `mine` imports the issues
/// assigned to the connected account, and `autoImportMine` keeps bringing
/// in new ones on sync.
#[test]
fn mine_imports_your_issues_and_auto_import_follows_new_assignments() {
    let path = fake_claude_on_path();
    let server = FixtureServer::with_data("agile-site.json");
    let ctx = TestContext::open();
    ctx.connect(&server);
    // The picker: facets and the "me" filter.
    let preview = ctx.ok(
        "work.import_preview",
        json!({"externalBoardId": "7", "assignee": "me"}),
    );
    assert_eq!(preview["me"], "fixture-user-1");
    let mine: Vec<&str> = preview["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["key"].as_str().unwrap())
        .collect();
    assert_eq!(mine, ["APP-142", "APP-128"]);
    assert_eq!(preview["facets"]["mine"], 2);
    assert_eq!(preview["facets"]["unassigned"], 1);
    let people: Vec<&str> = preview["facets"]["people"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert!(
        people.contains(&"Jon Doe") && people.contains(&"Ana Lopez"),
        "{people:?}"
    );
    let none = ctx.ok(
        "work.import_preview",
        json!({"externalBoardId": "7", "assignee": "none"}),
    );
    assert_eq!(none["issues"][0]["key"], "APP-150");
    let ana = ctx.ok(
        "work.import_preview",
        json!({"externalBoardId": "7", "assignee": "u-al", "query": "session"}),
    );
    let keys: Vec<&str> = ana["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, ["APP-149"]);
    assert_eq!(ana["total"], 1);
    assert_eq!(
        ana["facets"]["mine"], 2,
        "facets count every issue, not the filtered ones"
    );

    // Mine plus one picked by hand, keeping new assignments coming.
    let imported = ctx.ok(
        "work.board_import",
        json!({"externalBoardId": "7", "mine": true, "issueKeys": ["APP-130"], "autoImportMine": true}),
    );
    assert_eq!(imported["imported"], 3);
    assert_eq!(imported["board"]["autoImportMine"], true);
    let board = imported["board"]["id"].as_str().unwrap().to_string();

    // Assigned to you later in Jira: it comes in on the next sync.
    server.control(
        "issue/APP-150",
        json!({"assignee": {"accountId": "fixture-user-1", "displayName": "Jon Doe"}}),
    );
    let synced = ctx.ok("work.board_sync", json!({"boardId": board}));
    assert_eq!(synced["imported"], 1, "{synced}");
    let t = ctx.ok("work.ticket_show", json!({"ticketId": "APP-150"}));
    assert!(
        t["activity"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["text"] == "Assigned to you in Jira: imported on sync")
    );
    assert_eq!(
        ctx.ok("work.board_sync", json!({"boardId": board}))["imported"],
        0,
        "once"
    );

    // A sync never lists the board's whole history: it asks the board for
    // the imported keys and, with auto-import on, your unresolved issues.
    let listings: Vec<String> = server
        .request_log()
        .into_iter()
        .filter(|r| {
            r["path"]
                .as_str()
                .is_some_and(|p| p.ends_with("/board/7/issue"))
        })
        .filter_map(|r| r["jql"].as_str().map(str::to_owned))
        .collect();
    let last = listings.last().expect("the sync asked the board by JQL");
    assert!(last.starts_with("key in ("), "{last}");
    for key in ["APP-142", "APP-128", "APP-130", "APP-150"] {
        assert!(last.contains(&format!("\"{key}\"")), "{key} in {last}");
    }
    assert!(
        last.ends_with("OR (assignee = currentUser() AND resolution = Unresolved)"),
        "{last}"
    );

    // Turned off: a new assignment stays in Jira.
    let off = ctx.ok(
        "work.board_update",
        json!({"boardId": board, "autoImportMine": false}),
    );
    assert_eq!(off["autoImportMine"], false);
    server.control(
        "issue/APP-146",
        json!({"assignee": {"accountId": "fixture-user-1", "displayName": "Jon Doe"}}),
    );
    assert_eq!(
        ctx.ok("work.board_sync", json!({"boardId": board}))["imported"],
        0
    );
    // Off, it asks only for what is already imported.
    let off_jql = server
        .request_log()
        .into_iter()
        .filter(|r| {
            r["path"]
                .as_str()
                .is_some_and(|p| p.ends_with("/board/7/issue"))
        })
        .filter_map(|r| r["jql"].as_str().map(str::to_owned))
        .next_back()
        .unwrap();
    assert!(!off_jql.contains("currentUser"), "{off_jql}");
    assert!(
        ctx.err("work.ticket_show", json!({"ticketId": "APP-146"}))
            .message
            .contains("not found")
    );
    // Finished work is history: a Done issue assigned to you stays out.
    ctx.ok(
        "work.board_update",
        json!({"boardId": board, "autoImportMine": true}),
    );
    server.control(
        "issue/APP-110",
        json!({"assignee": {"accountId": "fixture-user-1", "displayName": "Jon Doe"}}),
    );
    let synced = ctx.ok("work.board_sync", json!({"boardId": board}));
    assert_eq!(synced["imported"], 1, "APP-146 (open) only: {synced}");
    assert!(
        ctx.err("work.ticket_show", json!({"ticketId": "APP-110"}))
            .message
            .contains("not found")
    );
    assert!(
        ctx.err("work.board_import", json!({"externalBoardId": "7"}))
            .message
            .contains("mine: true")
    );
    drop(path);
}

/// A Jira issue created from the board: Task by default (or the chosen
/// type), moved to the column's status through the workflow, in the sprint
/// being worked, assigned to the owner.
#[test]
fn a_ticket_created_on_a_jira_board_is_a_new_jira_issue_in_that_column() {
    let b = Board::imported();
    let options = b
        .ctx
        .ok("work.create_options", json!({"boardId": b.board_id}));
    let names: Vec<&str> = options["issueTypes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        ["Task", "Bug", "Feature"],
        "Task first, no sub-tasks"
    );
    let created = b.ctx.ok(
        "work.ticket_create",
        json!({"boardId": b.board_id, "columnId": "Review", "title": "Created from Drogon", "description": "Body"}),
    );
    assert_eq!(created["externalKey"], "APP-151");
    assert_eq!(created["issueType"], "Task");
    assert_eq!(
        created["externalStatus"]["name"], "In Review",
        "moved through the workflow"
    );
    assert_eq!(created["sprintName"], "Sprint 25");
    assert_eq!(created["assignee"], "Jon Doe");
    assert_eq!(b.column_name_of(&created), "Review");
    let bug = b.ctx.ok(
        "work.ticket_create",
        json!({"boardId": b.board_id, "title": "A bug", "issueType": "1", "sprintId": "backlog"}),
    );
    assert_eq!(bug["issueType"], "Bug");
    // Sessions link at creation; an unknown one refuses before Jira is touched.
    let refused = b.ctx.err(
        "work.ticket_create",
        json!({"boardId": b.board_id, "title": "x", "sessionIds": ["nope"]}),
    );
    assert!(refused.message.contains("session nope not found"));
    let started = b.ctx.ok(
        "work.ticket_session_start",
        json!({"ticketId": "APP-151", "harnessId": "claude"}),
    );
    let session = started["session"]["id"].clone();
    let linked = b.ctx.ok(
        "work.ticket_create",
        json!({"boardId": b.board_id, "title": "Linked", "sessionIds": [session]}),
    );
    assert_eq!(linked["sessions"][0]["id"], session);
    assert_eq!(
        linked["externalKey"], "APP-153",
        "the refused create made nothing in Jira"
    );
    assert_eq!(bug["sprintId"], Value::Null);
    assert_eq!(b.column_name_of(&bug), "To Do");
}

/// New session on a ticket starts in the ticket's own worktree in a git
/// project (named after the ticket, reused, made again when archived); an
/// Orca folder repo has one checkout, so its tickets work there.
#[test]
fn new_session_on_a_ticket_makes_and_reuses_its_own_worktree() {
    let b = Board::imported();
    let worktrees = |repo: &str| -> Vec<Value> {
        b.ctx.board.state()["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|w| w["repoId"] == repo)
            .cloned()
            .collect()
    };
    // A folder project: the session starts in its own (only) checkout.
    let folder = b.ctx.ok(
        "work.ticket_session_start",
        json!({"ticketId": b.ticket_id("APP-128"), "harnessId": "claude"}),
    );
    assert_eq!(
        worktrees(&b.project_id).len(),
        1,
        "no worktree for a folder repo"
    );
    assert_eq!(folder["workspaceId"], worktrees(&b.project_id)[0]["id"]);

    // A git project: a worktree named after the ticket, reused, remade.
    let repo_dir = tempfile::tempdir().unwrap();
    let repo = repo_dir.path().join("app");
    std::fs::create_dir_all(&repo).unwrap();
    let git_project = b.ctx.add_repo(&repo, "git")["id"]
        .as_str()
        .unwrap()
        .to_string();
    b.ctx.ok(
        "work.board_update",
        json!({"boardId": b.board_id, "projectId": git_project}),
    );
    let id = b.ticket_id("APP-130");
    let title = b.ticket("APP-130")["title"].as_str().unwrap().to_string();
    let first = b.ctx.ok(
        "work.ticket_session_start",
        json!({"ticketId": id, "harnessId": "claude"}),
    );
    let workspace = first["workspaceId"].as_str().unwrap().to_string();
    let own = worktrees(&git_project)
        .into_iter()
        .find(|w| w["id"] == workspace.as_str())
        .expect("the ticket's worktree");
    assert!(
        own["displayName"].as_str().unwrap().starts_with("app-130-"),
        "{own}"
    );
    assert_eq!(own["comment"], "Sessions for APP-130");
    assert!(
        b.activity("APP-130")
            .iter()
            .any(|a| a.starts_with("Made a workspace for this ticket: app-130-")),
        "{title}"
    );
    let second = b.ctx.ok(
        "work.ticket_session_start",
        json!({"ticketId": id, "harnessId": "claude"}),
    );
    assert_eq!(second["workspaceId"], workspace.as_str());
    let other = b.ctx.ok(
        "work.ticket_session_start",
        json!({"ticketId": b.ticket_id("APP-142"), "harnessId": "claude"}),
    );
    assert_ne!(other["workspaceId"], workspace.as_str());
    assert_eq!(worktrees(&git_project).len(), 3);
    // Archived in Orca, it is made again.
    let archived = workspace.clone();
    b.ctx.board.edit(|s| {
        for w in s["worktrees"].as_array_mut().unwrap() {
            if w["id"] == archived.as_str() {
                w["isArchived"] = json!(true);
            }
        }
    });
    b.ctx.board.engine.refresh_mirror(true);
    let again = b.ctx.ok(
        "work.ticket_session_start",
        json!({"ticketId": id, "harnessId": "claude"}),
    );
    assert_ne!(again["workspaceId"], workspace.as_str());
}

/// Jira connects in Work → Sources: the site, the email and an API token,
/// checked against the site and sealed on disk; a wrong token is refused;
/// disconnect forgets it.
#[test]
fn jira_connects_in_sources_with_a_sealed_token_and_disconnects() {
    let server = FixtureServer::with_data("agile-site.json");
    let ctx = TestContext::open();
    let wrong = ctx.err(
        "work.source_connect",
        json!({"provider": "jira", "siteUrl": server.site_url(), "email": support::FIXTURE_EMAIL, "apiKey": "wrong"}),
    );
    assert!(!wrong.message.is_empty());
    assert!(
        ctx.err(
            "work.source_connect",
            json!({"provider": "jira", "siteUrl": server.site_url(), "apiKey": "x"})
        )
        .message
        .contains("Email and API token are required")
    );
    let connected = ctx.connect(&server);
    assert_eq!(connected["connected"], true);
    assert_eq!(connected["via"], "token");
    assert!(
        connected["account"]
            .as_str()
            .unwrap()
            .starts_with("127.0.0.1:")
    );
    assert!(support::token_files_sealed(&ctx.jira_dir()));
    assert!(
        !ctx.ok("work.provider_boards", json!({"provider": "jira"}))["boards"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let gone = ctx.ok("work.source_disconnect", json!({"provider": "jira"}));
    assert_eq!(gone["connected"], false);
    assert_eq!(
        ctx.err("work.provider_boards", json!({"provider": "jira"}))
            .code,
        "jira_not_connected"
    );
}

/// A folder project like Orca's `pre-sales`: a project group on a folder,
/// with one folder workspace already named for APP-128.
fn add_folder_project(b: &Board) -> String {
    b.ctx.board.edit(|state| {
        state["projectGroups"] = json!([{ "id": "g-presales", "name": "pre-sales", "parentPath": "/fixture/pre-sales" }]);
        state["folderWorkspaces"] = json!([
            { "id": "fw-existing", "projectGroupId": "g-presales", "name": "APP-128-session-resume", "folderPath": "/fixture/pre-sales", "isArchived": false },
            { "id": "fw-other", "projectGroupId": "g-presales", "name": "Landing page", "folderPath": "/fixture/pre-sales", "isArchived": false }
        ]);
    });
    b.ctx.board.engine.refresh_mirror(true);
    "folder-workspace:g-presales".to_string()
}

#[test]
fn a_folder_project_is_where_agents_work_and_each_ticket_gets_its_folder_workspace() {
    let b = Board::imported();
    let presales = add_folder_project(&b);
    // It is one of the projects the board offers, beside the repos.
    let projects = b.view(None)["projects"].clone();
    let offered = projects
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == presales.as_str())
        .cloned()
        .expect("pre-sales offered");
    assert_eq!(offered["name"], "pre-sales");
    assert_eq!(offered["kind"], "folder-group");
    let updated = b.ctx.ok(
        "work.board_update",
        json!({"boardId": b.board_id, "projectId": presales}),
    );
    assert_eq!(updated["projectId"], presales.as_str());
    assert!(
        updated.get("workspaceId").is_none(),
        "no second, per-worktree setting"
    );
    assert_eq!(b.ticket("APP-142")["projectId"], presales.as_str());

    // APP-128 worked in the Drogon repo before the board moved to pre-sales:
    // that recorded workspace is not where it works now.
    let main = b.ctx.board.main_worktree();
    let before = b.ctx.ok(
        "work.ticket_update",
        json!({"ticketId": "APP-128", "workspaceId": main}),
    );
    assert_eq!(
        before["projectId"], "repo-drogon",
        "a chosen workspace brings its project"
    );
    b.ctx.ok(
        "work.ticket_update",
        json!({"ticketId": "APP-128", "projectId": presales}),
    );
    // A ticket whose folder workspace exists works there.
    let started = b
        .ctx
        .ok("work.ticket_session_start", json!({"ticketId": "APP-128"}));
    assert_eq!(started["session"]["workspaceId"], "folder:fw-existing");
    assert_eq!(
        b.ctx
            .board
            .terminal(started["session"]["id"].as_str().unwrap())["worktreeId"],
        "folder:fw-existing"
    );
    // One without gets a new folder workspace named `<key> <title>`, reused next time.
    let started = b
        .ctx
        .ok("work.ticket_session_start", json!({"ticketId": "APP-142"}));
    let made = started["session"]["workspaceId"]
        .as_str()
        .unwrap()
        .to_string();
    let state = b.ctx.board.state();
    let created = state["folderWorkspaces"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| format!("folder:{}", f["id"].as_str().unwrap()) == made)
        .cloned()
        .expect("a new folder workspace");
    assert_eq!(created["projectGroupId"], "g-presales");
    assert_eq!(
        created["name"],
        "APP-142 Improve error messages for session timeouts"
    );
    let again = b
        .ctx
        .ok("work.ticket_session_start", json!({"ticketId": "APP-142"}));
    assert_eq!(again["session"]["workspaceId"], made.as_str());
    assert_eq!(
        b.ctx.board.state()["folderWorkspaces"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    // A prompt that starts an agent goes to the ticket's folder workspace too, never a teammate's.
    let sent = b.ctx.ok(
        "work.column_send",
        json!({"ticketId": "APP-130", "message": "Check APP-130"}),
    );
    let id = sent["sends"][0]["results"][0]["newSessionId"]
        .as_str()
        .unwrap()
        .to_string();
    let ws = b.ctx.board.terminal(&id)["worktreeId"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        ws.starts_with("folder:") && ws != "folder:fw-other" && ws != made,
        "{ws}"
    );
    // Orca's terminals in folder workspaces link like any other.
    let workspaces = b.ctx.ok("orca.workspaces", json!({}))["workspaces"].clone();
    assert!(
        workspaces
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w["id"] == "folder:fw-other" && w["name"] == "pre-sales · Landing page")
    );
}

#[test]
fn without_orcas_runtime_helper_existing_folder_workspaces_still_work_and_a_missing_one_is_explained()
 {
    let b = Board::imported();
    let presales = add_folder_project(&b);
    b.ctx.board.edit(|state| state["noRuntime"] = json!(true));
    b.ctx.board.engine.refresh_mirror(true);
    // Still offered: inferred from its folder workspaces.
    let projects = b.view(None)["projects"].clone();
    assert!(
        projects
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == presales.as_str() && p["name"] == "pre-sales")
    );
    b.ctx.ok(
        "work.board_update",
        json!({"boardId": b.board_id, "projectId": presales}),
    );
    let started = b
        .ctx
        .ok("work.ticket_session_start", json!({"ticketId": "APP-128"}));
    assert_eq!(started["session"]["workspaceId"], "folder:fw-existing");
    let refused = b
        .ctx
        .err("work.ticket_session_start", json!({"ticketId": "APP-142"}));
    assert!(
        refused.message.contains("create one named APP-142 in Orca"),
        "{}",
        refused.message
    );
    assert_eq!(
        b.ctx.board.terminals_created().len(),
        1,
        "nothing started in someone else's workspace"
    );
}

#[test]
fn a_tickets_chosen_workspace_wins_and_a_gone_one_is_never_replaced_silently() {
    let b = Board::imported();
    let main = b.ctx.board.main_worktree();
    b.ctx.ok(
        "work.ticket_update",
        json!({"ticketId": "APP-130", "workspaceId": main}),
    );
    let explicit = b
        .ctx
        .ok("work.ticket_session_start", json!({"ticketId": "APP-130"}));
    assert_eq!(explicit["session"]["workspaceId"], main.as_str());
    b.ctx.board.edit(|state| {
        for w in state["worktrees"].as_array_mut().unwrap() {
            if w["id"] == main.as_str() {
                w["isArchived"] = json!(true);
            }
        }
    });
    b.ctx.board.engine.refresh_mirror(true);
    let before = b.ctx.board.terminals_created().len();
    assert!(
        b.ctx
            .err("work.ticket_session_start", json!({"ticketId": "APP-130"}))
            .message
            .contains("unavailable")
    );
    assert_eq!(b.ctx.board.terminals_created().len(), before);
}
