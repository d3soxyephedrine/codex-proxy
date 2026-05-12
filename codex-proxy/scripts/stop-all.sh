#!/usr/bin/env bash
# Stop the codex-proxy stack: proxy + peek + tmux session.
set -u

TMUX="/opt/homebrew/bin/tmux"
PROXY_PORT="${CODEX_PROXY_PORT:-3462}"
PEEK_PORT="${CODEX_PEEK_PORT:-8091}"
TMUX_SESSION="${CODEX_TMUX_SESSION:-codex-proxy}"

kill_port() {
  local port=$1 pids
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "killing :$port -> $pids"
    kill $pids 2>/dev/null || true
    sleep 1
    pids=$(lsof -ti:"$port" 2>/dev/null || true)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  fi
}

kill_port "$PROXY_PORT"
kill_port "$PEEK_PORT"

if "$TMUX" has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "killing tmux session $TMUX_SESSION"
  "$TMUX" kill-session -t "$TMUX_SESSION"
fi

echo "stopped."
