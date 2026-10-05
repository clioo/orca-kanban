#!/bin/bash
# Isolated, windowless Orca for the spike: its own HOME and userData, so the
# developer's Orca, ~/.claude and settings are never touched.
#   start <dir>   launch and wait until the CLI reaches its runtime
#   stop  <dir>   quit it and every descendant it started, then verify
set -euo pipefail
ORCA_BIN=/Applications/Orca.app/Contents/MacOS/Orca
cmd=$1; dir=$2
export HOME="$dir/home" ORCA_E2E_HOME_DIR="$dir/home" ORCA_USER_DATA_PATH="$dir/userdata"
case "$cmd" in
  start)
    mkdir -p "$HOME" "$ORCA_USER_DATA_PATH" "$dir/logs"
    # A previous forced stop leaves Chromium's singleton links and Orca's
    # runtime bootstrap behind; they belong to dead pids of this same dir.
    rm -f "$ORCA_USER_DATA_PATH"/Singleton* "$ORCA_USER_DATA_PATH"/orca-runtime.json "$ORCA_USER_DATA_PATH"/o-*.sock
    # A clean PATH: the fixture agents in the isolated HOME come first and the
    # developer's real agent CLIs (~/.local/bin of the real HOME) never resolve.
    PATH="$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    ORCA_E2E_USER_DATA_DIR="$ORCA_USER_DATA_PATH" ORCA_E2E_HEADLESS=1 \
      /usr/bin/python3 -c 'import os,subprocess,sys; p=subprocess.Popen([sys.argv[1],"--use-mock-keychain"]+(["--remote-debugging-port="+sys.argv[4]] if sys.argv[4] else []),stdout=open(sys.argv[2],"w"),stderr=subprocess.STDOUT,stdin=subprocess.DEVNULL,start_new_session=True); open(sys.argv[3],"w").write(str(p.pid))' "$ORCA_BIN" "$dir/logs/orca.log" "$dir/orca.pid" "${CDP_PORT:-}"
    for _ in $(seq 1 150); do
      if orca status --json 2>/dev/null | grep -q '"state": "ready"'; then
        echo "ready pid=$(cat "$dir/orca.pid")"; exit 0
      fi
      kill -0 "$(cat "$dir/orca.pid")" 2>/dev/null || { echo "orca exited"; tail -20 "$dir/logs/orca.log"; exit 1; }
      sleep 1
    done
    echo "runtime never became ready"; exit 1 ;;
  stop)
    pid=$(cat "$dir/orca.pid" 2>/dev/null || true)
    [ -n "$pid" ] || exit 0
    # Every process that names this isolated dir is ours (Orca helpers,
    # daemons, PTYs, plugin workers and anything they spawned with it).
    owned() { ps -axo pid=,command= | awk -v d="$dir" -v me=$$ 'index($0,d) && $1!=me && $0 !~ /isolated-orca\.sh|awk -v d/ {print $1}'; }
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    for p in $(owned); do kill -TERM "$p" 2>/dev/null || true; done
    sleep 2
    for p in $(owned); do kill -KILL "$p" 2>/dev/null || true; done
    sleep 1
    left=$(owned | tr '\n' ' ')
    [ -z "$left" ] && echo "stopped: no process references $dir" || { echo "SURVIVORS: $left"; exit 1; } ;;
esac
