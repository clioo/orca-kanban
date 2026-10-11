#!/bin/bash
# Isolated, windowless Orca for the spike: its own HOME and userData, so the
# developer's Orca, ~/.claude and settings are never touched.
#   start <dir>   launch and wait until the CLI reaches its runtime
#   stop  <dir>   quit it and every descendant it started, then verify
#   ORCA_APP      the Orca to run: /Applications/Orca.app (macOS), or on Linux
#                 a folder holding orca-ide and resources/ (default /opt/Orca;
#                 also an unpacked tarball or `Orca.AppImage --appimage-extract`)
set -euo pipefail
flags=(--use-mock-keychain)
case "$(uname -s)" in
  Darwin)
    app=${ORCA_APP:-/Applications/Orca.app}
    ORCA_BIN=$app/Contents/MacOS/Orca ORCA_CLI=$app/Contents/Resources/bin/orca ;;
  Linux)
    app=${ORCA_APP:-/opt/Orca}
    ORCA_BIN=$app/orca-ide ORCA_CLI=$app/resources/bin/orca-ide
    # The mock keychain's Linux twin: secrets never reach the desktop keyring.
    flags+=(--password-store=basic)
    # As Orca's AppRun does: Chromium's sandbox needs user namespaces.
    unshare -Ur true 2>/dev/null || flags+=(--no-sandbox)
    # XDG dirs would point outside the isolated HOME.
    unset XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME ;;
  *) echo "unsupported OS: $(uname -s)"; exit 1 ;;
esac
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
      /usr/bin/python3 -c 'import os,subprocess,sys; p=subprocess.Popen(sys.argv[3:],stdout=open(sys.argv[1],"w"),stderr=subprocess.STDOUT,stdin=subprocess.DEVNULL,start_new_session=True); open(sys.argv[2],"w").write(str(p.pid))' "$dir/logs/orca.log" "$dir/orca.pid" "$ORCA_BIN" "${flags[@]}" ${CDP_PORT:+"--remote-debugging-port=$CDP_PORT"}
    for _ in $(seq 1 150); do
      if "$ORCA_CLI" status --json 2>/dev/null | grep -q '"state": "ready"'; then
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
