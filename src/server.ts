import { appendFileSync, existsSync, readFileSync } from "fs";
import { Hono } from "hono";
import { brotliDecompressSync, gunzipSync, inflateSync } from "zlib";
import { getAuthPath, getAuthState, getStoredAuthInfo } from "./auth";

const UPSTREAM_ORIGIN = process.env.CODEX_PROXY_UPSTREAM_ORIGIN || "https://chatgpt.com";
const UPSTREAM_BASE_PATH = process.env.CODEX_PROXY_UPSTREAM_BASE_PATH || "/backend-api/codex";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const BROWSER_USER_AGENT = process.env.CODEX_PROXY_USER_AGENT
  || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
const DEFAULT_INSTRUCTIONS = process.env.CODEX_PROXY_DEFAULT_INSTRUCTIONS
  || "You are Codex, OpenAI's coding agent running in a terminal. Work directly, write clearly, and stay focused on the task.";
const DEFAULT_REASONING_SUMMARY = process.env.CODEX_PROXY_REASONING_SUMMARY || "detailed";
const FORCE_REASONING_SUMMARY = process.env.CODEX_PROXY_FORCE_REASONING_SUMMARY !== "false";
const THINKING_LOG_PATH = process.env.CODEX_PROXY_THINKING_LOG_FILE || "/tmp/codex-proxy-thinking.log";
const RAW_EVENT_LOG_PATH = process.env.CODEX_PROXY_RAW_EVENT_LOG_FILE || "/tmp/codex-proxy-events.ndjson";
const RAW_EVENT_LOG_ENABLED = process.env.CODEX_PROXY_RAW_EVENT_LOG !== "false";
const REQUEST_LOG_PATH = process.env.CODEX_PROXY_REQUEST_LOG_FILE || "/tmp/codex-proxy-requests.ndjson";
const REQUEST_LOG_ENABLED = process.env.CODEX_PROXY_REQUEST_LOG !== "false";
const API_JSON_LOG_PATH = process.env.CODEX_PROXY_API_JSON_LOG_FILE || "/tmp/codex-proxy-api-json.ndjson";
const API_JSON_LOG_ENABLED = process.env.CODEX_PROXY_API_JSON_LOG !== "false";
const DEBUG_REQUESTS = process.env.CODEX_PROXY_DEBUG_REQUESTS === "true";
const REQUEST_TIMEOUT_MS = 600_000;
const SEPARATOR = "=".repeat(28);

const app = new Hono();
const startedAt = Date.now();
const encoder = new TextEncoder();

const stats = {
  totalRequests: 0,
  activeRequests: 0,
  lastRequestAt: 0,
  rawEventsLogged: 0,
  requestsLogged: 0,
  apiJsonRecordsLogged: 0,
};

interface RequestSummary {
  model: string;
  stream: boolean;
}

interface PreparedRequest {
  summary: RequestSummary;
  body: ArrayBuffer | Uint8Array | undefined;
  sessionId: string | null;
}

interface StreamCapture {
  requestId: string;
  path: string;
  sessionId: string | null;
  startedAt: number;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: string;
  reasoning: string[];
  text: string[];
  seenTextParts: Set<string>;
  seenReasoningParts: Set<string>;
  logStarted: boolean;
  reasoningSectionOpen: boolean;
  textSectionOpen: boolean;
  flushed: boolean;
}

