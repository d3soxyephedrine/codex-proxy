# Repository Guidelines

## What This Project Is

`codex-proxy` is a Bun/TypeScript localhost proxy for Codex traffic to the ChatGPT Codex backend. It is not just a transparent relay: `src/server.ts` normalizes OpenAI-style `/v1/responses` requests, refreshes Codex OAuth credentials, forwards to `https://chatgpt.com/backend-api/codex`, captures streamed SSE events, writes several NDJSON logs, applies optional per-caller profile gates, and exposes debug routes.

The codebase is also an observability/research tool. Keep proxy correctness, stream fidelity, auth secrecy, and diagnostic usefulness as first-class concerns.

## Project Layout

- `src/server.ts` - main Hono app, proxy request path, request normalization, auth retry, SSE interception, harmony/raw/API logs, debug endpoints, test exports.
- `src/auth.ts` - Codex auth file loading, JWT claim extraction, token freshness checks, OAuth refresh, cache invalidation after token revocation.
- `src/harmony.ts` - canonical Harmony channel/tier mapping, input text extraction, permissions block parsing, short content hashing.
- `src/hooks.ts` - optional hook module interface and loader for `onRequest`, `onSseEvent`, and `onResponseComplete`.
- `src/profiles.ts` - profile identification, role/tool/channel gates, content caps, body overrides, instructions mutation, rate limiting.
- `src/injection-detector.ts` - pattern-based prompt-injection detector used during input inspection.
- `src/fernet-decode.ts` - structural Fernet decoder for encrypted reasoning metadata only; it does not decrypt.
- `src/peek-server.ts` - local diagnostic UI/API on port `8091`, including process, tmux, wire, persistence, and channel graph views.
- `bin/proxy.ts` - starts the proxy, default `127.0.0.1:3462`.
- `bin/peek.ts` - starts the peek UI, default `127.0.0.1:8091`.
- `bin/watch.ts` and `bin/watch-multi.sh` - harmony log watcher and tmux dashboard.
- `bin/dump-thinking.ts`, `bin/probe-channels.ts`, `bin/probe-self-decrypt.ts`, `bin/priority-map.sh` - diagnostics/probes around streamed channels, profiles, and local Codex persistence.
- `examples/profiles.json` - sample profile configuration used by tests.
- `src/*.test.ts` - Bun tests colocated with source.

Generated or local-only data includes root `rollout-*.jsonl`, timestamped session `.txt` captures, `.DS_Store`, `node_modules/`, `auth.json`, and temporary logs. Do not treat these as source.

## Commands

- `bun install` - install dependencies from `bun.lock`.
- `bun run dev` - run `bin/proxy.ts` with Bun watch mode.
- `bun run start` - start the proxy once.
- `bun test` - run all tests.
- `bun run bin/peek.ts` - start the diagnostic UI.
- `bun run bin/watch.ts` - follow new harmony log events.
- `bun run bin/watch.ts --all` - replay the current harmony log from the beginning.
- `bun run bin/dump-thinking.ts [session-id] [--json|--raw]` - dump analysis-channel records from the proxy debug API.
- `bun run bin/probe-channels.ts [--model MODEL] [--json] [prompt]` - compare behavior across sample profiles.
- `bun run bin/probe-self-decrypt.ts [--model MODEL] [prompt]` - two-turn encrypted-reasoning replay probe.
- `bin/watch-multi.sh [session-name]` - open the multi-pane tmux dashboard.
- `bin/priority-map.sh [limit]` - produce a local priority/state summary from logs and Codex persistence metadata.

There is no current build or lint script. Use `bun test` as the baseline verification command.

## Runtime Configuration

Important proxy variables:

