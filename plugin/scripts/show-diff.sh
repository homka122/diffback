#!/usr/bin/env bash
# Opens a multi-file diff in VS Code through the diffback extension and waits until it is shown.
#
# usage: show-diff.sh <repo> staged              # what the next commit will contain
#        show-diff.sh <repo> uncommitted         # everything since HEAD, new files included
#        show-diff.sh <repo> <base>...<head>     # a branch, e.g. origin/main...HEAD
#
# Exit codes: 0 shown, 1 setup or git problem, 2 bad usage, 3 nothing to show.
set -euo pipefail

usage() {
  echo "usage: show-diff.sh <repo> staged|uncommitted|<base>...<head>" >&2
  exit 2
}
fail() {
  echo "diffback: $*" >&2
  exit 1
}
[ $# -eq 2 ] || usage

repo=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || fail "$1 is not inside a git repository."
editor=${DIFFBACK_EDITOR:-code}
# A cold VS Code start can take a while before the extension is up.
ack_timeout=${DIFFBACK_OPEN_TIMEOUT:-45}

json_string() {
  local s=${1//\\/\\\\}
  printf '"%s"' "${s//\"/\\\"}"
}

# `git diff --quiet` exits 0 for no changes, 1 for changes, anything else for an error.
has_changes() {
  local rc=0
  git -C "$repo" diff --quiet "$@" 2>/dev/null || rc=$?
  case $rc in
    0) return 1 ;;
    1) return 0 ;;
    *) fail "git diff $* failed." ;;
  esac
}

case $2 in
  staged)
    scope='"staged"'
    has_changes --cached || { echo "diffback: nothing staged." >&2; exit 3; }
    ;;
  uncommitted)
    scope='"uncommitted"'
    against=HEAD
    git -C "$repo" rev-parse --verify -q HEAD >/dev/null || against=--cached # no commits yet
    if ! has_changes "$against" && [ -z "$(git -C "$repo" ls-files --others --exclude-standard | head -n 1)" ]; then
      echo "diffback: no uncommitted changes." >&2
      exit 3
    fi
    ;;
  *...*)
    base=${2%%...*}
    head=${2#*...}
    for ref in "$base" "$head"; do
      git -C "$repo" rev-parse --verify -q "$ref^{commit}" >/dev/null || fail "unknown revision '$ref'."
    done
    scope="{\"base\": $(json_string "$base"), \"head\": $(json_string "$head")}"
    has_changes "$2" || { echo "diffback: $2 has no changes." >&2; exit 3; }
    ;;
  *) usage ;;
esac

command -v "$editor" >/dev/null ||
  fail "'$editor' is not on PATH. Install the VS Code shell command, or set DIFFBACK_EDITOR (e.g. cursor)."
"$editor" --list-extensions 2>/dev/null | grep -qix 'homka122.diffback' ||
  fail "the VS Code extension is missing. Install it with: $editor --install-extension homka122.diffback"

dir=$(git -C "$repo" rev-parse --absolute-git-dir)/diffback
mkdir -p "$dir"
id="$(date +%s)-$$-$RANDOM"
request=$dir/request.json
ack=$dir/request-ack.json
printf '{"version": 1, "id": "%s", "created": %s000, "scope": %s}\n' "$id" "$(date +%s)" "$scope" > "$request.tmp"
mv "$request.tmp" "$request"

"$editor" "$repo"

# The extension answers with request-ack.json: {"id", "status": "shown"|"empty"|"error", "files", "message"}.
for _ in $(seq "$ack_timeout"); do
  if grep -q "\"id\": \"$id\"" "$ack" 2>/dev/null; then
    case $(grep -o '"status": "[a-z]*"' "$ack") in
      *shown*)
        files=$(grep -o '"files": [0-9]*' "$ack" | grep -o '[0-9]*$' || true)
        echo "diffback: showing the $2 diff of $repo in $editor (${files:-?} files)."
        exit 0
        ;;
      *empty*)
        echo "diffback: VS Code found no $2 changes to show." >&2
        exit 3
        ;;
      *)
        fail "VS Code could not show the diff: $(grep -o '"message": ".*"' "$ack" || echo 'unknown error')"
        ;;
    esac
  fi
  sleep 1
done
fail "VS Code did not pick up the request within ${ack_timeout}s. Is the diffback extension enabled in the window that opened on $repo?"