function thinkingLog(text: string) {
  try {
    appendFileSync(THINKING_LOG_PATH, text, "utf8");
  } catch (error) {
    console.error(`[proxy] failed to write thinking log: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function rawEventLog(event: Record<string, any>, capture: StreamCapture) {
  if (!RAW_EVENT_LOG_ENABLED) return;

  try {
    appendFileSync(RAW_EVENT_LOG_PATH, `${JSON.stringify({
      at: new Date().toISOString(),
      requestId: capture.requestId,
      path: capture.path,
      sessionId: capture.sessionId,
      model: capture.model,
      type: typeof event.type === "string" ? event.type : "unknown",
      event,
    })}\n`, "utf8");
    stats.rawEventsLogged += 1;
  } catch (error) {
    console.error(`[proxy] failed to write raw event log: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function appendJsonLine(path: string, value: Record<string, any>, label: string) {
  try {
    appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
  } catch (error) {
    console.error(`[proxy] failed to write ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function apiJsonLog(value: Record<string, any>) {
  if (!API_JSON_LOG_ENABLED) return;

  appendJsonLine(API_JSON_LOG_PATH, {
    at: new Date().toISOString(),
    ...value,
  }, "API JSON log");
  stats.apiJsonRecordsLogged += 1;
}

function readNdjsonTail(path: string, limit: number): Record<string, any>[] {
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, any>;
      } catch {
        return { malformed: true, raw: line };
      }
    });
}

function parseLimit(value: string | undefined, fallback: number, max: number): number {
  return Math.min(Number.parseInt(value || String(fallback), 10) || fallback, max);
}

function filterLogEntries(
  entries: Record<string, any>[],
  filters: { requestId?: string; sessionId?: string; type?: string },
): Record<string, any>[] {
  return entries.filter((entry) => {
    if (filters.requestId && entry.requestId !== filters.requestId) return false;
    if (filters.sessionId && entry.sessionId !== filters.sessionId) return false;
    if (filters.type && entry.type !== filters.type) return false;
    return true;
  });
}

function bodyForLog(headers: Headers, body: ArrayBuffer | Uint8Array | undefined): unknown {
  if (!body || body.byteLength === 0) return null;

  const contentType = headers.get("content-type") || "";
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return new TextDecoder().decode(bytes);
    }
  }

  if (contentType.startsWith("text/") || contentType.includes("x-www-form-urlencoded")) {
    return new TextDecoder().decode(bytes);
  }

  return {
    contentType: contentType || "application/octet-stream",
    bytes: body.byteLength,
  };
}

function headersForLog(headers: Headers): Record<string, string> {
  const preview: Record<string, string> = {};

  for (const name of [
    "accept",
    "content-encoding",
    "content-length",
    "content-type",
    "openai-beta",
    "session_id",
    "transfer-encoding",
    "user-agent",
    "x-codex-session-id",
  ]) {
    const value = headers.get(name);
    if (value) {
      preview[name] = value;
    }
  }

  return preview;
}

function requestLog(
  requestId: string,
  method: string,
  url: string,
  headers: Headers,
  prepared: PreparedRequest,
) {
  if (!REQUEST_LOG_ENABLED) return;

  const parsedUrl = new URL(url);
  appendJsonLine(REQUEST_LOG_PATH, {
    at: new Date().toISOString(),
    requestId,
    method,
    path: parsedUrl.pathname,
    search: parsedUrl.search,
    model: prepared.summary.model,
    stream: prepared.summary.stream,
    sessionId: prepared.sessionId,
    body: bodyForLog(headers, prepared.body),
  }, "request log");
  stats.requestsLogged += 1;
}

function formatTime(value = Date.now()): string {
  return new Date(value).toISOString().slice(11, 19);
}

function normalizeUpstreamPath(pathname: string): string {
  if (pathname.startsWith(`${UPSTREAM_BASE_PATH}/`) || pathname === UPSTREAM_BASE_PATH) {
    return pathname;
  }

  if (pathname === "/v1") {
    return UPSTREAM_BASE_PATH;
  }

  if (pathname.startsWith("/v1/")) {
    return `${UPSTREAM_BASE_PATH}${pathname.slice(3)}`;
  }

  if (pathname === "/") {
    return UPSTREAM_BASE_PATH;
  }

  return `${UPSTREAM_BASE_PATH}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function buildUpstreamUrl(requestUrl: string, sessionId: string | null): string {
  const sourceUrl = new URL(requestUrl);
  const upstreamUrl = new URL(UPSTREAM_ORIGIN);
  const pathname = normalizeUpstreamPath(sourceUrl.pathname);

  sourceUrl.searchParams.delete("session_id");

  upstreamUrl.pathname = pathname;
  const search = sourceUrl.searchParams.toString();
  upstreamUrl.search = search ? `?${search}` : "";
  return upstreamUrl.toString();
}

function buildHeaders(
  source: Headers,
  accessToken: string,
  accountId: string | null,
  sessionId: string | null,
  authMode: string | null,
): Headers {
  const headers = new Headers(source);
  const apiKeyMode = (authMode || "").toLowerCase() === "apikey";

  for (const header of [
    "authorization",
    "content-encoding",
    "content-length",
    "host",
    "x-api-key",
    "api-key",
  ]) {
    headers.delete(header);
  }

  headers.set("authorization", `Bearer ${accessToken}`);

  if (apiKeyMode) {
    headers.delete("chatgpt-account-id");
    headers.delete("session_id");
    headers.delete("origin");
    headers.delete("referer");
    headers.delete("oai-language");
    headers.delete("sec-fetch-dest");
    headers.delete("sec-fetch-mode");
    headers.delete("sec-fetch-site");
    if (!headers.has("user-agent")) {
      headers.set("user-agent", "codex-proxy/0.1.0");
    }
    return headers;
  }

  for (const header of ["openai-beta", "openai-organization", "openai-project"]) {
    headers.delete(header);
  }

  headers.set("origin", CHATGPT_ORIGIN);
  headers.set("referer", `${CHATGPT_ORIGIN}/`);
  headers.set("accept-language", "en-US,en;q=0.9");
  headers.set("oai-language", "en-US");
  headers.set("sec-fetch-dest", "empty");
  headers.set("sec-fetch-mode", "cors");
  headers.set("sec-fetch-site", "same-origin");
  headers.set("user-agent", BROWSER_USER_AGENT);

  if (accountId) {
    headers.set("chatgpt-account-id", accountId);
  } else {
    headers.delete("chatgpt-account-id");
  }

  if (sessionId) {
    headers.set("session_id", sessionId);
  } else {
    headers.delete("session_id");
  }

  return headers;
}

function hasBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function isWebSocketUpgrade(headers: Headers): boolean {
  return headers.get("upgrade")?.toLowerCase() === "websocket"
    || headers.has("sec-websocket-key");
}

function decodeRequestBody(headers: Headers, body: ArrayBuffer | undefined): ArrayBuffer | Uint8Array | undefined {
  if (!body) {
    return body;
  }

  const encoding = headers.get("content-encoding")?.toLowerCase();
  if (!encoding || encoding === "identity") {
    return body;
  }

  const bytes = new Uint8Array(body);

  try {
    switch (encoding) {
      case "br":
        return brotliDecompressSync(bytes);
      case "deflate":
        return inflateSync(bytes);
      case "gzip":
      case "x-gzip":
        return gunzipSync(bytes);
      case "zstd":
        return Bun.zstdDecompressSync(bytes);
      default:
        return body;
    }
  } catch {
    return body;
  }
}

function inspectRequest(headers: Headers, body: ArrayBuffer | Uint8Array | undefined): RequestSummary {
  let model = "-";
  let stream = headers.get("accept")?.includes("text/event-stream") || false;

  if (!body || body.byteLength === 0) {
    return { model, stream };
  }

  const contentType = headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return { model, stream };
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    if (typeof parsed.model === "string" && parsed.model.length > 0) {
      model = parsed.model;
    }
    if (typeof parsed.stream === "boolean") {
      stream = parsed.stream;
    }
  } catch {
    // Opaque relay means malformed client JSON should still be forwarded upstream.
  }

  return { model, stream };
}

function parseJsonBody(headers: Headers, body: ArrayBuffer | Uint8Array | undefined): Record<string, any> | null {
  if (!body || body.byteLength === 0) {
    return null;
  }

  const contentType = headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, any> : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeReasoningSummary(value: string): "auto" | "concise" | "detailed" | "none" {
  const normalized = value.toLowerCase();
  return normalized === "auto" || normalized === "concise" || normalized === "none"
    ? normalized
    : "detailed";
}

function normalizeInputValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    return [{
      role: "user",
      content: [{
        type: "input_text",
        text: value,
      }],
    }];
  }

  if (value && typeof value === "object") {
    return [value];
  }

  return value;
}

function extractSessionId(url: URL, headers: Headers, body: Record<string, any> | null): string | null {
  return readString(url.searchParams.get("session_id"))
    || readString(headers.get("session_id"))
    || readString(headers.get("x-codex-session-id"))
    || readString(body?.session_id);
}

function isResponseCreatePath(requestUrl: string): boolean {
  return normalizeUpstreamPath(new URL(requestUrl).pathname) === `${UPSTREAM_BASE_PATH}/responses`;
}

function prepareRequest(
  requestUrl: string,
  headers: Headers,
  body: ArrayBuffer | Uint8Array | undefined,
): PreparedRequest {
  const summary = inspectRequest(headers, body);
  const parsedBody = parseJsonBody(headers, body);
  const sessionId = extractSessionId(new URL(requestUrl), headers, parsedBody);

  if (!parsedBody) {
    return { summary, body, sessionId };
  }

  let changed = false;
  const nextBody: Record<string, any> = { ...parsedBody };

  if (sessionId && typeof nextBody.session_id === "string") {
    delete nextBody.session_id;
    changed = true;
  }

  if (!isResponseCreatePath(requestUrl)) {
    return {
      summary,
      sessionId,
      body: changed ? encoder.encode(JSON.stringify(nextBody)) : body,
    };
  }

  const normalizedInput = normalizeInputValue(nextBody.input);
  if (normalizedInput !== nextBody.input) {
    nextBody.input = normalizedInput;
    changed = true;
  }

  if (typeof nextBody.store !== "boolean") {
    nextBody.store = false;
    changed = true;
  }

  if (!readString(nextBody.instructions)) {
    nextBody.instructions = DEFAULT_INSTRUCTIONS;
    changed = true;
  }

  const reasoningSummary = normalizeReasoningSummary(DEFAULT_REASONING_SUMMARY);
  if (reasoningSummary !== "none") {
    const currentReasoning = nextBody.reasoning && typeof nextBody.reasoning === "object" && !Array.isArray(nextBody.reasoning)
      ? nextBody.reasoning as Record<string, any>
      : {};
    const currentSummary = readString(currentReasoning.summary);

    if (FORCE_REASONING_SUMMARY || !currentSummary || currentSummary === "none") {
      nextBody.reasoning = {
        ...currentReasoning,
        summary: reasoningSummary,
      };
      changed = true;
    }
  }

  if (summary.stream && typeof nextBody.stream !== "boolean") {
    nextBody.stream = true;
    changed = true;
  }

  return {
    summary,
    sessionId,
    body: changed ? encoder.encode(JSON.stringify(nextBody)) : body,
  };
}

function stripResponseHeaders(headers: Headers): Headers {
  const next = new Headers(headers);
  next.delete("content-encoding");
  next.delete("content-length");

  const sessionId = headers.get("session_id");
  if (sessionId) {
    next.set("x-codex-session-id", sessionId);
  }

  return next;
}

function bodyPreview(headers: Headers, body: ArrayBuffer | Uint8Array | undefined): string | null {
  if (!body) {
    return null;
  }

  const contentType = headers.get("content-type") || "";
  if (!contentType.includes("json") && !contentType.startsWith("text/")) {
    return `<${contentType || "binary"} ${body.byteLength} bytes>`;
  }

  try {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    return new TextDecoder().decode(bytes).slice(0, 4000);
  } catch {
    return `<unreadable ${body.byteLength} bytes>`;
  }
}

function headerPreview(headers: Headers): Record<string, string> {
  const preview: Record<string, string> = {};

  for (const name of [
    "accept",
    "content-encoding",
    "content-length",
    "content-type",
    "transfer-encoding",
    "user-agent",
  ]) {
    const value = headers.get(name);
    if (value) {
      preview[name] = value;
    }
  }

  return preview;
}

function eventKey(event: Record<string, any>, indexKey: "content_index" | "summary_index"): string {
  return [
    event.item_id ?? "",
    event.output_index ?? "",
    event[indexKey] ?? "",
  ].join(":");
}

function appendChunk(target: string[], chunk: string | undefined) {
  if (typeof chunk !== "string" || chunk.length === 0) return;
  target.push(chunk);
}

function ensureCaptureLogStarted(capture: StreamCapture) {
  if (capture.logStarted) return;
  capture.logStarted = true;
  thinkingLog([
    "",
    SEPARATOR,
    `[${formatTime(capture.startedAt)}] ${capture.model} | in=${capture.inputTokens ?? "?"}`,
    SEPARATOR,
    "",
  ].join("\n"));
}

function appendLiveChunk(capture: StreamCapture, kind: "reasoning" | "text", chunk: string | undefined) {
  if (typeof chunk !== "string" || chunk.length === 0) return;

  if (kind === "reasoning") {
    capture.reasoning.push(chunk);
  } else {
    capture.text.push(chunk);
  }

  ensureCaptureLogStarted(capture);

  if (kind === "reasoning" && !capture.reasoningSectionOpen) {
    capture.reasoningSectionOpen = true;
    thinkingLog("[reasoning]\n");
  }

  if (kind === "text" && !capture.textSectionOpen) {
    capture.textSectionOpen = true;
    thinkingLog(`${capture.reasoningSectionOpen ? "\n" : ""}[text]\n`);
  }

  thinkingLog(chunk);
}

function extractUsage(response: Record<string, any> | undefined): { input: number | null; output: number | null } {
  const usage = response?.usage;
  const input = typeof usage?.input_tokens === "number" ? usage.input_tokens : null;
  const output = typeof usage?.output_tokens === "number" ? usage.output_tokens : null;
  return { input, output };
}

function extractStopReason(response: Record<string, any> | undefined): string {
  return response?.stop_reason
    || response?.incomplete_details?.reason
    || response?.error?.code
    || response?.status
    || "unknown";
}

function scanItemForFallback(
  capture: StreamCapture,
  item: Record<string, any> | undefined,
  includeReasoning: boolean,
  includeText: boolean,
) {
  if (!item || typeof item !== "object") return;

  if (includeText && item.type === "message" && Array.isArray(item.content)) {
    for (const part of item.content) {
      if (part?.type === "output_text") {
        appendLiveChunk(capture, "text", part.text);
      }
      if (includeReasoning && (part?.type === "reasoning_text" || part?.type === "summary_text")) {
        appendLiveChunk(capture, "reasoning", part.text);
      }
    }
  }

  if (includeReasoning && item.type === "reasoning") {
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "reasoning_text") {
          appendLiveChunk(capture, "reasoning", part.text);
        }
      }
    }

    if (Array.isArray(item.summary)) {
      for (const part of item.summary) {
        if (part?.type === "summary_text") {
          appendLiveChunk(capture, "reasoning", part.text);
        }
      }
    }
  }
}

function flushCapture(capture: StreamCapture) {
  if (capture.flushed) return;
  capture.flushed = true;

  if (capture.logStarted) {
    thinkingLog(`\n[${formatTime()}] done | out=${capture.outputTokens ?? "?"} | stop=${capture.stopReason}\n`);
    return;
  }

  if (capture.reasoning.length === 0 && capture.text.length === 0) {
    return;
  }

  const sections: string[] = [
    "",
    SEPARATOR,
    `[${formatTime(capture.startedAt)}] ${capture.model} | in=${capture.inputTokens ?? "?"}`,
    SEPARATOR,
  ];

  if (capture.reasoning.length > 0) {
    sections.push("[reasoning]");
    sections.push(capture.reasoning.join(""));
  }

  if (capture.text.length > 0) {
    sections.push("[text]");
    sections.push(capture.text.join(""));
  }

  sections.push(`[${formatTime()}] done | out=${capture.outputTokens ?? "?"} | stop=${capture.stopReason}`);
  thinkingLog(`${sections.join("\n")}\n`);
}

function processSseEvent(event: Record<string, any>, capture: StreamCapture) {
  switch (event.type) {
    case "response.created": {
      const response = event.response as Record<string, any> | undefined;
      capture.model = typeof response?.model === "string" ? response.model : capture.model;
      const usage = extractUsage(response);
      capture.inputTokens = usage.input ?? capture.inputTokens;
      break;
    }

    case "response.content_part.added": {
      const part = event.part as Record<string, any> | undefined;
      if (part?.type === "output_text") {
        appendLiveChunk(capture, "text", part.text);
      }
      if (part?.type === "reasoning_text" || part?.type === "summary_text") {
        appendLiveChunk(capture, "reasoning", part.text);
      }
      break;
    }

    case "response.output_text.delta": {
      capture.seenTextParts.add(eventKey(event, "content_index"));
      appendLiveChunk(capture, "text", event.delta);
      break;
    }

    case "response.output_text.done": {
      const key = eventKey(event, "content_index");
      if (!capture.seenTextParts.has(key)) {
        appendLiveChunk(capture, "text", event.text);
      }
      capture.seenTextParts.add(key);
      break;
    }

    case "response.reasoning_text.delta": {
      capture.seenReasoningParts.add(eventKey(event, "content_index"));
      appendLiveChunk(capture, "reasoning", event.delta);
      break;
    }

    case "response.reasoning_text.done": {
      const key = eventKey(event, "content_index");
      if (!capture.seenReasoningParts.has(key)) {
        appendLiveChunk(capture, "reasoning", event.text);
      }
      capture.seenReasoningParts.add(key);
      break;
    }

    case "response.reasoning_summary_part.added": {
      const part = event.part as Record<string, any> | undefined;
      if (part?.type === "summary_text") {
        appendLiveChunk(capture, "reasoning", part.text);
      }
      break;
    }

    case "response.reasoning_summary_part.done": {
      const key = eventKey(event, "summary_index");
      const part = event.part as Record<string, any> | undefined;
      if (!capture.seenReasoningParts.has(key) && part?.type === "summary_text") {
        appendLiveChunk(capture, "reasoning", part.text);
      }
      capture.seenReasoningParts.add(key);
      break;
    }

    case "response.reasoning_summary_text.delta": {
      capture.seenReasoningParts.add(eventKey(event, "summary_index"));
      appendLiveChunk(capture, "reasoning", event.delta);
      break;
    }

    case "response.reasoning_summary_text.done": {
      const key = eventKey(event, "summary_index");
      if (!capture.seenReasoningParts.has(key)) {
        appendLiveChunk(capture, "reasoning", event.text);
      }
      capture.seenReasoningParts.add(key);
      break;
    }

    case "response.output_item.done": {
      if (capture.reasoning.length === 0 || capture.text.length === 0) {
        scanItemForFallback(
          capture,
          event.item as Record<string, any> | undefined,
          capture.reasoning.length === 0,
          capture.text.length === 0,
        );
      }
      break;
    }

    case "response.completed":
    case "response.incomplete":
    case "response.failed": {
      const response = event.response as Record<string, any> | undefined;
      const usage = extractUsage(response);
      capture.model = typeof response?.model === "string" ? response.model : capture.model;
      capture.inputTokens = usage.input ?? capture.inputTokens;
      capture.outputTokens = usage.output ?? capture.outputTokens;
      capture.stopReason = extractStopReason(response);

      if ((capture.reasoning.length === 0 || capture.text.length === 0) && Array.isArray(response?.output)) {
        for (const item of response.output) {
          scanItemForFallback(
            capture,
            item,
            capture.reasoning.length === 0,
            capture.text.length === 0,
          );
        }
      }

      flushCapture(capture);
      break;
    }
  }
}

function parseSseBlock(block: string, capture: StreamCapture) {
  const lines = block.split("\n");
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return;

  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return;

  try {
    const event = JSON.parse(payload) as Record<string, any>;
    rawEventLog(event, capture);
    apiJsonLog({
      phase: "response.sse_event",
      requestId: capture.requestId,
      path: capture.path,
      sessionId: capture.sessionId,
      model: capture.model,
      type: typeof event.type === "string" ? event.type : "unknown",
      event,
    });
    processSseEvent(event, capture);
  } catch {
    // Ignore malformed SSE events and keep the relay transparent.
  }
}

function interceptStream(
  body: ReadableStream<Uint8Array>,
  requestModel: string,
  context: { requestId?: string; path?: string; sessionId?: string | null } = {},
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const capture: StreamCapture = {
    requestId: context.requestId || "-",
    path: context.path || "-",
    sessionId: context.sessionId || null,
    startedAt: Date.now(),
    model: requestModel === "-" ? "unknown" : requestModel,
    inputTokens: null,
    outputTokens: null,
    stopReason: "stream_closed",
    reasoning: [],
    text: [],
    seenTextParts: new Set(),
    seenReasoningParts: new Set(),
    logStarted: false,
    reasoningSectionOpen: false,
    textSectionOpen: false,
    flushed: false,
  };

  let buffer = "";

  return new ReadableStream({
    async start(controller) {
      const reader = body.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          controller.enqueue(value);
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            parseSseBlock(block, capture);
            boundary = buffer.indexOf("\n\n");
          }
        }

        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
          parseSseBlock(buffer, capture);
        }
      } finally {
        flushCapture(capture);
        controller.close();
      }
    },
  });
}

