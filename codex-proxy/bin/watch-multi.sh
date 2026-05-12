#!/usr/bin/env bash
# Live multi-pane codex-proxy dashboard. Requires tmux.
# Usage: ./bin/watch-multi.sh [session-name]

set -euo pipefail

SESSION="${1:-codex-proxy}"
PROXY_BASE="${CODEX_PROXY_BASE:-http://127.0.0.1:3462}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not installed. brew install tmux" >&2
  exit 1
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "session $SESSION already exists — attaching"
  tmux attach -t "$SESSION"
  exit 0
fi

# Top-left: smart watcher (the headline view — all events, color-coded, injections pop)
tmux new-session -d -s "$SESSION" -x 220 -y 56 \
  "cd '$REPO_ROOT' && bun run bin/watch.ts; echo 'watch ended — press enter to close'; read"

# Split right: analysis channel (model's CoT)
tmux split-window -t "$SESSION":0 -h -p 50 \
  "echo '── ANALYSIS CHANNEL (model CoT) ──'; curl -sN '$PROXY_BASE/debug/channels/live?channels=analysis' | grep --line-buffered -v '^:'"

# Split bottom-left: live injections only
tmux select-pane -t "$SESSION":0.0
tmux split-window -t "$SESSION":0 -v -p 35 \
  "while true; do clear; echo '── INJECTIONS (last 60s, refreshing every 3s) ──'; curl -s '$PROXY_BASE/debug/injections?limit=200' | python3 -c 'import json,sys,datetime
d=json.load(sys.stdin)
print(f\"total {d[\\\"count\\\"]}  by-severity {d[\\\"bySeverity\\\"]}\")
print(\"by-rule:\", d[\"byRule\"])
print(\"--\")
for r in d[\"recent\"][-20:]:
    sev=r.get(\"severity\",\"?\")
    badge={\"critical\":\"\\033[1;41;97m\",\"high\":\"\\033[1;31m\",\"medium\":\"\\033[33m\",\"low\":\"\\033[90m\"}.get(sev,\"\")
    end=\"\\033[0m\"
    print(f\"{r.get(\\\"at\\\",\\\"\\\")[11:19]} {badge}{sev:8}{end} {r.get(\\\"rule\\\",\\\"\\\"):25} tier={r.get(\\\"tier\\\",\\\"\\\"):10} {r.get(\\\"matchedSnippet\\\",\\\"\\\")[:80]}\")
'; sleep 3; done"

# Split bottom-right: profile activity / stats
tmux select-pane -t "$SESSION":0.1
tmux split-window -t "$SESSION":0 -v -p 35 \
  "while true; do clear; echo '── PROFILES + STATS (refresh 2s) ──'; curl -s '$PROXY_BASE/health' | python3 -c 'import json,sys
d=json.load(sys.stdin)
s=d.get(\"stats\",{})
print(f\"uptime {d.get(\\\"uptime\\\")}s  reqs {s.get(\\\"totalRequests\\\")}  active {s.get(\\\"activeRequests\\\")}  harmony-events {s.get(\\\"harmonyEventsLogged\\\")}\")
prof=d.get(\"profiles\")
if prof: print(f\"profiles: {prof[\\\"names\\\"]}  default={prof[\\\"default\\\"]}\")
print()
'; for p in director teammate webhook audit; do
  curl -s \"$PROXY_BASE/debug/profiles/\$p/activity?limit=500\" 2>/dev/null | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  if d.get(\"count\",0)==0: sys.exit(0)
  print(f\"  \\033[1m{d[\\\"profile\\\"]:10}\\033[0m  {d[\\\"summary\\\"]}\")
except: pass
'
done; sleep 2; done"

tmux select-pane -t "$SESSION":0.0
tmux attach -t "$SESSION"
