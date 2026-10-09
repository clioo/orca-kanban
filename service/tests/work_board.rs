//! The Work board over Orca: columns, tickets and their prompts reaching
//! agents in Orca terminals. Orca is the fake CLI (tests/fixtures/
//! fake-orca.mjs): a terminal records the command it was created with and
//! every line typed into it, so delivery, resume and fresh starts are
//! asserted on what Orca was asked to do.

mod common;

use std::os::unix::fs::PermissionsExt;

use common::{Board, REPO_ID, linked_ids};
use serde_json::{Value, json};

#[test]
fn the_board_seeds_default_columns_and_manages_them() {
    let b = Board::new();
    let board = b.ok("work.board", json!({}));
    let names: Vec<&str> = board["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["To do", "In progress", "Review", "QA", "Done"]);
    assert!(
        board["projects"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["name"] == "Drogon" && p["id"] == REPO_ID)
    );

    let blocked = b.ok(
        "work.column_create",
        json!({"name": "Blocked", "icon": "blocked", "index": 1}),
    );
    assert_eq!(blocked["position"], 1);
    assert!(
        b.err("work.column_create", json!({"name": "blocked"}))
            .contains("already exists")
    );
    assert!(
        b.err("work.column_create", json!({"name": "X", "icon": "nope"}))
            .contains("icon")
    );

    let updated = b.ok(
        "work.column_update",
        json!({"columnId": "Blocked", "name": "Waiting", "cron": "15m", "prWatch": true,
               "message": "Check {ticket.id}", "recipients": "primary", "harnessId": "pi", "index": 4}),
    );
    assert_eq!(updated["name"], "Waiting");
    assert_eq!(updated["cron"], "*/15 * * * *");
    assert!(updated["nextRunAt"].as_i64().unwrap() > 0);
    assert_eq!(updated["recipients"], "primary");
    assert_eq!(updated["harnessId"], "pi");
    assert_eq!(updated["position"], 4);
    let cleared = b.ok(
        "work.column_update",
        json!({"columnId": updated["id"], "cron": null, "harnessId": null}),
    );
    assert_eq!(cleared["cron"], Value::Null);
    assert_eq!(cleared["nextRunAt"], Value::Null);

    let ticket = b.ticket("Stuck", "Waiting");
    assert!(
        b.err("work.column_delete", json!({"columnId": "Waiting"}))
            .contains("moveTicketsTo")
    );
    let deleted = b.ok(
        "work.column_delete",
        json!({"columnId": "Waiting", "moveTicketsTo": "To do"}),
    );
    assert_eq!(deleted["movedTickets"], 1);
    let moved = b.ok("work.ticket_show", json!({"ticketId": ticket["id"]}));
    assert_eq!(moved["columnId"], b.column("To do")["id"]);
}

#[test]
fn tickets_carry_project_keys_links_and_order() {
    let b = Board::new();
    let first = b.ticket("Plan the personal workspace", "To do");
    let second = b.ok(
        "work.ticket_create",
        json!({"title": "Improve Jira resume", "projectId": REPO_ID, "columnId": "To do",
               "prUrl": "https://github.com/clioo/drogon/pull/648",
               "sourceUrl": "https://jira.example.com/browse/DRG-9", "nextStep": "Choose the scope"}),
    );
    let loose = b.ok("work.ticket_create", json!({"title": "No project yet"}));
    assert_eq!(first["key"], "DRG-1");
    assert_eq!(second["key"], "DRG-2");
    assert_eq!(loose["key"], "WRK-1");
    assert_eq!(second["prNumber"], 648);
    assert_eq!(second["projectName"], "Drogon");
    // A project resolves by its Orca name as well as its id.
    let by_name = b.ok(
        "work.ticket_create",
        json!({"title": "By name", "projectId": "drogon"}),
    );
    assert_eq!(by_name["projectId"], REPO_ID);
    b.ok("work.ticket_delete", json!({"ticketId": by_name["id"]}));
    assert!(
        b.err(
            "work.ticket_create",
            json!({"title": "x", "sourceUrl": "file:///etc/passwd"})
        )
        .contains("sourceUrl")
    );
    assert!(
        b.err(
            "work.ticket_create",
            json!({"title": "x", "projectId": "nope"})
        )
        .contains("not found")
    );

    let shown = b.ok("work.ticket_show", json!({"ticketId": "drg-2"}));
    assert_eq!(shown["id"], second["id"]);
    b.ok(
        "work.ticket_move",
        json!({"ticketId": "DRG-2", "columnId": "To do", "index": 0}),
    );
    let order = |column: &str| -> Vec<String> {
        let board = b.ok("work.board", json!({}));
        let id = b.column(column)["id"].clone();
        let mut tickets: Vec<&Value> = board["tickets"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["columnId"] == id)
            .collect();
        tickets.sort_by_key(|t| t["position"].as_i64().unwrap());
        tickets
            .iter()
            .map(|t| t["key"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(order("To do"), ["DRG-2", "DRG-1", "WRK-1"]);
    let moved = b.ok(
        "work.ticket_move",
        json!({"ticketId": "DRG-1", "columnId": "In progress"}),
    );
    assert_eq!(
        moved["delivery"],
        Value::Null,
        "no prompt configured, nothing delivered"
    );
    assert_eq!(order("To do"), ["DRG-2", "WRK-1"]);
    assert_eq!(order("In progress"), ["DRG-1"]);

    let updated = b.ok("work.ticket_update", json!({"ticketId": "DRG-2", "title": "Improve Jira resume v2", "prUrl": null, "sourceUrl": ""}));
    assert_eq!(updated["title"], "Improve Jira resume v2");
    assert_eq!(updated["prNumber"], Value::Null);
    let workspace = b.main_worktree();
    let placed = b.ok(
        "work.ticket_update",
        json!({"ticketId": "DRG-2", "workspaceId": workspace}),
    );
    assert_eq!(placed["workspaceId"], workspace.as_str());
    assert!(
        b.err(
            "work.ticket_update",
            json!({"ticketId": "DRG-2", "workspaceId": "gone"})
        )
        .contains("not found")
    );

    let filtered = b.ok("work.board", json!({"projectId": REPO_ID}));
    assert_eq!(filtered["tickets"].as_array().unwrap().len(), 2);
    assert!(
        b.err(
            "work.ticket_link_session",
            json!({"ticketId": "DRG-1", "sessionId": "nope"})
        )
        .contains("not found")
    );
    let deleted = b.ok("work.ticket_delete", json!({"ticketId": "WRK-1"}));
    assert_eq!(deleted["key"], "WRK-1");
    assert!(
        b.err("work.ticket_show", json!({"ticketId": "WRK-1"}))
            .contains("not found")
    );
}

#[test]
fn entering_a_column_types_its_prompt_into_every_live_linked_terminal() {
    let b = Board::new();
    b.prompt_column(
        "Review",
        "Review {ticket.pr} for {ticket.id}: {ticket.title}",
    );
    let ticket = b.ticket("Improve Jira resume", "In progress");
    let first = b.user_terminal(Some("claude"));
    let second = b.user_terminal(Some("codex"));
    for handle in [&first, &second] {
        let linked = b.ok(
            "work.ticket_link_session",
            json!({"ticketId": ticket["id"], "sessionId": handle}),
        );
        let row = linked["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == handle.as_str())
            .unwrap()
            .clone();
        assert_eq!(row["verdict"], "live");
        assert_eq!(row["workspaceId"], b.main_worktree().as_str());
    }
    let shown = b.ok("work.ticket_show", json!({"ticketId": ticket["id"]}));
    assert_eq!(
        shown["sessions"][0]["harnessId"], "claude",
        "adopted with the agent Orca saw"
    );
    assert_eq!(shown["sessions"][1]["harnessId"], "codex");
    assert_eq!(shown["sessions"][0]["agentState"], "idle");
    assert_eq!(
        shown["workspaceId"],
        b.main_worktree().as_str(),
        "a ticket without a workspace adopts its session's"
    );

    let moved = b.ok(
        "work.ticket_move",
        json!({"ticketId": ticket["key"], "columnId": "Review"}),
    );
    let results = moved["delivery"]["results"].as_array().unwrap();
    assert_eq!(results.len(), 2, "{moved}");
    assert!(results.iter().all(|r| r["action"] == "sent"), "{results:?}");
    assert_eq!(
        moved["delivery"]["message"],
        "Review PR #7 for DRG-1: Improve Jira resume"
    );
    for handle in [&first, &second] {
        assert_eq!(
            b.inputs(handle),
            ["Review PR #7 for DRG-1: Improve Jira resume\n"]
        );
    }
    assert!(
        b.terminals_created().is_empty(),
        "live terminals are typed into, never replaced"
    );
    let after = b.ok("work.ticket_show", json!({"ticketId": ticket["id"]}));
    assert_eq!(linked_ids(&after), [first.clone(), second.clone()]);
    assert_eq!(after["sends"][0]["trigger"], "enter");
    assert_eq!(b.column("Review")["lastSentCount"], 2);

    let reordered = b.ok(
        "work.ticket_move",
        json!({"ticketId": ticket["id"], "columnId": "Review", "index": 0}),
    );
    assert_eq!(
        reordered["delivery"],
        Value::Null,
        "a move within a column is not entering it"
    );

    b.ok("work.column_update", json!({"columnId": "Review", "recipients": "primary", "message": "Only the primary {ticket.id}"}));
    let sent = b.ok("work.column_send", json!({"columnId": "Review"}));
    let results = sent["sends"][0]["results"].as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["sessionId"], first.as_str());
    assert_eq!(b.inputs(&first).last().unwrap(), "Only the primary DRG-1\n");
    assert_eq!(b.inputs(&second).len(), 1);
}

#[test]
fn a_stopped_claude_session_resumes_its_own_conversation_with_the_prompt_and_is_relinked() {
    let b = Board::new();
    let ticket = b.ticket("Update setup notes", "Review");
    // The board starts the session, so it knows Claude's conversation id.
    let started = b.ok(
        "work.ticket_session_start",
        json!({"ticketId": ticket["id"], "harnessId": "claude"}),
    );
    let session = started["session"].clone();
    let command = b.terminal(session["id"].as_str().unwrap())["command"]
        .as_str()
        .unwrap()
        .to_string();
    let conversation = session["agentSessionId"].as_str().unwrap().to_string();
    assert_eq!(command, format!("claude --session-id {conversation}; exit"));
    b.close(session["id"].as_str().unwrap());
    let stopped = b.ok("work.ticket_show", json!({"ticketId": ticket["id"]}));
    assert_eq!(stopped["sessions"][0]["verdict"], "exited");
    assert_eq!(stopped["sessions"][0]["agentState"], "exited");

    b.prompt_column("QA", "QA {ticket.id} now");
    let moved = b.ok(
        "work.ticket_move",
        json!({"ticketId": ticket["id"], "columnId": "QA"}),
    );
    let result = &moved["delivery"]["results"][0];
    assert_eq!(result["action"], "resumed", "{moved}");
    assert_eq!(result["sessionId"], session["id"]);
    let replacement = result["newSessionId"].as_str().unwrap().to_string();
    assert_ne!(replacement, session["id"].as_str().unwrap());
    let terminal = b.terminal(&replacement);
    let command = terminal["command"].as_str().unwrap();
    assert!(
        command.starts_with(&format!("claude --resume {conversation} -- \"$(cat '")),
        "{command}"
    );
    assert!(command.ends_with("; exit"), "{command}");
    assert_eq!(b.prompt_of(command), "QA DRG-1 now");
    assert_eq!(terminal["worktreeId"], session["workspaceId"]);
    let after = b.ok("work.ticket_show", json!({"ticketId": ticket["id"]}));
    assert_eq!(linked_ids(&after), std::slice::from_ref(&replacement));
    assert_eq!(after["sessions"][0]["verdict"], "live");
    assert_eq!(
        after["sessions"][0]["agentSessionId"],
        conversation.as_str(),
        "the same conversation, again"
    );
}

#[test]
fn other_agents_resume_with_their_own_continue_entrypoint() {
    let b = Board::new();
    for (harness, expected) in [
        ("codex", "codex resume --last"),
        ("pi", "pi --continue"),
        ("opencode", "opencode --continue"),
    ] {
        let ticket = b.ticket(&format!("Resume {harness}"), "To do");
        let started = b.ok(
            "work.ticket_session_start",
            json!({"ticketId": ticket["id"], "harnessId": harness}),
        );
        let id = started["session"]["id"].as_str().unwrap().to_string();
        assert_eq!(b.terminal(&id)["command"], format!("{harness}; exit"));
        b.close(&id);
        let opened = b.ok(
            "work.session_open",
            json!({"ticketId": ticket["id"], "sessionId": id}),
        );
        assert_eq!(opened["action"], "resumed", "{opened}");
        let command = b.terminal(opened["session"]["id"].as_str().unwrap())["command"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(command, format!("{expected}; exit"));
    }
}

#[test]
fn with_nothing_to_resume_a_fresh_session_is_started_and_linked() {
    let b = Board::new();
    b.prompt_column("In progress", "Start {ticket.id}: {ticket.title}");
    let ticket = b.ticket("Confirm release scope", "To do");
    assert!(ticket["sessions"].as_array().unwrap().is_empty());
    let moved = b.ok(
        "work.ticket_move",
        json!({"ticketId": ticket["id"], "columnId": "In progress"}),
    );
    let result = &moved["delivery"]["results"][0];
    assert_eq!(result["action"], "started", "{moved}");
    assert_eq!(result["harnessId"], "claude");
    let id = result["newSessionId"].as_str().unwrap().to_string();
    let terminal = b.terminal(&id);
    assert_eq!(
        terminal["worktreeId"],
        b.main_worktree().as_str(),
        "starts in the project's main worktree"
    );
    assert_eq!(terminal["title"], "DRG-1 · claude");
    assert_eq!(
        b.prompt_of(terminal["command"].as_str().unwrap()),
        "Start DRG-1: Confirm release scope"
    );
    let after = b.ok("work.ticket_show", json!({"ticketId": ticket["id"]}));
    assert_eq!(linked_ids(&after), std::slice::from_ref(&id));
    assert_eq!(after["workspaceId"], b.main_worktree().as_str());

    // A plain user terminal that closed has nothing to resume: skipped.
    let shell = b.user_terminal(None);
    b.ok(
        "work.ticket_link_session",
        json!({"ticketId": ticket["id"], "sessionId": shell}),
    );
    b.close(&shell);
    b.close(&id);
    let sent = b.ok("work.column_send", json!({"ticketId": ticket["id"]}));
    let results = sent["sends"][0]["results"].as_array().unwrap();
    assert_eq!(results[0]["action"], "resumed", "{sent}");
    assert_eq!(results[1]["action"], "skipped");

    let loose = b.ok("work.ticket_create", json!({"title": "Nowhere"}));
    let sent = b.ok(
        "work.column_send",
        json!({"columnId": "In progress", "ticketId": loose["id"]}),
    );
    assert_eq!(sent["sends"][0]["results"][0]["action"], "skipped");
}

#[test]
fn an_unreachable_orca_never_resumes_an_agent_twice() {
    let b = Board::new();
    let ticket = b.ticket("Careful", "To do");
    let started = b.ok(
        "work.ticket_session_start",
        json!({"ticketId": ticket["id"]}),
    );
    let id = started["session"]["id"].as_str().unwrap().to_string();
    b.edit(|s| s["failing"] = json!(true));
    let shown = b.ok("work.ticket_show", json!({"ticketId": ticket["id"]}));
    assert_eq!(shown["sessions"][0]["verdict"], "unverifiable");
    let sent = b.ok(
        "work.column_send",
        json!({"ticketId": ticket["id"], "message": "hello"}),
    );
    let result = &sent["sends"][0]["results"][0];
    assert_eq!(result["action"], "failed", "{sent}");
    assert!(
        result["error"]
            .as_str()
            .unwrap()
            .contains("could not be read")
    );
    b.edit(|s| s["failing"] = json!(false));
    assert_eq!(
        b.terminals_created().len(),
        1,
        "no second agent was started"
    );
    assert_eq!(
        b.ok("work.ticket_show", json!({"ticketId": ticket["id"]}))["sessions"][0]["id"],
        id.as_str()
    );
}

#[test]
fn preview_names_each_recipient_and_what_will_happen() {
    let b = Board::new();
    let ticket = b.ticket("Preview me", "Review");
    b.prompt_column("Review", "Review {ticket.id}");
    let live = b.user_terminal(Some("claude"));
    let started = b.ok(
        "work.ticket_session_start",
        json!({"ticketId": ticket["id"]}),
    );
    let stopped = started["session"]["id"].as_str().unwrap().to_string();
    b.ok(
        "work.ticket_link_session",
        json!({"ticketId": ticket["id"], "sessionId": live}),
    );
    b.close(&stopped);
    let preview = b.ok("work.column_preview", json!({"columnId": "Review"}));
    let entry = &preview["previews"][0];
    assert_eq!(entry["message"], "Review DRG-1");
    let actions: Vec<&str> = entry["recipients"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["action"].as_str().unwrap())
        .collect();
    assert_eq!(actions, ["resume", "send"]);
    let next = b.ok("work.column_preview", json!({"columnId": "Review", "message": "Move {ticket.key} from {ticket.status} to {column.next}"}));
    assert_eq!(
        next["previews"][0]["message"],
        "Move DRG-1 from Review to QA"
    );
    assert!(
        b.ok("work.sends", json!({"columnId": "Review"}))["sends"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(b.inputs(&live).is_empty(), "preview changes nothing");
    assert!(
        b.err("work.column_send", json!({"columnId": "Done"}))
            .contains("no message")
    );
}

#[test]
fn opening_a_ticket_session_shows_a_live_one_and_resumes_a_stopped_one() {
    let b = Board::new();
    let ticket = b.ticket("Resume me", "In progress");
    let started = b.ok(
        "work.ticket_session_start",
        json!({"ticketId": ticket["id"], "prompt": "Look at {this}"}),
    );
    let id = started["session"]["id"].as_str().unwrap().to_string();
    assert_eq!(
        b.prompt_of(b.terminal(&id)["command"].as_str().unwrap()),
        "Look at {this}"
    );
    let opened = b.ok(
        "work.session_open",
        json!({"ticketId": ticket["id"], "sessionId": id}),
    );
    assert_eq!(opened["action"], "open");
    assert_eq!(opened["session"]["id"], id.as_str());
    // The UI then brings its terminal to the front in Orca.
    b.ok("orca.session_focus", json!({"sessionId": id}));
    assert_eq!(b.state()["focused"], id.as_str());

    b.close(&id);
    let opened = b.ok(
        "work.session_open",
        json!({"ticketId": ticket["id"], "sessionId": id}),
    );
    assert_eq!(opened["action"], "resumed", "{opened}");
    let replacement = opened["session"]["id"].as_str().unwrap().to_string();
    assert_eq!(opened["session"]["verdict"], "live");
    assert!(
        !b.terminal(&replacement)["command"]
            .as_str()
            .unwrap()
            .contains("$(cat"),
        "opening sends no prompt"
    );
    let after = b.ok("work.ticket_show", json!({"ticketId": ticket["id"]}));
    assert_eq!(linked_ids(&after), std::slice::from_ref(&replacement));
    assert!(
        b.err(
            "work.session_open",
            json!({"ticketId": ticket["id"], "sessionId": "other"})
        )
        .contains("not linked")
    );
    let renamed = b.ok(
        "work.ticket_session_rename",
        json!({"ticketId": ticket["id"], "sessionId": replacement, "title": "Main agent"}),
    );
    assert_eq!(renamed["sessions"][0]["label"], "Main agent");
    let unlinked = b.ok(
        "work.ticket_unlink_session",
        json!({"ticketId": ticket["id"], "sessionId": replacement}),
    );
    assert!(unlinked["sessions"].as_array().unwrap().is_empty());
}

#[test]
fn a_tickets_new_session_gets_its_own_worktree_in_a_git_project() {
    let b = Board::new();
    let ticket = b.ticket("Fix the login page", "To do");
    let started = b.ok(
        "work.ticket_session_start",
        json!({"ticketId": ticket["id"], "harnessId": "codex"}),
    );
    let worktree = b.state()["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["displayName"] == "drg-1-fix-the-login-page")
        .cloned()
        .expect("a worktree named after the ticket");
    assert_eq!(worktree["comment"], "Sessions for DRG-1");
    assert_eq!(started["session"]["workspaceId"], worktree["id"]);
    assert_eq!(started["workspaceId"], worktree["id"]);
    // The next one reuses it.
    let again = b.ok(
        "work.ticket_session_start",
        json!({"ticketId": ticket["id"]}),
    );
    assert_eq!(again["session"]["workspaceId"], worktree["id"]);
    assert_eq!(b.state()["worktrees"].as_array().unwrap().len(), 2);
    assert_eq!(linked_ids(&again).len(), 2);
}

#[test]
fn launches_follow_orcas_agent_settings() {
    let b = Board::new();
    b.orca_settings(json!({
        "defaultTuiAgent": "pi",
        "agentCmdOverrides": { "claude": "/opt/my tools/claude" },
        "agentDefaultArgs": { "claude": "--dangerously-skip-permissions", "pi": "" }
    }));
    let ticket = b.ticket("Settings", "To do");
    let pi = b.ok(
        "work.ticket_session_start",
        json!({"ticketId": ticket["id"]}),
    );
    assert_eq!(pi["session"]["harnessId"], "pi", "Orca's default agent");
    let claude = b.ok(
        "work.ticket_session_start",
        json!({"ticketId": ticket["id"], "harnessId": "claude", "prompt": "it's \"quoted\""}),
    );
    let command = b.terminal(claude["session"]["id"].as_str().unwrap())["command"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        command.starts_with("'/opt/my tools/claude' --dangerously-skip-permissions --session-id "),
        "{command}"
    );
    assert_eq!(b.prompt_of(&command), "it's \"quoted\"");
    assert!(
        b.err(
            "work.ticket_session_start",
            json!({"ticketId": ticket["id"], "harnessId": "bash"})
        )
        .contains("harnessId")
    );
}

#[test]
fn launches_follow_the_settings_orca_1_4_22x_keeps_in_its_profile_store() {
    let b = Board::new();
    // A frozen legacy export that contradicts the live store.
    b.orca_settings(json!({
        "defaultTuiAgent": "claude",
        "agentCmdOverrides": { "claude": "/stale/claude" }
    }));
    b.orca_settings_store(json!({
        "defaultTuiAgent": "codex",
        "agentCmdOverrides": { "claude": "/opt/fixture/claude" },
        "agentDefaultArgs": { "claude": "--verbose" }
    }));
    let ticket = b.ticket("Store", "To do");
    let codex = b.ok(
        "work.ticket_session_start",
        json!({"ticketId": ticket["id"]}),
    );
    assert_eq!(
        codex["session"]["harnessId"], "codex",
        "the live default agent"
    );
    let claude = b.ok(
        "work.ticket_session_start",
        json!({"ticketId": ticket["id"], "harnessId": "claude"}),
    );
    let command = b.terminal(claude["session"]["id"].as_str().unwrap())["command"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        command.starts_with("/opt/fixture/claude --verbose --session-id "),
        "the live command override, never a bare `claude`: {command}"
    );
}

#[test]
fn link_candidates_are_orcas_live_terminals() {
    let b = Board::new();
    let a = b.user_terminal(Some("claude"));
    let c = b.user_terminal(None);
    let listed = b.ok("orca.sessions", json!({}));
    let ids: Vec<&str> = listed["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [c.as_str(), a.as_str()], "most recently active first");
    assert_eq!(listed["sessions"][1]["harnessId"], "claude");
    assert_eq!(listed["sessions"][0]["harnessId"], Value::Null);
    let workspaces = b.ok("orca.workspaces", json!({}));
    assert_eq!(
        workspaces["workspaces"][0]["id"],
        b.main_worktree().as_str()
    );
    assert_eq!(workspaces["workspaces"][0]["name"], "Drogon · main");
}

#[test]
fn a_scheduled_column_sends_to_its_tickets_on_the_tick() {
    let b = Board::new();
    let ticket = b.ticket("Nightly check", "Review");
    let session = b.user_terminal(Some("claude"));
    b.ok(
        "work.ticket_link_session",
        json!({"ticketId": ticket["id"], "sessionId": session}),
    );
    let column = b.ok(
        "work.column_update",
        json!({"columnId": "Review", "cron": "15m", "message": "Scheduled check for {ticket.id}"}),
    );
    let due = column["nextRunAt"].as_i64().unwrap();
    b.engine.tick_work((due - 1000) as f64);
    assert!(
        b.ok("work.sends", json!({"columnId": "Review"}))["sends"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    b.engine.tick_work((due + 1000) as f64);
    let sends = b.ok("work.sends", json!({"columnId": "Review"}));
    assert_eq!(sends["sends"][0]["trigger"], "schedule");
    assert_eq!(sends["sends"][0]["ticketKey"], "DRG-1");
    assert_eq!(b.inputs(&session), ["Scheduled check for DRG-1\n"]);
    assert!(b.column("Review")["nextRunAt"].as_i64().unwrap() > due);
    b.engine.tick_work((due + 2000) as f64);
    assert_eq!(
        b.ok("work.sends", json!({"columnId": "Review"}))["sends"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn a_pr_watch_sends_when_the_pull_request_changes() {
    let b = Board::new();
    let state = b.root.path().join("pr-state");
    std::fs::write(&state, "OPEN").unwrap();
    let gh = b.root.path().join("gh-fake");
    std::fs::write(
        &gh,
        format!(
            "#!/bin/sh\nif [ \"$1\" = pr ] && [ \"$2\" = view ] && [ \"$3\" = 7 ]; then\nS=$(cat '{}')\n\
             printf '{{\"state\":\"%s\",\"isDraft\":false,\"reviewDecision\":\"\",\"statusCheckRollup\":[],\"mergeable\":\"MERGEABLE\",\
             \"updatedAt\":\"2026-09-20T10:00:00Z\",\"url\":\"https://github.com/example/repo/pull/7\"}}' \"$S\"\nelse\nexit 1\nfi\n",
            state.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
    work_board_svc::engine::set_gh_bin_override(Some(gh));
    let ticket = b.ok(
        "work.ticket_create",
        json!({"title": "Watch me", "projectId": REPO_ID, "columnId": "Review", "prUrl": "7"}),
    );
    let session = b.user_terminal(Some("claude"));
    b.ok(
        "work.ticket_link_session",
        json!({"ticketId": ticket["id"], "sessionId": session}),
    );
    b.ok("work.column_update", json!({"columnId": "Review", "prWatch": true, "message": "PR {ticket.pr} changed for {ticket.id}"}));

    let t0 = 2_000_000_000_000_f64;
    let sends = || {
        b.ok("work.sends", json!({"columnId": "Review"}))["sends"]
            .as_array()
            .unwrap()
            .len()
    };
    b.engine.tick_work(t0);
    assert_eq!(sends(), 0, "the first read only records a baseline");
    b.engine.tick_work(t0 + 6.0 * 60_000.0);
    assert_eq!(sends(), 0, "unchanged");
    std::fs::write(&state, "MERGED").unwrap();
    b.engine.tick_work(t0 + 7.0 * 60_000.0);
    assert_eq!(sends(), 0, "polls are spaced by the PR interval");
    b.engine.tick_work(t0 + 12.0 * 60_000.0);
    let all = b.ok("work.sends", json!({"columnId": "Review"}));
    assert_eq!(all["sends"][0]["trigger"], "pr_change", "{all}");
    assert_eq!(b.inputs(&session), ["PR PR #7 changed for DRG-1\n"]);
}

#[test]
fn a_claude_session_the_user_started_continues_its_folders_latest_conversation() {
    let b = Board::new();
    let ticket = b.ticket("Adopted", "To do");
    let adopted = b.user_terminal(Some("claude"));
    b.ok(
        "work.ticket_link_session",
        json!({"ticketId": ticket["id"], "sessionId": adopted}),
    );
    b.close(&adopted);
    let sent = b.ok(
        "work.column_send",
        json!({"ticketId": ticket["id"], "message": "carry on"}),
    );
    let result = &sent["sends"][0]["results"][0];
    assert_eq!(result["action"], "resumed", "{sent}");
    let command = b.terminal(result["newSessionId"].as_str().unwrap())["command"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        command.starts_with("claude --continue -- \"$(cat '"),
        "{command}"
    );
    assert_eq!(b.prompt_of(&command), "carry on");
}

#[test]
fn upgrading_v6_preserves_tickets_and_backs_up_the_previous_database() {
    let b = Board::new();
    let ticket = b.ticket("Keep this ticket", "To do");
    {
        let conn = b.engine.db.lock().unwrap();
        conn.execute_batch("ALTER TABLE work_boards DROP COLUMN workspace_id; UPDATE schema_versions SET version = 6 WHERE component = 'work';").unwrap();
    }
    let data = b.root.path().join("data");
    let reopened = work_board_svc::Engine::open(
        &data,
        work_board_svc::orca::Orca::new(b.root.path().join("orca"), b.user_data.clone()),
    )
    .unwrap();
    assert_eq!(
        reopened
            .dispatch("work.ticket_show", &json!({"ticketId": ticket["id"]}))
            .unwrap()["title"],
        "Keep this ticket"
    );
    let backups: Vec<_> = std::fs::read_dir(&data)
        .unwrap()
        .flatten()
        .filter(|f| {
            f.file_name()
                .to_string_lossy()
                .starts_with("work-board-before-v7-")
        })
        .collect();
    assert_eq!(backups.len(), 1);
    let backup = rusqlite::Connection::open(backups[0].path()).unwrap();
    assert_eq!(
        backup
            .query_row(
                "SELECT version FROM schema_versions WHERE component = 'work'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        6
    );
    assert_eq!(
        backup
            .query_row("SELECT title FROM work_tickets", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "Keep this ticket"
    );
}

#[test]
fn an_explicit_ticket_workspace_is_used_instead_of_creating_a_new_checkout() {
    let b = Board::new();
    let ticket = b.ticket("Use the chosen checkout", "To do");
    b.ok(
        "work.ticket_update",
        json!({"ticketId": ticket["id"], "workspaceId": b.main_worktree()}),
    );
    let started = b.ok(
        "work.ticket_session_start",
        json!({"ticketId": ticket["id"]}),
    );
    assert_eq!(started["session"]["workspaceId"], b.main_worktree());
    assert_eq!(b.state()["worktrees"].as_array().unwrap().len(), 1);
}