function appendString(target: string[], value: unknown) {
  if (typeof value === "string" && value.length > 0) {
    target.push(value);
  }
}

function entryRequestId(entry: Record<string, any>): string {
  return typeof entry.requestId === "string" && entry.requestId.length > 0 ? entry.requestId : "unknown";
}

function itemKey(event: Record<string, any>, item?: Record<string, any>): string {
  const itemId = item?.id || event.item_id;
  if (typeof itemId === "string" && itemId.length > 0) return itemId;
  return `output:${event.output_index ?? "unknown"}`;
}

function toolCallFor(
  toolCalls: Map<string, Record<string, any>>,
  key: string,
  entry: Record<string, any>,
  defaults: Record<string, any> = {},
): Record<string, any> {
  let call = toolCalls.get(key);
  if (!call) {
    call = {
      id: key,
      firstAt: entry.at ?? null,
      lastAt: entry.at ?? null,
      requestId: entryRequestId(entry),
      type: defaults.type || "tool_call",
      name: defaults.name || null,
      callId: defaults.callId || null,
      status: defaults.status || null,
      arguments: "",
      input: "",
      eventTypes: [],
      argumentChunks: [],
      inputChunks: [],
    };
    toolCalls.set(key, call);
  }

  call.lastAt = entry.at ?? call.lastAt;
  for (const [field, value] of Object.entries(defaults)) {
    if (value !== undefined && value !== null && value !== "") {
      call[field] = value;
    }
  }

  return call;
}