- `CODEX_PROXY_HOST`, `CODEX_PROXY_PORT` - listen address, default `127.0.0.1:3462`.
- `CODEX_PROXY_AUTH_FILE` - auth JSON path, default `~/.codex/auth.json`.
- `CODEX_PROXY_UPSTREAM_ORIGIN` - upstream origin, default `https://chatgpt.com`.
- `CODEX_PROXY_UPSTREAM_BASE_PATH` - upstream base path, default `/backend-api/codex`.
- `CODEX_PROXY_OPENAI_UPSTREAM_ORIGIN` - opt-in OpenAI passthrough origin, default `https://api.openai.com`.
- `CODEX_PROXY_OPENAI_UPSTREAM_BASE_PATH` - opt-in OpenAI passthrough base path, default `/v1`.
- `/openai/v1` - base URL prefix for OpenAI passthrough clients such as Roo Code that cannot set custom proxy-control headers.
- `x-codex-proxy-upstream: openai` or `?codex_proxy_upstream=openai` - per-request opt-in for OpenAI API passthrough using caller-supplied API auth.
- `CODEX_PROXY_DEFAULT_INSTRUCTIONS` - fallback `instructions` for response-create requests.
- `CODEX_PROXY_REASONING_SUMMARY` - default reasoning summary value, default `detailed`.
- `CODEX_PROXY_FORCE_REASONING_SUMMARY` - set `false` to avoid overriding an existing reasoning summary.
- `CODEX_PROXY_HOOK_MODULE` - absolute path to a hook module.
- `CODEX_PROXY_PROFILES_FILE` - absolute path to a profiles JSON file.
- `CODEX_PROXY_DEBUG_REQUESTS=true` - print upstream error request previews.

Log variables:

- `CODEX_PROXY_THINKING_LOG_FILE`, default `/tmp/codex-proxy-thinking.log`.
- `CODEX_PROXY_RAW_EVENT_LOG_FILE`, default `/tmp/codex-proxy-events.ndjson`.
- `CODEX_PROXY_REQUEST_LOG_FILE`, default `/tmp/codex-proxy-requests.ndjson`.
- `CODEX_PROXY_API_JSON_LOG_FILE`, default `/tmp/codex-proxy-api-json.ndjson`.
- `CODEX_PROXY_HARMONY_LOG_FILE`, default `/tmp/codex-proxy-harmony.ndjson`.
- `CODEX_PROXY_*_LOG=false` disables the matching log when supported.
- `CODEX_PROXY_HARMONY_CONTENT` is `head` by default; supported values are `head`, `full`, `hash`, and `none`.
- `CODEX_PROXY_HARMONY_CONTENT_HEAD` controls head-mode preview length, default `256`.

Peek variables:

- `CODEX_PEEK_HOST`, `CODEX_PEEK_PORT` - listen address, default `127.0.0.1:8091`.
- `CODEX_PEEK_PROXY_ORIGIN` - proxy base URL used by peek, default `http://127.0.0.1:3462`.
- `CODEX_HOME` - Codex home used by local persistence diagnostics, default `~/.codex`.

## Core Proxy Invariants

- Preserve SSE byte-for-byte passthrough when no `onSseEvent` hook is active and no profile channel filter applies. If parsing is required, keep event reconstruction standards-compliant.
- Keep request normalization narrow. `/v1/responses` and `/responses` are response-create paths; `/responses/compact` should only receive scrubbed echoed input items, not create-only defaults like `store`, `instructions`, or `reasoning`.
- Strip backend-rejected echoed item fields (`phase`, `obfuscation`, `logprobs`) and remap echoed `output_text` content parts to `input_text`.
- Never forward caller-supplied auth headers. `buildHeaders` must own authorization, ChatGPT browser-like headers, account ID, and session ID forwarding.
- The only exception is explicit OpenAI passthrough mode, where `buildOpenAIHeaders` preserves caller-supplied OpenAI API auth and strips proxy/Codex control headers before forwarding to `api.openai.com`.
- Session IDs may arrive by query, `session_id`, `x-codex-session-id`, or JSON body. Forward upstream as the `session_id` header and remove body/query copies where appropriate.
- Profile gates run before user hooks. Profile read-channel filtering runs before `onSseEvent`. Preserve this order.
- Profile `bodyOverrides` are applied before `instructions`/`instructionsMode`; the latter wins for final instructions text.
- Codex structural roles (`function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`, `reasoning`, `compaction`) pass profile write-role gates even for restricted profiles.
- Harmony channel mapping is centralized in `src/harmony.ts`; update tests when adding event types.
- Fernet handling is structural inspection only. Do not imply the proxy can decrypt encrypted reasoning without the server-held key.

