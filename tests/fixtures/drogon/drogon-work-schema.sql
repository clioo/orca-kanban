-- The Work tables of a Drogon database (schema 6), as Drogon writes them.
CREATE TABLE schema_versions (
            component TEXT PRIMARY KEY,
            version INTEGER NOT NULL
        );
CREATE TABLE work_columns (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            position INTEGER NOT NULL,
            send_on_enter INTEGER NOT NULL DEFAULT 0,
            cron TEXT,
            pr_watch INTEGER NOT NULL DEFAULT 0,
            message TEXT NOT NULL DEFAULT '',
            recipients TEXT NOT NULL DEFAULT 'all',
            harness_id TEXT,
            next_run_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        , board_id TEXT, statuses TEXT NOT NULL DEFAULT '[]', collapsed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE work_tickets (
            id TEXT PRIMARY KEY,
            key TEXT NOT NULL UNIQUE,
            project_id TEXT,
            workspace_id TEXT,
            column_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            pr_url TEXT,
            pr_number INTEGER,
            source_url TEXT,
            next_step TEXT NOT NULL DEFAULT '',
            pr_fingerprint TEXT,
            pr_checked_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        , board_id TEXT, ext_id TEXT, ext_key TEXT, ext_url TEXT, issue_type TEXT, priority TEXT, assignee TEXT, ext_status_id TEXT, ext_status_name TEXT, ext_status_category TEXT, pending_status_id TEXT, status_conflict INTEGER NOT NULL DEFAULT 0, sprint_id TEXT, ext_sprint_id TEXT, push_error TEXT, removed_at INTEGER);
CREATE INDEX work_tickets_column ON work_tickets(column_id, position);
CREATE TABLE work_ticket_sessions (
            ticket_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            linked_at INTEGER NOT NULL, label TEXT,
            PRIMARY KEY(ticket_id, session_id)
        );
CREATE INDEX work_ticket_sessions_session ON work_ticket_sessions(session_id);
CREATE TABLE work_key_counters (
            prefix TEXT PRIMARY KEY,
            next INTEGER NOT NULL
        );
CREATE TABLE work_sends (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            column_id TEXT,
            ticket_id TEXT NOT NULL,
            trigger TEXT NOT NULL,
            message TEXT NOT NULL,
            results TEXT NOT NULL,
            at INTEGER NOT NULL
        );
CREATE INDEX work_sends_column ON work_sends(column_id, at);
CREATE INDEX work_sends_ticket ON work_sends(ticket_id, at);
CREATE TABLE work_boards (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            site_id TEXT NOT NULL,
            site_url TEXT NOT NULL DEFAULT '',
            external_id TEXT NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            project_key TEXT,
            project_name TEXT,
            project_id TEXT,
            statuses TEXT NOT NULL DEFAULT '[]',
            last_synced_at INTEGER,
            last_sync_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL, auto_import_mine INTEGER NOT NULL DEFAULT 0,
            UNIQUE(provider, site_id, external_id)
        );
CREATE TABLE work_sprints (
            board_id TEXT NOT NULL,
            ext_id TEXT NOT NULL,
            name TEXT NOT NULL,
            state TEXT NOT NULL,
            start_at TEXT,
            end_at TEXT,
            position INTEGER NOT NULL,
            PRIMARY KEY(board_id, ext_id)
        );
CREATE TABLE work_ticket_sprints (
            ticket_id TEXT NOT NULL,
            sprint_id TEXT NOT NULL,
            status_name TEXT,
            first_seen_at INTEGER NOT NULL,
            PRIMARY KEY(ticket_id, sprint_id)
        );
CREATE TABLE work_activity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ticket_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            text TEXT NOT NULL,
            at INTEGER NOT NULL
        );
CREATE INDEX work_activity_ticket ON work_activity(ticket_id, at);
CREATE INDEX work_tickets_board ON work_tickets(board_id, sprint_id);
CREATE INDEX work_columns_board ON work_columns(board_id, position);
CREATE TABLE work_sources (
            provider TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 1,
            api_url TEXT,
            site_url TEXT,
            account TEXT,
            updated_at INTEGER NOT NULL
        );
CREATE TABLE work_ticket_workspaces (
                ticket_id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL
            );