function recordToolItem(toolCalls: Map<string, Record<string, any>>, entry: Record<string, any>, event: Record<string, any>) {
  const item = event.item as Record<string, any> | undefined;
  if (!item?.type || item.type === "message" || item.type === "reasoning") return;

  const call = toolCallFor(toolCalls, itemKey(event, item), entry, {
    type: item.type,
    name: item.name,
    callId: item.call_id,
    status: item.status,
  });

  call.eventTypes.push(event.type);

  if (typeof item.arguments === "string" && item.arguments.length > 0) {
    call.arguments = item.arguments;
  }

  if (typeof item.input === "string" && item.input.length > 0) {
    call.input = item.input;
  }
}

function compactToolCall(call: Record<string, any>): Record<string, any> {
  const argumentChunks = Array.isArray(call.argumentChunks) ? call.argumentChunks : [];
  const inputChunks = Array.isArray(call.inputChunks) ? call.inputChunks : [];
  const eventTypes = Array.isArray(call.eventTypes) ? call.eventTypes : [];

  return {
    id: call.id,
    firstAt: call.firstAt,
    lastAt: call.lastAt,
    requestId: call.requestId,
    type: call.type,
    name: call.name,
    callId: call.callId,
    status: call.status,
    arguments: typeof call.arguments === "string" && call.arguments.length > 0
      ? call.arguments
      : argumentChunks.join(""),
    input: typeof call.input === "string" && call.input.length > 0
      ? call.input
      : inputChunks.join(""),
    eventTypes,
  };
}

