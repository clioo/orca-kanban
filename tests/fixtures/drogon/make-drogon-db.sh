#!/bin/bash
# A Drogon data dir with a Work board, for the migration acceptance: the
# Work tables as Drogon writes them, Drogon's projects/workspaces/sessions,
# a board with its own columns (one with a prompt), three tickets, a Claude
# session linked to one of them, and a sealed Linear key.
#   make-drogon-db.sh <drogon-data-dir> <path of a project Orca also has>
set -euo pipefail
dir=$1; project=$2
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$dir/integrations/work"
db="$dir/drogon.sqlite3"
rm -f "$db"
{
  cat "$here/drogon-work-schema.sql"
  cat <<SQL
INSERT INTO schema_versions VALUES ('work', 6);
CREATE TABLE projects (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL, default_base_ref TEXT, created_at TEXT NOT NULL);
CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, host_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, host_id TEXT NOT NULL, incarnation TEXT NOT NULL, command TEXT NOT NULL, args_json TEXT NOT NULL, cols INTEGER NOT NULL, rows INTEGER NOT NULL, verdict TEXT NOT NULL, exit_code INTEGER, created_at TEXT NOT NULL, harness_id TEXT, agent_session_id TEXT);
INSERT INTO projects VALUES ('dp-1', 'h', '$project', 'Drogon', 'git', NULL, '2026-09-01T00:00:00Z');
INSERT INTO workspaces VALUES ('dw-1', '$project', 'Drogon', 'git', 'h', '2026-09-01T00:00:00Z');
INSERT INTO sessions VALUES ('ds-1', 'dw-1', 'h', 'i', 'claude', '[]', 80, 24, 'exited', 0, '2026-09-01T00:00:00Z', 'claude', '11111111-2222-3333-4444-555555555555');
INSERT INTO work_columns (id, name, icon, position, send_on_enter, message, recipients, created_at, updated_at) VALUES
  ('dc-1', 'Backlog', 'backlog', 0, 0, '', 'all', 1, 1),
  ('dc-2', 'Doing', 'in_progress', 1, 1, 'Pick up {ticket.id}: {ticket.title}', 'all', 1, 1),
  ('dc-3', 'Shipped', 'done', 2, 0, '', 'all', 1, 1);
INSERT INTO work_tickets (id, key, project_id, workspace_id, column_id, position, title, description, next_step, created_at, updated_at) VALUES
  ('dt-1', 'DRG-41', 'dp-1', 'dw-1', 'dc-2', 0, 'Carry the board over', 'From Drogon to Orca', 'Check the columns', 1, 1),
  ('dt-2', 'DRG-42', 'dp-1', NULL, 'dc-1', 0, 'Second ticket', '', '', 1, 1),
  ('dt-3', 'DRG-43', NULL, NULL, 'dc-3', 0, 'Already shipped', '', '', 1, 1);
INSERT INTO work_key_counters VALUES ('DRG', 44);
INSERT INTO work_ticket_sessions (ticket_id, session_id, linked_at, label) VALUES ('dt-1', 'ds-1', 1, 'Main agent');
SQL
} | sqlite3 "$db"
printf 'v1.not-a-real-key' > "$dir/integrations/work/linear.token"
head -c 32 /dev/urandom > "$dir/integrations/work/.token-key"
