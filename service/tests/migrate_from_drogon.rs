//! Bringing a Drogon Work board to Orca: a Drogon-shaped database (the same
//! work tables, plus Drogon's projects, workspaces and sessions) is copied
//! with its references moved onto the Orca repos and worktrees at the same
//! paths; linked agent sessions come over as stopped sessions that resume
//! their own conversation; connections are copied; Drogon is never changed.

mod common;

use common::{Board, REPO_ID};
use serde_json::json;

/// A Drogon data dir holding a board made by this engine, with Drogon's
/// own tables around it.
fn drogon_with_board(b: &Board) -> (tempfile::TempDir, String) {
    let source = Board::new();
    source.ok(
        "work.column_create",
        json!({"name": "Blocked", "icon": "blocked"}),
    );
    source.prompt_column("Review", "Review {ticket.id}");
    let first = source.ticket("Bring me over", "Review");
    let second = source.ok(
        "work.ticket_create",
        json!({"title": "Elsewhere", "projectId": REPO_ID}),
    );
    let third = source.ok("work.ticket_create", json!({"title": "No project"}));
    let dir = tempfile::tempdir().unwrap();
    // A consistent copy of the (WAL-mode) source database.
    rusqlite::Connection::open(source.root.path().join("data").join("work-board.db"))
        .unwrap()
        .execute(
            "VACUUM INTO ?1",
            [dir.path()
                .join("drogon.sqlite3")
                .to_string_lossy()
                .to_string()],
        )
        .unwrap();
    let conn = rusqlite::Connection::open(dir.path().join("drogon.sqlite3")).unwrap();
    let repo_path = b.root.path().join("Drogon").to_string_lossy().to_string();
    conn.execute_batch(&format!(
        "DROP TABLE projects; DROP TABLE workspaces; DROP TABLE sessions;
         CREATE TABLE projects (id TEXT PRIMARY KEY, host_id TEXT, path TEXT, name TEXT, kind TEXT, created_at TEXT);
         CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT, name TEXT, kind TEXT, host_id TEXT, created_at TEXT);
         CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, harness_id TEXT, agent_session_id TEXT, verdict TEXT);
         INSERT INTO projects VALUES ('d-proj', 'h', '{repo_path}', 'Drogon', 'git', '');
         INSERT INTO projects VALUES ('d-gone', 'h', '/nowhere/gone', 'Gone', 'folder', '');
         INSERT INTO projects VALUES ('d-unused', 'h', '/nowhere/unused', 'Unused', 'folder', '');
         INSERT INTO workspaces VALUES ('d-ws', '{repo_path}', 'Drogon', 'folder', 'h', '');
         INSERT INTO workspaces VALUES ('d-ws-gone', '/nowhere/gone', 'Gone', 'folder', 'h', '');
         INSERT INTO sessions VALUES ('s-claude', 'd-ws', 'claude', 'conv-1', 'exited');
         INSERT INTO sessions VALUES ('s-gone', 'd-ws-gone', 'claude', 'conv-2', 'exited');
         INSERT INTO sessions VALUES ('s-shell', 'd-ws', NULL, NULL, 'exited');
         UPDATE work_tickets SET project_id = 'd-proj', workspace_id = 'd-ws' WHERE id = '{first}';
         UPDATE work_tickets SET project_id = 'd-gone' WHERE id = '{second}';
         INSERT INTO work_ticket_sessions (ticket_id, session_id, linked_at, label) VALUES
           ('{first}', 's-claude', 1, 'Implement'), ('{first}', 's-gone', 2, NULL), ('{first}', 's-shell', 3, NULL);",
        first = first["id"].as_str().unwrap(),
        second = second["id"].as_str().unwrap(),
    ))
    .unwrap();
    let _ = third;
    std::fs::create_dir_all(dir.path().join("integrations/work")).unwrap();
    std::fs::write(
        dir.path().join("integrations/work/linear.token"),
        "v1.sealed",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("integrations/work/.token-key"),
        "k".repeat(32),
    )
    .unwrap();
    let ticket = first["id"].as_str().unwrap().to_string();
    (dir, ticket)
}