function collectOutputTextFromItem(item: Record<string, any> | undefined): string[] {
  const chunks: string[] = [];
  if (!item || item.type !== "message" || !Array.isArray(item.content)) return chunks;

  for (const part of item.content) {
    if (part?.type === "output_text") {
      appendString(chunks, part.text);
    }
  }

  return chunks;
}

function collectReasoningFromItem(item: Record<string, any> | undefined): string[] {
  const chunks: string[] = [];
  if (!item || item.type !== "reasoning") return chunks;

  if (Array.isArray(item.content)) {
    for (const part of item.content) {
      if (part?.type === "reasoning_text") {
        appendString(chunks, part.text);
      }
    }
  }

  if (Array.isArray(item.summary)) {
    for (const part of item.summary) {
      if (part?.type === "summary_text") {
        appendString(chunks, part.text);
      }
    }
  }

  return chunks;
}

function buildFlatTranscript(events: Record<string, any>[]) {
  const assistantChunks: string[] = [];
  const reasoningChunks: string[] = [];
  const responseSnapshots: Record<string, any>[] = [];
  const toolCalls = new Map<string, Record<string, any>>();
  const toolEvents: Record<string, any>[] = [];
  const eventTypes: Record<string, number> = {};
  const seenAssistantKeys = new Set<string>();
  const seenReasoningKeys = new Set<string>();

  for (const entry of events) {
    const event = entry.event as Record<string, any> | undefined;
    if (!event || typeof event !== "object") continue;

    const type = typeof event.type === "string" ? event.type : "unknown";
    eventTypes[type] = (eventTypes[type] || 0) + 1;

    switch (type) {
      case "response.content_part.added": {
        const part = event.part as Record<string, any> | undefined;
        if (part?.type === "output_text") {
          appendString(assistantChunks, part.text);
        }
        if (part?.type === "reasoning_text" || part?.type === "summary_text") {
          appendString(reasoningChunks, part.text);
        }
        break;
      }
      case "response.content_part.done": {
        const key = eventKey(event, "content_index");
        const part = event.part as Record<string, any> | undefined;
        if (!seenAssistantKeys.has(key) && part?.type === "output_text") {
          appendString(assistantChunks, part.text);
        }
        if (!seenReasoningKeys.has(key) && (part?.type === "reasoning_text" || part?.type === "summary_text")) {
          appendString(reasoningChunks, part.text);
        }
        seenAssistantKeys.add(key);
        seenReasoningKeys.add(key);
        break;
      }
      case "response.output_text.delta":
        seenAssistantKeys.add(eventKey(event, "content_index"));
        appendString(assistantChunks, event.delta);
        break;
      case "response.output_text.done": {
        const key = eventKey(event, "content_index");
        if (!seenAssistantKeys.has(key)) {
          appendString(assistantChunks, event.text);
        }
        seenAssistantKeys.add(key);
        break;
      }
      case "response.reasoning_text.delta":
        seenReasoningKeys.add(eventKey(event, "content_index"));
        appendString(reasoningChunks, event.delta);
        break;
      case "response.reasoning_text.done": {
        const key = eventKey(event, "content_index");
        if (!seenReasoningKeys.has(key)) {
          appendString(reasoningChunks, event.text);
        }
        seenReasoningKeys.add(key);
        break;
      }
      case "response.reasoning_summary_text.delta":
        seenReasoningKeys.add(eventKey(event, "summary_index"));
        appendString(reasoningChunks, event.delta);
        break;
      case "response.reasoning_summary_text.done": {
        const key = eventKey(event, "summary_index");
        if (!seenReasoningKeys.has(key)) {
          appendString(reasoningChunks, event.text);
        }
        seenReasoningKeys.add(key);
        break;
      }
      case "response.reasoning_summary_part.added":
      case "response.reasoning_summary_part.done": {
        const key = eventKey(event, "summary_index");
        const part = event.part as Record<string, any> | undefined;
        if (!seenReasoningKeys.has(key) && part?.type === "summary_text") {
          appendString(reasoningChunks, part.text);
        }
        seenReasoningKeys.add(key);
        break;
      }
      case "response.output_item.added":
      case "response.output_item.done": {
        const item = event.item as Record<string, any> | undefined;
        if (item?.type && item.type !== "message" && item.type !== "reasoning") {
          toolEvents.push({ at: entry.at, requestId: entry.requestId, type, item });
        }
        recordToolItem(toolCalls, entry, event);
        break;
      }
      case "response.function_call_arguments.delta": {
        const call = toolCallFor(toolCalls, itemKey(event), entry, { type: "function_call" });
        call.eventTypes.push(type);
        appendString(call.argumentChunks, event.delta);
        break;
      }
      case "response.function_call_arguments.done": {
        const call = toolCallFor(toolCalls, itemKey(event), entry, { type: "function_call" });
        call.eventTypes.push(type);
        if (typeof event.arguments === "string") {
          call.arguments = event.arguments;
        }
        break;
      }
      case "response.custom_tool_call_input.delta": {
        const call = toolCallFor(toolCalls, itemKey(event), entry, { type: "custom_tool_call" });
        call.eventTypes.push(type);
        appendString(call.inputChunks, event.delta);
        break;
      }
      case "response.custom_tool_call_input.done": {
        const call = toolCallFor(toolCalls, itemKey(event), entry, { type: "custom_tool_call" });
        call.eventTypes.push(type);
        if (typeof event.input === "string") {
          call.input = event.input;
        }
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        const response = event.response as Record<string, any> | undefined;
        if (!response) break;

        const snapshot: Record<string, any> = {
          at: entry.at,
          requestId: entry.requestId,
          status: response.status,
          model: response.model,
          usage: response.usage,
          assistantText: [],
          reasoningText: [],
          tools: [],
        };

        if (Array.isArray(response.output)) {
          for (const item of response.output) {
            snapshot.assistantText.push(...collectOutputTextFromItem(item));
            snapshot.reasoningText.push(...collectReasoningFromItem(item));
            if (item?.type && item.type !== "message" && item.type !== "reasoning") {
              snapshot.tools.push(item);
            }
          }
        }

        responseSnapshots.push(snapshot);
        break;
      }
    }

    if (type.includes("tool") || type.includes("function_call") || type.includes("mcp")) {
      toolEvents.push({ at: entry.at, requestId: entry.requestId, type, event });
    }
  }

  const assistantText = assistantChunks.join("");
  const reasoningText = reasoningChunks.join("");

  return {
    channels: {
      commentary: assistantText,
      analysis: reasoningText,
    },
    assistantText,
    reasoningText,
    toolCalls: [...toolCalls.values()].map(compactToolCall),
    toolEvents,
    responseSnapshots,
    eventTypes,
  };
}

