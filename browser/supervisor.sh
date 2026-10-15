#!/bin/bash
# Runs inside the linuxserver/chromium container as `abc`, started from labwc's autostart.
#
# The gateway declares which project browsers should run by writing
#   $DATA/run/want/<project>   (contents: the 127.0.0.1 debug port)
# and this loop makes it so: one Chromium per want file, each with its own profile and
# downloads directory under $DATA/projects/<project>/, restarted if it crashes, stopped
# gracefully when its file disappears. The `scratch` project is wiped when it stops.
# It reports running browsers in $DATA/run/up/<project> ("<port> <pid>"), removing an
# entry only after the process has exited, so the gateway never recycles a port that a
# previous project's Chromium still holds.

set -u
DATA=${AGENT_BROWSER_DATA:-/data}
WANT="$DATA/run/want"
UP="$DATA/run/up"
STATE=/tmp/agent-browser
LOG="$DATA/run/supervisor.log"
mkdir -p "$WANT" "$UP" "$STATE"
# Nothing survives a container restart, so whatever up/ says is stale.
rm -f "$UP"/*

log() { echo "$(date -Is) $*" >>"$LOG"; }

running() {
  [[ -f "$STATE/$1.pid" ]] && kill -0 "$(cat "$STATE/$1.pid")" 2>/dev/null
}

seed_profile() {
  local dir=$1
  mkdir -p "$dir/profile/Default" "$dir/downloads"
  if [[ ! -f "$dir/profile/Default/Preferences" ]]; then
    cat >"$dir/profile/Default/Preferences" <<EOF
{
  "download": {"default_directory": "$dir/downloads", "prompt_for_download": false, "directory_upgrade": true},
  "savefile": {"default_directory": "$dir/downloads"},
  "browser": {"has_seen_welcome_page": true},
  "profile": {"exit_type": "Normal"}
}
EOF
  fi
  # A container recreate leaves the previous instance's locks behind.
  rm -f "$dir/profile"/Singleton{Lock,Socket,Cookie}
}

start() {
  local p=$1 port=$2 dir="$DATA/projects/$1"
  local now last
  now=$(date +%s)
  last=$(cat "$STATE/$p.started" 2>/dev/null || echo 0)
  # Crash-loop guard: at most one start per 10 s per project.
  ((now - last < 10)) && return
  echo "$now" >"$STATE/$p.started"
  seed_profile "$dir"
  local ozone=()
  [[ "${PIXELFLUX_WAYLAND:-}" == "true" ]] && ozone=(--ozone-platform=wayland)
  # shellcheck disable=SC2086 # AGENT_BROWSER_CHROMIUM_FLAGS is a flag list on purpose
  setsid /usr/bin/chromium \
    --no-sandbox \
    --test-type \
    --password-store=basic \
    --simulate-outdated-no-au='Tue, 31 Dec 2099 23:59:59 GMT' \
    --user-data-dir="$dir/profile" \
    --remote-debugging-port="$port" \
    --window-name="[$p]" \
    --class="agent-browser-$p" \
    --no-first-run \
    --no-default-browser-check \
    --hide-crash-restore-bubble \
    --start-maximized \
    "${ozone[@]}" \
    ${AGENT_BROWSER_CHROMIUM_FLAGS:-} \
    about:blank >>"$STATE/$p.log" 2>&1 </dev/null &
  echo $! >"$STATE/$p.pid"
  echo "$port $!" >"$UP/.$p.tmp" && mv "$UP/.$p.tmp" "$UP/$p"
  log "start $p on 127.0.0.1:$port (pid $!)"
}

stop() {
  local p=$1 pid
  pid=$(cat "$STATE/$p.pid" 2>/dev/null || true)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$STATE/$p.pid" "$STATE/$p.started" "$UP/$p"
  log "stop $p"
  if [[ "$p" == "scratch" ]]; then
    rm -rf "${DATA:?}/projects/scratch"
    log "wiped scratch"
  fi
}

log "supervisor up (pid $$)"
trap 'for f in "$STATE"/*.pid; do [[ -f "$f" ]] && stop "$(basename "$f" .pid)"; done; exit 0' TERM INT

while true; do
  for f in "$WANT"/*; do
    [[ -f "$f" ]] || continue
    p=$(basename "$f")
    [[ "$p" =~ ^[a-z0-9][a-z0-9._-]{0,62}$ ]] || continue
    port=$(tr -dc '0-9' <"$f")
    [[ -n "$port" ]] || continue
    if ! running "$p"; then
      rm -f "$UP/$p" # crashed (or never started): not up until restarted
      start "$p" "$port"
    fi
  done
  for f in "$STATE"/*.pid; do
    [[ -f "$f" ]] || continue
    p=$(basename "$f" .pid)
    [[ -f "$WANT/$p" ]] || stop "$p"
  done
  sleep 1
done