#[test]
fn a_drogon_board_comes_over_onto_orcas_repos_worktrees_and_resumable_sessions() {
    let b = Board::new();
    let (drogon, ticket) = drogon_with_board(&b);
    let dir = drogon.path().to_string_lossy().to_string();
    let before = std::fs::read(drogon.path().join("drogon.sqlite3")).unwrap();

    let status = b.ok("board.migration_status", json!({"drogonDataDir": dir}));
    assert_eq!(status["drogonTickets"], 3);
    assert_eq!(status["migrated"], serde_json::Value::Null);

    let done = b.ok("board.migrate_from_drogon", json!({"drogonDataDir": dir}));
    assert_eq!(done["tickets"], 3, "{done}");
    assert_eq!(done["columns"], 6);
    assert_eq!(
        done["sessions"], 1,
        "only the agent session in a mapped worktree"
    );
    // Dropped: one in a worktree Orca does not have, a plain shell, and the
    // session the source board started when the ticket entered Review
    // (Drogon has no record of it).
    assert_eq!(done["sessionsDropped"], 3);
    assert_eq!(
        done["unmappedProjects"],
        json!(["/nowhere/gone"]),
        "only projects the board uses"
    );
    let copied: Vec<_> = std::fs::read_dir(b.root.path().join("data/integrations/work"))
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(done["connections"]["work"], 2, "{copied:?}");
    assert!(
        b.root
            .path()
            .join("data/integrations/work/linear.token")
            .is_file()
    );

    let board = b.ok("work.board", json!({}));
    let names: Vec<&str> = board["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"Blocked"));
    assert_eq!(b.column("Review")["message"], "Review {ticket.id}");
    let moved = b.ok("work.ticket_show", json!({"ticketId": ticket}));
    assert_eq!(moved["key"], "DRG-1");
    assert_eq!(
        moved["projectId"], REPO_ID,
        "the Drogon project is the Orca repo at its path"
    );
    assert_eq!(moved["workspaceId"], b.main_worktree().as_str());
    assert_eq!(moved["sessions"].as_array().unwrap().len(), 1);
    let session = &moved["sessions"][0];
    assert_eq!(session["verdict"], "exited");
    assert_eq!(session["label"], "Implement");
    assert_eq!(session["agentSessionId"], "conv-1");
    let elsewhere = b.ok("work.ticket_show", json!({"ticketId": "DRG-2"}));
    assert_eq!(
        elsewhere["projectId"],
        serde_json::Value::Null,
        "no Orca repo at its path"
    );
    // New tickets continue the Drogon numbering.
    assert_eq!(b.ticket("Next", "To do")["key"], "DRG-3");

    // Opening the session resumes that conversation in an Orca terminal.
    let opened = b.ok(
        "work.session_open",
        json!({"ticketId": ticket, "sessionId": session["id"]}),
    );
    assert_eq!(opened["action"], "resumed");
    let command = b.terminal(opened["session"]["id"].as_str().unwrap())["command"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(command, "claude --resume conv-1; exit");

    // Once is enough: a second run asks before replacing.
    assert!(
        b.err("board.migrate_from_drogon", json!({"drogonDataDir": dir}))
            .contains("already has")
    );
    let again = b.ok(
        "board.migrate_from_drogon",
        json!({"drogonDataDir": dir, "replace": true}),
    );
    assert_eq!(again["tickets"], 3);
    let status = b.ok("board.migration_status", json!({"drogonDataDir": dir}));
    assert_eq!(status["migrated"]["tickets"], 3);
    assert_eq!(
        std::fs::read(drogon.path().join("drogon.sqlite3")).unwrap(),
        before,
        "Drogon's database is unchanged"
    );
}

#[test]
fn without_a_drogon_board_there_is_nothing_to_bring() {
    let b = Board::new();
    let empty = tempfile::tempdir().unwrap();
    let dir = empty.path().to_string_lossy().to_string();
    let status = b.ok("board.migration_status", json!({"drogonDataDir": dir}));
    assert_eq!(status["drogonDataDir"], serde_json::Value::Null);
    assert!(
        b.err("board.migrate_from_drogon", json!({"drogonDataDir": dir}))
            .contains("no Drogon board")
    );
}