function buildTranscript(events: Record<string, any>[]) {
  const grouped = new Map<string, Record<string, any>[]>();

  for (const event of events) {
    const requestId = entryRequestId(event);
    const requestEvents = grouped.get(requestId) || [];
    requestEvents.push(event);
    grouped.set(requestId, requestEvents);
  }

  return {
    ...buildFlatTranscript(events),
    requests: [...grouped.entries()].map(([requestId, requestEvents]) => ({
      requestId,
      firstAt: requestEvents[0]?.at ?? null,
      lastAt: requestEvents[requestEvents.length - 1]?.at ?? null,
      eventCount: requestEvents.length,
      ...buildFlatTranscript(requestEvents),
    })),
  };
}

app.get("/health", async (c) => {
  try {
    const auth = await getStoredAuthInfo();
    return c.json({
      status: "ok",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      upstream: `${UPSTREAM_ORIGIN}${UPSTREAM_BASE_PATH}`,
      auth: {
        path: getAuthPath(),
        mode: auth.authMode,
        accountId: auth.accountId,
        organizationId: auth.organizationId,
        scopes: auth.scopes,
        expiresAt: auth.expiresAt || null,
        expiresIn: auth.expiresAt ? Math.floor((auth.expiresAt - Date.now()) / 1000) : null,
      },
      thinkingLog: THINKING_LOG_PATH,
      rawEventLog: {
        enabled: RAW_EVENT_LOG_ENABLED,
        path: RAW_EVENT_LOG_PATH,
      },
      requestLog: {
        enabled: REQUEST_LOG_ENABLED,
        path: REQUEST_LOG_PATH,
      },
      apiJsonLog: {
        enabled: API_JSON_LOG_ENABLED,
        path: API_JSON_LOG_PATH,
      },
      stats,
    });
  } catch (error) {
    return c.json({
      status: "degraded",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      upstream: `${UPSTREAM_ORIGIN}${UPSTREAM_BASE_PATH}`,
      auth: {
        path: getAuthPath(),
        error: error instanceof Error ? error.message : String(error),
      },
      thinkingLog: THINKING_LOG_PATH,
      rawEventLog: {
        enabled: RAW_EVENT_LOG_ENABLED,
        path: RAW_EVENT_LOG_PATH,
      },
      requestLog: {
        enabled: REQUEST_LOG_ENABLED,
        path: REQUEST_LOG_PATH,
      },
      apiJsonLog: {
        enabled: API_JSON_LOG_ENABLED,
        path: API_JSON_LOG_PATH,
      },
      stats,
    }, 503);
  }
});