## Debug Routes

The main proxy exposes:

- `GET /health`
- `GET /debug/events`
- `GET /debug/requests`
- `GET /debug/transcript`
- `GET /debug/api-json`
- `GET /debug/harmony`
- `GET /debug/tiers`
- `GET /debug/developer/diff`
- `GET /debug/permissions`
- `GET /debug/tools/catalog`
- `GET /debug/analysis`
- `GET /debug/encrypted-reasoning`
- `GET /debug/injections`
- `GET /debug/profiles`
- `GET /debug/profiles/check`
- `GET /debug/profiles/:name`
- `GET /debug/profiles/:name/activity`
- `GET /debug/channels/live`

The peek server exposes local-only `/api/*` wrappers and native probes. These endpoints should remain read-only and should report secrets as redacted values, hashes, lengths, schemas, counts, or metadata.

## Security And Privacy

- Never commit or print raw `auth.json`, bearer tokens, refresh tokens, cookies, secret keys, or unredacted environment values.
- Treat raw event logs, request logs, API JSON logs, harmony logs in `full` mode, and session captures as sensitive. They may contain prompts, tool calls, model output, or local paths.
- Keep diagnostics local-first. Defaults should bind to `127.0.0.1`, not public interfaces.
- When adding a debug endpoint, prefer summaries, hashes, counts, and bounded tails over full-content dumps.
- If a change introduces a new environment variable, document it here and in the PR/commit notes.
- Avoid writing new diagnostics that connect to private app/browser sockets or read secret file contents unless explicitly required and carefully redacted.

## Coding Style

- Use TypeScript ESM with explicit imports.
- Keep two-space indentation, semicolons, and double quotes.
- Prefer `const`; use `let` only for reassignment.
- Use `camelCase` for functions and locals, `PascalCase` for types/interfaces, and uppercase names for environment-derived constants.
- Keep helper logic in the module that owns the behavior unless it is genuinely shared.
- Keep comments short and useful, especially around protocol quirks and backend compatibility constraints.
- Do not edit `node_modules/`, generated logs, session artifacts, or local auth files.

## Testing

Use Bun's built-in test framework from `bun:test`. Tests live next to source as `src/*.test.ts`.

Run `bun test` before claiming a change is complete. For focused work, run the relevant test file first, then the full suite when feasible:

- Request/SSE/debug behavior: `bun test src/server.test.ts`
- Profile behavior: `bun test src/profiles.test.ts`
- Injection rules: `bun test src/injection-detector.test.ts`
- Fernet structure parsing: `bun test src/fernet-decode.test.ts`

When tests need filesystem state, create isolated directories under `tmpdir()` and clean them in `afterAll`, following `src/server.test.ts`.

## Change Guidance

- For proxy-path changes, think through both streaming and non-streaming responses.
- For SSE changes, verify passthrough, parsed/mutated mode, capture logs, deduplication of delta/done events, and completion flushing.
- For profile changes, cover role gating, tool filtering, read-channel filtering, rate limits, body overrides, and instruction mutation order.
- For observability changes, update the relevant debug route and watcher behavior together when the log schema changes.
- For peek UI changes, start `bun run bin/peek.ts` and inspect `http://127.0.0.1:8091`.

## Commit And PR Notes

This working directory does not currently behave as a Git repository from the project root, so do not assume local history is available. If committing elsewhere, use short imperative subjects such as `Fix SSE replay capture` or `Add profile body override tests`.

Pull requests should describe behavior changes, list test commands run, call out log/debug schema changes, mention new environment variables, and include screenshots only for peek UI changes.
