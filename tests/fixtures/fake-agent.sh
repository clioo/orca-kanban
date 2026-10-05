#!/bin/bash
# Fixture agent CLI (never a model). Installed as <home>/.local/bin/<name>
# (claude, codex, opencode, pi) inside an isolated Orca's HOME. It emits the
# Claude Code hook events Orca's own hook script forwards (SessionStart,
# UserPromptSubmit, Stop, SessionEnd), so Orca tracks it like a real agent,
# answers each prompt, and records every launch and prompt under
# <home>/agent-data — never in the developer's real HOME.
self_dir=$(cd "$(dirname "$0")" && pwd -P)
home=$(dirname "$(dirname "$self_dir")")
name=$(basename "$0")
data="$home/agent-data"; mkdir -p "$data"
sid=""; mode=new; prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) sid=$2; shift 2 ;;
    --resume|-r|--session) sid=$2; mode=resume; shift 2 ;;
    --continue|-c) mode=continue; shift ;;
    resume) mode=resume; if [ "${2:-}" = "--last" ]; then mode=continue; shift 2; else sid=${2:-}; shift 2; fi ;;
    --prompt|--prompt-interactive) prompt=$2; shift 2 ;;
    --prompt=*) prompt=${1#--prompt=}; shift ;;
    --) shift; prompt=${1:-}; shift ;;
    --*) shift ;;
    *) prompt=$1; shift ;;
  esac
done
[ -n "$sid" ] || sid=$(uuidgen | tr 'A-Z' 'a-z')
printf '%s\n' "{\"agent\":\"$name\",\"mode\":\"$mode\",\"session\":\"$sid\",\"cwd\":\"$PWD\"}" >> "$data/launches.jsonl"
hook() { [ "$name" = claude ] || return 0; printf '%s' "$1" | /bin/sh "$home/.orca/agent-hooks/claude-hook.sh" >/dev/null 2>&1; }
tp="$data/$sid.jsonl"; touch "$tp"
src=startup; [ "$mode" = new ] || src=resume
hook "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$sid\",\"transcript_path\":\"$tp\",\"cwd\":\"$PWD\",\"source\":\"$src\"}"
echo "FIXTURE-AGENT $name session=$sid mode=$mode"
trap 'hook "{\"hook_event_name\":\"SessionEnd\",\"session_id\":\"$sid\",\"transcript_path\":\"$tp\",\"cwd\":\"$PWD\",\"reason\":\"exit\"}"' EXIT
turn() {
  local line=$1
  line=$(printf '%s' "$line" | sed $'s/\x1b\\[20[01]~//g' | tr -d '\000-\011\013-\037')
  [ "$line" = "/exit" ] && exit 0
  local esc; esc=$(printf '%s' "$line" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
  hook "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$sid\",\"transcript_path\":\"$tp\",\"cwd\":\"$PWD\",\"prompt\":\"$esc\"}"
  printf '%s\n' "{\"prompt\":\"$esc\"}" >> "$tp"
  echo "working on: $esc"; sleep "${FIXTURE_TURN_SECONDS:-2}"; echo "DONE: $esc"
  hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"$sid\",\"transcript_path\":\"$tp\",\"cwd\":\"$PWD\",\"stop_hook_active\":false}"
}
[ -n "$prompt" ] && turn "$prompt"
printf '> '
while IFS= read -r line; do turn "$line"; printf '> '; done