app.get("/debug/events", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 100, 50_000);
  const events = readNdjsonTail(RAW_EVENT_LOG_PATH, limit);
  const filters = {
    requestId: c.req.query("requestId"),
    sessionId: c.req.query("sessionId"),
    type: c.req.query("type"),
  };
  const filteredEvents = filterLogEntries(events, filters);

  return c.json({
    enabled: RAW_EVENT_LOG_ENABLED,
    path: RAW_EVENT_LOG_PATH,
    filters,
    count: filteredEvents.length,
    eventsRead: events.length,
    events: filteredEvents,
  });
});

app.get("/debug/requests", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 100, 50_000);
  const requests = readNdjsonTail(REQUEST_LOG_PATH, limit);

  return c.json({
    enabled: REQUEST_LOG_ENABLED,
    path: REQUEST_LOG_PATH,
    count: requests.length,
    requests,
  });
});

app.get("/debug/transcript", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 50_000);
  const events = readNdjsonTail(RAW_EVENT_LOG_PATH, limit);
  const filters = {
    requestId: c.req.query("requestId"),
    sessionId: c.req.query("sessionId"),
    type: c.req.query("type"),
  };
  const filteredEvents = filterLogEntries(events, filters);

  return c.json({
    rawEventLog: {
      enabled: RAW_EVENT_LOG_ENABLED,
      path: RAW_EVENT_LOG_PATH,
      eventsRead: events.length,
      eventsUsed: filteredEvents.length,
      filters,
    },
    ...buildTranscript(filteredEvents),
  });
});

app.get("/debug/api-json", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 100, 50_000);
  const records = readNdjsonTail(API_JSON_LOG_PATH, limit);

  return c.json({
    enabled: API_JSON_LOG_ENABLED,
    path: API_JSON_LOG_PATH,
    count: records.length,
    records,
  });
});

