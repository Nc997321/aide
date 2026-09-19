#!/usr/bin/env bash
# A/B probe: does rust-analyzer's DEFAULT config already keep `target/` and
# `node_modules/` out of its working set?
#
#   A = pristine defaults (no initializationOptions, no didChangeConfiguration)
#   B = cargo.linkedProjects pinned to src-tauri + files.exclude / watcherExclude
#
# Both phases answer the same references query and report:
#   - elapsedMs until the query returns a non-empty result (index-ready proxy)
#   - peak RSS across all rust-analyzer processes
#
# Usage:  ./run-ra-ab.sh A     (run each phase in its own shell — a full cold
#         ./run-ra-ab.sh B      start can exceed a single command timeout)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="C:/Users/<user>/IdeaProjects/aide"
PROBE="$HERE/probe.mjs"
FILE="src-tauri/src/lsp/manager.rs"
LINE=80
COL=15

CONFIG='{"rust-analyzer":{"cargo":{"linkedProjects":["src-tauri/Cargo.toml"]},"files":{"exclude":["src-tauri/target","node_modules"],"watcherExclude":["src-tauri/target","node_modules"]}}}'

phase="${1:?usage: run-ra-ab.sh A|B}"

# Start from a clean slate: a leftover server would make the "cold" start warm.
taskkill //F //T //IM rust-analyzer.exe >/dev/null 2>&1
sleep 2

mem="$HERE/$phase.mem"
: > "$mem"
(
  while :; do
    # bash's date, not awk's systime() — mawk has no systime and would log blanks.
    printf '%s ' "$(date +%s)" >> "$mem"
    tasklist 2>/dev/null | grep -i '^rust-analyzer.exe' \
      | awk '{gsub(/,/,"",$5); s+=$5} END{print s+0}' >> "$mem"
    sleep 5
  done
) &
sampler=$!

extra=""
[ "$phase" = "B" ] && extra="--init-options $CONFIG --settings $CONFIG"

node "$PROBE" \
  --server rust-analyzer --root "$REPO" \
  --file "$FILE" --line "$LINE" --col "$COL" \
  --op references --poll-ms 5000 --poll-timeout 420000 \
  $extra > "$HERE/$phase.probe.json" 2> "$HERE/$phase.err"
rc=$?

kill $sampler 2>/dev/null
echo "=== phase $phase (exit $rc) ==="
cat "$HERE/$phase.probe.json"
echo "--- stderr ---"
tail -5 "$HERE/$phase.err"
echo "--- peak RSS across rust-analyzer processes (KB) ---"
sort -k2 -n "$mem" | tail -1
