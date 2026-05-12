#!/usr/bin/env bash
# codex-proxy stack: proxy (3462) + peek dashboard (8091) + tmux dashboard panes
# Idempotent: safe to re-run. Proxy is foreground so launchd KeepAlive watches it.
set -u

REPO="/Users/andrejfidanovski/projects/codex-proxy"
BUN="/opt/homebrew/bin/bun"
TMUX="/opt/homebrew/bin/tmux"
LOG_DIR="/tmp"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="${HOME:-/Users/andrejfidanovski}"

export CODEX_PROXY_HOST="${CODEX_PROXY_HOST:-127.0.0.1}"
export CODEX_PROXY_PORT="${CODEX_PROXY_PORT:-3462}"
export CODEX_PROXY_AUTH_MODE="${CODEX_PROXY_AUTH_MODE:-api_key}"
export CODEX_PROXY_OPENAI_UPSTREAM_ORIGIN="${CODEX_PROXY_OPENAI_UPSTREAM_ORIGIN:-https://openrouter.ai/api}"
export CODEX_PROXY_HARMONY_CONTENT="${CODEX_PROXY_HARMONY_CONTENT:-full}"
export CODEX_PROXY_PROFILES_FILE="${CODEX_PROXY_PROFILES_FILE:-$HOME/.codex-proxy/profiles.json}"

PEEK_PORT="${CODEX_PEEK_PORT:-8091}"
TMUX_SESSION="${CODEX_TMUX_SESSION:-codex-proxy}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

start_peek() {
  if lsof -ti:"$PEEK_PORT" >/dev/null 2>&1; then
    log "peek already on :$PEEK_PORT"
    return
  fi
  log "starting peek on :$PEEK_PORT"
  nohup "$BUN" run "$REPO/bin/peek.ts" >> "$LOG_DIR/codex-peek.log" 2>&1 &
  disown
}

start_tmux() {
  if "$TMUX" has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "tmux session '$TMUX_SESSION' already exists"
    return
  fi
  log "creating tmux session '$TMUX_SESSION'"
  ( cd "$REPO" && bash bin/watch-multi.sh "$TMUX_SESSION" ) >> "$LOG_DIR/codex-watch-multi.log" 2>&1 < /dev/null &
  disown
}

kill_stale_proxy() {
  local pids
  pids=$(lsof -ti:"$CODEX_PROXY_PORT" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    log "killing stale proxy on :$CODEX_PROXY_PORT: $pids"
    kill $pids 2>/dev/null || true
    sleep 1
    pids=$(lsof -ti:"$CODEX_PROXY_PORT" 2>/dev/null || true)
    [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
  fi
}

cd "$REPO"

kill_stale_proxy
start_peek
start_tmux

log "starting proxy on $CODEX_PROXY_HOST:$CODEX_PROXY_PORT (upstream=$CODEX_PROXY_OPENAI_UPSTREAM_ORIGIN auth_mode=$CODEX_PROXY_AUTH_MODE)"
exec "$BUN" run "$REPO/bin/proxy.ts"
