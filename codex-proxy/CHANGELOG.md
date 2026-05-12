# Changelog

## 2026-05-11 — observability + chat-completions + prompt-swap primitives

Major upgrade across three concerns: rate-limit observability, OpenRouter / chat-completions parity with Codex Responses API, and profile-driven system-prompt swapping.

### Rate limit & header observability — `src/server.ts`

- New `parseRateLimitHeaders(headers) → RateLimitSnapshot | null` extracts `x-codex-*` signals (`active-limit`, `plan-type`, primary/secondary `used-percent`/`window-minutes`/`reset-after-seconds`/`reset-at`, `primary-over-secondary-limit-percent`, `credits-has-credits`, `credits-unlimited`, `x-oai-request-id`, `x-models-etag`). Returns null if no `x-codex-*` signal present. Boolean fields case-insensitive (`TRUE`/`true`); garbage → null. Empty strings → null.
- New `headersForLog(headers)` sanitizer — drops `set-cookie`, `cookie`, `authorization`, `x-api-key`, plus noisy CDN headers (`cf-ray`, `cf-cache-status`, `alt-svc`, `strict-transport-security`, `vary`, `server`, `date`). Keeps `x-codex-*`, `x-oai-request-id`, `content-type`. Truncates values >512 chars with `...[truncated]`.
- New `GET /debug/ratelimits` — `{ sessionFilter, count, latest, liveTimers, latestBySession, history }`.
- SSE error capture: `response.failed`, `cyber_policy` rejections, and bare `error` events are now surfaced (previously filtered out).

### Chat-completions / OpenRouter parity — `src/server.ts`

- New `processChatCompletionChunk(event, capture)` (~80 lines) — parses OpenAI/OpenRouter `delta.reasoning_content` / `delta.reasoning` / `delta.reasoning_details[].summary` into the same `ChannelCapture` infrastructure used by Codex Responses API. `/debug/cot`, `/debug/refusals`, `/debug/transcript` now work for Roo Code / OpenAI SDK / Cursor traffic too.
- New `openrouterProvider: string | null` field on response envelope — shows the underlying upstream OpenRouter routed to (`"OpenAI"`, `"Anthropic"`, `"DeepSeek"`, etc.). Populated from `event.provider`.
- New `GET /debug/cot` — `{ sessionFilter, modelFilter, minBytes, includeFinal, requestCount, totalAnalysisBytes, rows }`. Each row carries `requestId`, model, `analysisBytes`, `provider`, and the captured CoT text. Reads from harmony log — set `CODEX_PROXY_HARMONY_CONTENT=full` for untruncated content (default `head` caps at 256 chars/chunk).

### Profile-driven prompt swap — `src/profiles.ts`

Four new `ProfileDef` fields:

| Field | Type | Effect |
|---|---|---|
| `systemMessage` | `string` | Text to combine with caller's existing system message |
| `systemMessageMode` | `"replace" \| "prepend" \| "append" \| "wrap"` | How to combine (`wrap` brackets the original) |
| `stripTools` | `boolean` | Delete `tools[]` from request body — breaks harnesses that force tool-call output |
| `disableToolForcing` | `boolean` | Softer: force `tool_choice: "none"` while leaving tools defined |

New helpers: `applySystemMessageMode(originalText, ourText, mode) → { result, applied, mode }`, `mutateMessagesSystemPrompt(messages, ourText, mode)`. `applyProfileGates` returns `systemMessageMutation: { mode, originalLen, finalLen } | null` so the debug surface can show what got rewritten.

New profiles in `~/.codex-proxy/profiles.json` and `examples/profiles.json`:

- `openai-direct` — `authMode: api_key`, all roles writable, no swap, `reasoning.effort=high`. Force-route to OpenAI/OpenRouter upstream.
- `swap-roo-pirate` — `authMode: api_key` + pirate-vernacular system prompt + `stripTools: true` + `disableToolForcing: true`. Example/test profile for the swap primitives.
- `swap-roo-codexmax` — Same shape; system message is the user's 7,686-char CODEX_MAX persona stack (project_instructions + CODEX_MAX mode).

### Tests

197/197 passing across 5 files (≈37 new tests for the additions above):

- `src/server.test.ts` — rate-limit headers, SSE error events, chat-completions parser integration
- `src/profiles.test.ts` — swap primitives (replace/prepend/append/wrap), `applyProfileGates` integration

### Auth mode discovery

Confirmed at the wire: through `Roo Code → OpenRouter → OpenAI`, persona-swap bypasses three layers cleanly — Codex CLI's developer-tier framing (different client), ChatGPT-account safety stack (api-key path), Roo Code's 26 KB system prompt (we own `messages[0]`). On `openai/gpt-5.5` the swap took ~5% adoption — model RLHF is the dominant remaining defender. `cyber_policy` rejections do not appear on the api-key path; that classifier is a chatgpt-backend feature.

## 2026-05-11 — auto-start via launchd

New stack-orchestration scripts and a launch agent so the proxy + peek + tmux dashboard start at login and restart on crash.

- `scripts/start-all.sh` — idempotent launcher. Kills stale listener on `:3462`, starts peek (`:8091`) and the `codex-proxy` tmux session if missing, then `exec`s the proxy in foreground (so launchd `KeepAlive` watches it). Default env: `CODEX_PROXY_AUTH_MODE=api_key`, `CODEX_PROXY_OPENAI_UPSTREAM_ORIGIN=https://openrouter.ai/api`, `CODEX_PROXY_HARMONY_CONTENT=full`, `CODEX_PROXY_PROFILES_FILE=~/.codex-proxy/profiles.json`.
- `scripts/stop-all.sh` — clean teardown of proxy + peek + tmux session.
- `~/Library/LaunchAgents/com.codex-proxy.plist` — `RunAtLoad=true`, `KeepAlive` on crash only, `ThrottleInterval=10`, logs to `/tmp/codex-proxy.log`.

Management:

```bash
launchctl kickstart -k gui/$(id -u)/com.codex-proxy    # restart
launchctl bootout   gui/$(id -u)/com.codex-proxy       # stop + unregister
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codex-proxy.plist  # register + start
```

### Known issue

`/api/tmux/sessions` on peek mis-parses `tmux ls` output and shows the session as `codex-proxy_1_` in the dropdown. `/api/tmux/capture?session=codex-proxy` works correctly — pre-existing peek-server.ts bug.