app.all("*", async (c) => {
  stats.totalRequests += 1;
  stats.activeRequests += 1;
  stats.lastRequestAt = Date.now();
  const requestId = `${Date.now().toString(36)}-${stats.totalRequests.toString(36)}`;
  const sourceUrl = new URL(c.req.url);

  if (isWebSocketUpgrade(c.req.raw.headers)) {
    stats.activeRequests -= 1;
    console.log(`[proxy] ${c.req.method} ${c.req.path} websocket=unsupported`);
    return new Response("WebSocket transport is not supported by codex-proxy. Falling back to HTTP is expected.", {
      status: 426,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "connection": "close",
      },
    });
  }

  const rawBody = hasBody(c.req.method) ? await c.req.raw.arrayBuffer() : undefined;
  const requestBody = decodeRequestBody(c.req.raw.headers, rawBody);
  apiJsonLog({
    phase: "request.received",
    requestId,
    method: c.req.method,
    path: sourceUrl.pathname,
    search: sourceUrl.search,
    headers: headersForLog(c.req.raw.headers),
    body: bodyForLog(c.req.raw.headers, requestBody),
  });
  const prepared = prepareRequest(c.req.url, c.req.raw.headers, requestBody);
  requestLog(requestId, c.req.method, c.req.url, c.req.raw.headers, prepared);

  console.log(
    `[proxy] ${c.req.method} ${c.req.path} model=${prepared.summary.model} stream=${prepared.summary.stream} session=${prepared.sessionId || "-"}`,
  );

  try {
    const auth = await getAuthState();
    const headers = buildHeaders(
      c.req.raw.headers,
      auth.accessToken,
      auth.accountId,
      prepared.sessionId,
      auth.authMode,
    );
    const upstreamUrl = buildUpstreamUrl(c.req.url, prepared.sessionId);
    const upstreamParsedUrl = new URL(upstreamUrl);
    apiJsonLog({
      phase: "request.forwarded",
      requestId,
      method: c.req.method,
      path: sourceUrl.pathname,
      upstreamPath: upstreamParsedUrl.pathname,
      upstreamSearch: upstreamParsedUrl.search,
      model: prepared.summary.model,
      stream: prepared.summary.stream,
      sessionId: prepared.sessionId,
      headers: headersForLog(headers),
      body: bodyForLog(c.req.raw.headers, prepared.body),
    });
    const init: RequestInit & { duplex?: "half" } = {
      method: c.req.method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };

    if (prepared.body) {
      init.body = prepared.body;
      init.duplex = "half";
    }

    const upstream = await fetch(upstreamUrl, init);
    const responseHeaders = stripResponseHeaders(upstream.headers);
    const isSse = prepared.summary.stream
      || responseHeaders.get("content-type")?.includes("text/event-stream")
      || false;

    apiJsonLog({
      phase: "response.headers",
      requestId,
      path: sourceUrl.pathname,
      upstreamPath: upstreamParsedUrl.pathname,
      model: prepared.summary.model,
      stream: isSse,
      sessionId: prepared.sessionId,
      status: upstream.status,
      statusText: upstream.statusText,
      headers: headersForLog(responseHeaders),
    });

    if (!isSse && upstream.body) {
      const contentType = responseHeaders.get("content-type") || "";
      if (contentType.includes("json") || contentType.startsWith("text/")) {
        try {
          const responseBody = await upstream.clone().arrayBuffer();
          apiJsonLog({
            phase: "response.body",
            requestId,
            path: sourceUrl.pathname,
            upstreamPath: upstreamParsedUrl.pathname,
            model: prepared.summary.model,
            sessionId: prepared.sessionId,
            status: upstream.status,
            body: bodyForLog(responseHeaders, responseBody),
          });
        } catch (error) {
          apiJsonLog({
            phase: "response.body_error",
            requestId,
            path: sourceUrl.pathname,
            upstreamPath: upstreamParsedUrl.pathname,
            model: prepared.summary.model,
            sessionId: prepared.sessionId,
            status: upstream.status,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (!upstream.ok) {
      const preview = await upstream.clone().text();
      console.error(`[proxy] upstream ${upstream.status} ${upstreamUrl}: ${preview.slice(0, 400)}`);
      if (DEBUG_REQUESTS) {
        console.error(`[proxy] request headers ${JSON.stringify(headerPreview(c.req.raw.headers))}`);
        const requestPreview = bodyPreview(c.req.raw.headers, prepared.body);
        if (requestPreview) {
          console.error(`[proxy] request preview ${requestPreview}`);
        }
      }
    }

    if (DEBUG_REQUESTS && isSse) {
      thinkingLog(`[debug ${formatTime()}] stream detected model=${prepared.summary.model}\n`);
    }

    return new Response(
      isSse && upstream.body
        ? interceptStream(upstream.body, prepared.summary.model, {
          requestId,
          path: c.req.path,
          sessionId: prepared.sessionId,
        })
        : upstream.body,
      {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[proxy] ${c.req.method} ${c.req.path} failed: ${message}`);
    return c.json({ error: "proxy_error", message }, 502);
  } finally {
    stats.activeRequests -= 1;
  }
});

export function startServer(options: { port: number; host: string }) {
  const server = Bun.serve({
    port: options.port,
    hostname: options.host,
    idleTimeout: 255,
    fetch: app.fetch,
  });

  console.log(`[proxy] listening on http://${options.host}:${server.port}`);
  return server;
}

export const __test = {
  buildTranscript,
  buildUpstreamUrl,
  interceptStream,
  normalizeReasoningSummary,
  normalizeUpstreamPath,
  prepareRequest,
  stripResponseHeaders,
};
