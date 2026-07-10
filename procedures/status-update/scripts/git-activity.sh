#!/usr/bin/env bash
# git-activity.sh — commits in a window by one author, in a fixed deterministic format.
# The status-update procedure's `extract` beat runs this verbatim: two runs over the same
# window must yield the same evidence set, so the format is stable and parseable, never
# interpreted here. Fail-soft: absent git / non-repo / empty window all exit 0 with a
# single explanatory line (the extract beat degrades to "no evidence", never an error).
set -euo pipefail

since=""
since_set=0
until=""
until_set=0
author=""
author_set=0
repo="$(pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --since)  since="${2:-}"; since_set=1; shift 2 ;;
    --until)  until="${2:-}"; until_set=1; shift 2 ;;
    --author) author="${2:-}"; author_set=1; shift 2 ;;
    --repo)   repo="${2:-}"; shift 2 ;;
    *) echo "git-activity: unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Default window is yesterday — the last full calendar day, local time. Use git's own
# approxidate so the bounds stay portable across BSD/GNU date: "yesterday.midnight" pins to
# local start-of-yesterday, "midnight" to local start-of-today.
#   neither flag → since = start of yesterday, until = start of today
#   --since alone → until unbounded (open-ended, as before)
if [ "$since_set" -eq 0 ] && [ "$until_set" -eq 0 ]; then
  since="yesterday.midnight"
  until="midnight"
  until_set=1
fi

command -v git >/dev/null 2>&1 || { echo "git-activity: git not found — no commit evidence available"; exit 0; }
git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "git-activity: $repo is not a git repository — no commit evidence available"; exit 0; }

# Default the author to the repo's configured identity; leave it empty (no filter) if unset.
if [ "$author_set" -eq 0 ]; then
  author="$(git -C "$repo" config user.email 2>/dev/null || true)"
fi

# Assemble the window bounds: --since always present (empty = unbounded start, git ignores
# an empty --since), --until only when set. The header states both, "now" when open-ended.
win_args=()
if [ -n "$since" ]; then win_args+=(--since="$since"); since_label="\"$since\""; else since_label="the beginning"; fi
if [ "$until_set" -eq 1 ]; then
  win_args+=(--until="$until")
  until_label="\"$until\""
else
  until_label="now"
fi

if [ -n "$author" ]; then
  echo "# commits since $since_label until $until_label by author matching \"$author\" (repo: $repo)"
  log_out="$(git -C "$repo" log "${win_args[@]}" --author="$author" --no-merges --date=short --pretty=format:'%h %ad %s' --shortstat 2>/dev/null || true)"
else
  echo "# commits since $since_label until $until_label by any author (repo: $repo)"
  log_out="$(git -C "$repo" log "${win_args[@]}" --no-merges --date=short --pretty=format:'%h %ad %s' --shortstat 2>/dev/null || true)"
fi

if [ -z "$log_out" ]; then
  echo "no commits in window"
  exit 0
fi

# Fold each commit's --shortstat onto its subject line: "<hash> <date> <subject> | <stat>".
# git prints the shortstat on the line(s) after the pretty line and separates commits with a
# blank line; awk collapses that into one line per commit, deterministic and parseable.
printf '%s\n' "$log_out" | awk '
  /^[0-9a-f]+ [0-9]{4}-[0-9]{2}-[0-9]{2} / {
    if (line != "") print line;
    line = $0; next;
  }
  /files? changed/ {
    stat = $0; sub(/^[ \t]+/, "", stat);
    line = line " | " stat; next;
  }
  END { if (line != "") print line; }
'
