#!/usr/bin/env bash
# Waits for review comments from the diffback panel in VS Code and prints them as JSON.
# Returns when the user presses Publish, or when every VS Code window on the repo has closed
# (unsent comments are delivered then, marked with a "closed" timestamp).
# Starting a new watcher replaces an older one for the same repo.
#
# usage: wait-review.sh <repo>
#
# Exit codes: 0 delivered, 1 the agent session that started us is gone or we were replaced.
set -euo pipefail

repo=$(git -C "${1:?usage: wait-review.sh <repo>}" rev-parse --show-toplevel)
dir=$(git -C "$repo" rev-parse --absolute-git-dir)/diffback
review=$dir/review.json
pidfile=$dir/watcher.pid
# A window counts as open while its heartbeat is this fresh (the extension beats every 2s).
alive_seconds=6
# After a close, wait this long for a reloading window to come back before delivering.
close_grace=${DIFFBACK_CLOSE_GRACE:-10}

mkdir -p "$dir"

# One watcher per repo: take over from an older one.
if [ -f "$pidfile" ]; then
  old=$(cat "$pidfile" 2>/dev/null || true)
  if [ -n "$old" ] && [ "$old" != "$$" ] && ps -o command= -p "$old" 2>/dev/null | grep -q wait-review; then
    kill "$old" 2>/dev/null || true
  fi
fi
echo $$ > "$pidfile"
trap '[ "$(cat "$pidfile" 2>/dev/null)" = "$$" ] && rm -f "$pidfile"' EXIT

# The agent runs us through a wrapper shell; watch both, since either may outlive the other.
parent=$PPID
agent=$(ps -o ppid= -p "$parent" 2>/dev/null | tr -d ' ')

mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null
}

# Newest mtime among files matching a glob, or empty if there are none.
newest() {
  local f m best=''
  for f in "$@"; do
    [ -e "$f" ] || continue
    m=$(mtime "$f") || continue
    if [ -z "$best" ] || [ "$m" -gt "$best" ]; then best=$m; fi
  done
  echo "$best"
}

archive_path() {
  mkdir -p "$dir/reviews"
  echo "$dir/reviews/$(date +%Y%m%d-%H%M%S)-$$-$RANDOM$1.json"
}

session_alive() {
  [ "$(ps -o ppid= -p $$ 2>/dev/null | tr -d ' ')" = "$parent" ] || return 1
  [ -z "$agent" ] || kill -0 "$agent" 2>/dev/null
}

while :; do
  if [ -f "$review" ]; then
    archived=$(archive_path "")
    # Move first: a Publish landing right now starts a fresh file instead of being lost.
    if mv "$review" "$archived" 2>/dev/null; then
      cat "$archived"
      exit 0
    fi
  fi

  closing=$(newest "$dir"/closing-*.json)
  if [ -n "$closing" ]; then
    now=$(date +%s)
    heartbeat=$(newest "$dir"/alive-*)
    if [ $(( now - closing )) -ge "$close_grace" ] &&
       { [ -z "$heartbeat" ] || [ $(( now - heartbeat )) -gt "$alive_seconds" ]; }; then
      mkdir -p "$dir/consumed"
      delivered=0
      for f in "$dir"/closing-*.json; do
        [ -e "$f" ] || continue
        archived=$(archive_path "-closed")
        mv "$f" "$archived" 2>/dev/null || continue
        # Tells the next window which drafts were delivered, so they are not sent twice.
        cp "$archived" "$dir/consumed/"
        cat "$archived"
        delivered=1
      done
      [ "$delivered" -eq 1 ] && exit 0
    fi
  fi

  # Quit quietly if our agent session has ended or a newer watcher took over.
  session_alive || exit 1
  [ "$(cat "$pidfile" 2>/dev/null)" = "$$" ] || exit 1
  sleep 1
done
