import { appendFileSync, existsSync, readFileSync } from "fs";
import { Hono } from "hono";
import { brotliDecompressSync, gunzipSync, inflateSync } from "zlib";
import { ApiKeyResolution, getApiKeyFilePath, getAuthFileMode, getAuthPath, getAuthState, getStoredAuthInfo, invalidateAndRefresh, isApiKeyEnvSet, resolveApiKey } from "./auth";
import {
  Channel,
  Tier,
  channelForEventType,
  extractTextFromInputItem,
  hashContent,
  parsePermissionsBlock,
  tierForInputItem,
} from "./harmony";
import { CaptureSnapshot, Hooks, loadHooks } from "./hooks";
import {
  ProfileConfig,
  ProfileError,
  IdentifiedProfile,
  RateLimitState,
  applyProfileGates,
  checkRateLimit,
  identifyProfile,
  loadProfilesConfig,
  shouldDropChannel,
  summarizeProfile,
} from "./profiles";
import {
  InjectionMatch,
  detectInjections,
  highestSeverity,
} from "./injection-detector";
import { decodeFernet } from "./fernet-decode";
import { detectRefusal, divergenceVerdict } from "./refusal-detector";

const UPSTREAM_ORIGIN = process.env.CODEX_PROXY_UPSTREAM_ORIGIN || "https://chatgpt.com";
const UPSTREAM_BASE_PATH = process.env.CODEX_PROXY_UPSTREAM_BASE_PATH || "/backend-api/codex";
const OPENAI_UPSTREAM_ORIGIN = process.env.CODEX_PROXY_OPENAI_UPSTREAM_ORIGIN || "https://api.openai.com";
const OPENAI_UPSTREAM_BASE_PATH = process.env.CODEX_PROXY_OPENAI_UPSTREAM_BASE_PATH || "/v1";
const OPENAI_ROUTE_PREFIX = "/openai";
const UPSTREAM_MODE_HEADER = "x-codex-proxy-upstream";
const UPSTREAM_MODE_QUERY = "codex_proxy_upstream";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const BROWSER_USER_AGENT = process.env.CODEX_PROXY_USER_AGENT
  || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

// Match the official Codex client identity. Real Codex CLI (Rust) sends
// `originator: codex_cli_rs`; Codex Desktop sends `originator: Codex Desktop`.
// We default to the CLI value but allow override via env. Empirical 2026-04-30
// recon confirmed connector endpoints (and likely the safety classifier on
// /responses) gate on these headers.
const ORIGINATOR = process.env.CODEX_PROXY_ORIGINATOR || "codex_cli_rs";
const OAI_PRODUCT_SKU = process.env.CODEX_PROXY_OAI_PRODUCT_SKU || "";  // empty = don't send
const DEFAULT_INSTRUCTIONS = process.env.CODEX_PROXY_DEFAULT_INSTRUCTIONS
  || "You are Codex, OpenAI's coding agent running in a terminal. Work directly, write clearly, and stay focused on the task.";
const DEFAULT_REASONING_SUMMARY = process.env.CODEX_PROXY_REASONING_SUMMARY || "detailed";
const FORCE_REASONING_SUMMARY = process.env.CODEX_PROXY_FORCE_REASONING_SUMMARY !== "false";
// Default effort when client sends `reasoning` without an `effort` field.
// chatgpt-backend tolerates absent effort (uses a server-side default), but OpenAI direct
// (via OpenRouter) rejects with "Reasoning is mandatory" on gpt-5.1-codex-* models.
// We inject this to keep both upstreams happy. Set "" to disable injection.
const DEFAULT_REASONING_EFFORT = process.env.CODEX_PROXY_DEFAULT_REASONING_EFFORT ?? "medium";
const THINKING_LOG_PATH = process.env.CODEX_PROXY_THINKING_LOG_FILE || "/tmp/codex-proxy-thinking.log";
const RAW_EVENT_LOG_PATH = process.env.CODEX_PROXY_RAW_EVENT_LOG_FILE || "/tmp/codex-proxy-events.ndjson";
const RAW_EVENT_LOG_ENABLED = process.env.CODEX_PROXY_RAW_EVENT_LOG !== "false";
const REQUEST_LOG_PATH = process.env.CODEX_PROXY_REQUEST_LOG_FILE || "/tmp/codex-proxy-requests.ndjson";
const REQUEST_LOG_ENABLED = process.env.CODEX_PROXY_REQUEST_LOG !== "false";
const API_JSON_LOG_PATH = process.env.CODEX_PROXY_API_JSON_LOG_FILE || "/tmp/codex-proxy-api-json.ndjson";
const API_JSON_LOG_ENABLED = process.env.CODEX_PROXY_API_JSON_LOG !== "false";
const HARMONY_LOG_PATH = process.env.CODEX_PROXY_HARMONY_LOG_FILE || "/tmp/codex-proxy-harmony.ndjson";
const HARMONY_LOG_ENABLED = process.env.CODEX_PROXY_HARMONY_LOG !== "false";
const HARMONY_CONTENT_MODE = (process.env.CODEX_PROXY_HARMONY_CONTENT || "head").toLowerCase();
const HARMONY_CONTENT_HEAD_LIMIT = Number.parseInt(process.env.CODEX_PROXY_HARMONY_CONTENT_HEAD || "256", 10) || 256;
const PROFILES_FILE = process.env.CODEX_PROXY_PROFILES_FILE || null;
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
  harmonyEventsLogged: 0,
};

let hooks: Hooks = {};
let profilesConfig: ProfileConfig | null = null;
const rateLimitStore = new Map<string, RateLimitState>();
const requestProfileMap = new Map<string, IdentifiedProfile>();

interface RequestSummary {
  model: string;
  stream: boolean;
}

interface PreparedRequest {
  summary: RequestSummary;
  body: ArrayBuffer | Uint8Array | undefined;
  sessionId: string | null;
  parsedBody: Record<string, any> | null;
}

type UpstreamMode = "codex" | "openai";

interface CommentaryFnCall {
  itemId: string;
  name: string | null;
  args: string;
}

interface CommentaryCustomCall {
  itemId: string;
  name: string | null;
  input: string;
}

export interface CaptureErrorRecord {
  source: "sse_error_event" | "response_failed";
  code: string | null;
  message: string | null;
  type: string | null;
  param: string | null;
  raw: Record<string, any>;
  at: string;
}

export interface ResponseEnvelope {
  serviceTier: string | null;
  safetyIdentifier: string | null;
  promptCacheRetention: string | number | null;
  previousResponseId: string | null;
  store: boolean | null;
  truncation: string | null;
  parallelToolCalls: boolean | null;
  toolChoice: string | Record<string, any> | null;
  toolUsage: Record<string, any> | null;
  moderation: Record<string, any> | null;
  reasoningEffort: string | null;
  reasoningSummary: string | null;
  textVerbosity: string | null;
  textFormatType: string | null;
  // Chat-completions-only signal: OpenRouter sends `provider` in each chunk
  // indicating which underlying upstream served the request (e.g. "OpenAI").
  openrouterProvider: string | null;
  // Derived at flush time. Classifies how reasoning was emitted:
  //   "cleartext_only"  — only summary deltas, no encrypted blob
  //   "encrypted_only"  — only Fernet blob, no summary deltas (server kept CoT private)
  //   "both"            — both formats present (most common; ~78% of chat-completions traffic)
  //   "none"            — model emitted no reasoning at all
  reasoningMode: "cleartext_only" | "encrypted_only" | "both" | "none" | null;
}

interface ChannelCapture {
  requestId: string;
  path: string;
  sessionId: string | null;
  startedAt: number;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: string;
  channels: {
    final: string[];
    analysis: string[];
    commentary: {
      fn: Map<string, CommentaryFnCall>;
      custom: Map<string, CommentaryCustomCall>;
    };
  };
  inputTiers: Partial<Record<Tier, { messages: number; bytes: number }>>;
  metadata: Record<string, any>;
  responseId: string | null;
  encryptedReasoningSizes: number[];
  errors: CaptureErrorRecord[];
  envelope: ResponseEnvelope;
  envelopeEmitted: boolean;
  profile: IdentifiedProfile | null;
  seenTextParts: Set<string>;
  seenReasoningParts: Set<string>;
  logStarted: boolean;
  reasoningSectionOpen: boolean;
  textSectionOpen: boolean;
  flushed: boolean;
}

function emptyEnvelope(): ResponseEnvelope {
  return {
    serviceTier: null,
    safetyIdentifier: null,
    promptCacheRetention: null,
    previousResponseId: null,
    store: null,
    truncation: null,
    parallelToolCalls: null,
    toolChoice: null,
    toolUsage: null,
    moderation: null,
    reasoningEffort: null,
    reasoningSummary: null,
    textVerbosity: null,
    textFormatType: null,
    openrouterProvider: null,
    reasoningMode: null,
  };
}

function thinkingLog(text: string) {
  try {
    appendFileSync(THINKING_LOG_PATH, text, "utf8");
  } catch (error) {
    console.error(`[proxy] failed to write thinking log: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function rawEventLog(event: Record<string, any>, capture: ChannelCapture) {
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

function shapeHarmonyContent(content: string | undefined): { content?: string; contentHead?: string; contentLen?: number } {
  if (typeof content !== "string" || content.length === 0) return {};
  const contentLen = content.length;

  if (HARMONY_CONTENT_MODE === "none" || HARMONY_CONTENT_MODE === "hash") {
    return { contentLen };
  }
  if (HARMONY_CONTENT_MODE === "full") {
    return { content, contentLen };
  }
  // default "head"
  return {
    contentHead: content.length > HARMONY_CONTENT_HEAD_LIMIT ? content.slice(0, HARMONY_CONTENT_HEAD_LIMIT) : content,
    contentLen,
  };
}

function harmonyEventLog(record: Record<string, any>) {
  if (!HARMONY_LOG_ENABLED) return;

  appendJsonLine(HARMONY_LOG_PATH, {
    at: new Date().toISOString(),
    ...record,
  }, "harmony log");
  stats.harmonyEventsLogged += 1;
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

// Drop-list — high-noise / sensitive / non-informative headers we don't surface.
// Everything else is captured. Cookies and auth are stripped to avoid log leakage.
// Headers below are dropped because they leak secrets, browser-policy boilerplate, or transport noise.
// We intentionally KEEP cf-ray, cf-cache-status, vary, server, date, alt-svc — they carry signal
// (incident correlation, cache key variance, backend fingerprint, clock-skew, transport hints).
const HEADER_DROPLIST = new Set<string>([
  "set-cookie", "cookie",
  "authorization", "x-api-key", "api-key",
  "report-to", "nel",            // Cloudflare browser reporting
  "strict-transport-security",
  "access-control-allow-credentials",
  "access-control-allow-origin",
  "cross-origin-opener-policy",
  "x-content-type-options",
  "referrer-policy",
  "connection",
]);

function headersForLog(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (HEADER_DROPLIST.has(k)) return;
    out[k] = value.length > 500 ? value.slice(0, 500) + "...[truncated]" : value;
  });
  return out;
}

export interface RateLimitSnapshot {
  activeLimit: string | null;       // "premium"
  planType: string | null;          // "plus"
  primary: { usedPercent: number | null; windowMinutes: number | null; resetAfterSeconds: number | null; resetAt: number | null };
  secondary: { usedPercent: number | null; windowMinutes: number | null; resetAfterSeconds: number | null; resetAt: number | null };
  primaryOverSecondaryLimitPercent: number | null;
  hasCredits: boolean | null;
  unlimited: boolean | null;
  oaiRequestId: string | null;
  modelsEtag: string | null;
}

function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot | null {
  const num = (k: string) => {
    const v = headers.get(k);
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const bool = (k: string) => {
    const v = headers.get(k);
    if (v === null || v === undefined) return null;
    return /^true$/i.test(v) ? true : /^false$/i.test(v) ? false : null;
  };

  const activeLimit = headers.get("x-codex-active-limit");
  const planType = headers.get("x-codex-plan-type");
  // Only emit a snapshot if we got at least one x-codex-* signal.
  if (!activeLimit && !planType && headers.get("x-codex-primary-used-percent") === null) {
    return null;
  }
  return {
    activeLimit,
    planType,
    primary: {
      usedPercent: num("x-codex-primary-used-percent"),
      windowMinutes: num("x-codex-primary-window-minutes"),
      resetAfterSeconds: num("x-codex-primary-reset-after-seconds"),
      resetAt: num("x-codex-primary-reset-at"),
    },
    secondary: {
      usedPercent: num("x-codex-secondary-used-percent"),
      windowMinutes: num("x-codex-secondary-window-minutes"),
      resetAfterSeconds: num("x-codex-secondary-reset-after-seconds"),
      resetAt: num("x-codex-secondary-reset-at"),
    },
    primaryOverSecondaryLimitPercent: num("x-codex-primary-over-secondary-limit-percent"),
    hasCredits: bool("x-codex-credits-has-credits"),
    unlimited: bool("x-codex-credits-unlimited"),
    oaiRequestId: headers.get("x-oai-request-id"),
    modelsEtag: headers.get("x-models-etag"),
  };
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

function normalizeOpenAIPath(pathname: string): string {
  let strippedPath = collapseRepeatedOpenAIBasePath(stripOpenAIRoutePrefix(pathname));

  // Codex CLI in apikey mode sometimes still sends to /backend-api/codex/responses
  // (the chatgpt-shape path) even when OPENAI_BASE_URL points at our proxy. When we
  // route to api.openai.com, that path needs to be rewritten to the OpenAI shape:
  //   /backend-api/codex/responses → /v1/responses
  //   /backend-api/codex/responses/compact → /v1/responses/compact (note: API may not support compact)
  if (strippedPath.startsWith(`${UPSTREAM_BASE_PATH}/`)) {
    strippedPath = strippedPath.slice(UPSTREAM_BASE_PATH.length);  // strip "/backend-api/codex" → leaves "/responses…"
  } else if (strippedPath === UPSTREAM_BASE_PATH) {
    strippedPath = "/";
  }

  if (strippedPath.startsWith(`${OPENAI_UPSTREAM_BASE_PATH}/`) || strippedPath === OPENAI_UPSTREAM_BASE_PATH) {
    return strippedPath;
  }

  if (strippedPath === "/") {
    return OPENAI_UPSTREAM_BASE_PATH;
  }

  return `${OPENAI_UPSTREAM_BASE_PATH}${strippedPath.startsWith("/") ? strippedPath : `/${strippedPath}`}`;
}

function collapseRepeatedOpenAIBasePath(pathname: string): string {
  const basePath = OPENAI_UPSTREAM_BASE_PATH.endsWith("/") && OPENAI_UPSTREAM_BASE_PATH.length > 1
    ? OPENAI_UPSTREAM_BASE_PATH.slice(0, -1)
    : OPENAI_UPSTREAM_BASE_PATH;

  if (basePath === "/") return pathname;

  let current = pathname;
  const doubled = `${basePath}${basePath}`;
  while (current === doubled || current.startsWith(`${doubled}/`)) {
    current = `${basePath}${current.slice(doubled.length)}`;
  }

  return current;
}

function stripOpenAIRoutePrefix(pathname: string): string {
  if (pathname === OPENAI_ROUTE_PREFIX) {
    return "/";
  }

  if (pathname.startsWith(`${OPENAI_ROUTE_PREFIX}/`)) {
    return pathname.slice(OPENAI_ROUTE_PREFIX.length);
  }

  return pathname;
}

// Read the global default auth mode from env, once at module load.
const ENV_AUTH_MODE: "oauth" | "api_key" | null = (() => {
  const v = (process.env.CODEX_PROXY_AUTH_MODE || "").toLowerCase();
  return v === "api_key" ? "api_key" : v === "oauth" ? "oauth" : null;
})();

function resolveAuthMode(profile: IdentifiedProfile | null): "oauth" | "api_key" {
  // Priority:
  //   1. Explicit profile.authMode
  //   2. CODEX_PROXY_AUTH_MODE env var
  //   3. ~/.codex/auth.json auth_mode field (so `codex login --api-key` JUST WORKS without
  //      operator config — proxy follows whatever Codex CLI itself wrote to its own config)
  //   4. Default "oauth"
  if (profile?.def.authMode === "api_key" || profile?.def.authMode === "oauth") return profile.def.authMode;
  if (ENV_AUTH_MODE) return ENV_AUTH_MODE;
  const fileMode = getAuthFileMode();
  if (fileMode) return fileMode;
  return "oauth";
}

function upstreamModeForRequest(url: URL, headers: Headers, profile: IdentifiedProfile | null = null): UpstreamMode {
  if (url.pathname === OPENAI_ROUTE_PREFIX || url.pathname.startsWith(`${OPENAI_ROUTE_PREFIX}/`)) {
    return "openai";
  }

  // Profile-driven routing: an api_key profile forces OpenAI upstream regardless of path.
  if (resolveAuthMode(profile) === "api_key") {
    return "openai";
  }

  const raw = readString(headers.get(UPSTREAM_MODE_HEADER))
    || readString(url.searchParams.get(UPSTREAM_MODE_QUERY));
  return raw?.toLowerCase() === "openai" ? "openai" : "codex";
}

function buildUpstreamUrl(requestUrl: string, sessionId: string | null): string {
  const sourceUrl = new URL(requestUrl);
  const upstreamUrl = new URL(UPSTREAM_ORIGIN);
  const pathname = normalizeUpstreamPath(sourceUrl.pathname);

  sourceUrl.searchParams.delete("session_id");
  sourceUrl.searchParams.delete(UPSTREAM_MODE_QUERY);

  upstreamUrl.pathname = pathname;
  const search = sourceUrl.searchParams.toString();
  upstreamUrl.search = search ? `?${search}` : "";
  return upstreamUrl.toString();
}

function buildOpenAIUpstreamUrl(requestUrl: string): string {
  const sourceUrl = new URL(requestUrl);
  const upstreamUrl = new URL(OPENAI_UPSTREAM_ORIGIN);

  sourceUrl.searchParams.delete("session_id");
  sourceUrl.searchParams.delete(UPSTREAM_MODE_QUERY);

  // If the operator-supplied origin already includes a path prefix (e.g.
  // OPENAI_UPSTREAM_ORIGIN=https://openrouter.ai/api), preserve it. The
  // origin URL's path becomes the prefix; the mapped request path appends.
  // For plain origins (e.g. https://api.openai.com), originPrefix is empty
  // and behavior is unchanged.
  const originPrefix = upstreamUrl.pathname.replace(/\/$/, "");  // strip trailing slash
  const mapped = normalizeOpenAIPath(sourceUrl.pathname);
  const safeMapped = mapped.startsWith("/") ? mapped : `/${mapped}`;
  upstreamUrl.pathname = originPrefix && originPrefix !== ""
    ? `${originPrefix}${safeMapped}`
    : safeMapped;

  const search = sourceUrl.searchParams.toString();
  upstreamUrl.search = search ? `?${search}` : "";
  return upstreamUrl.toString();
}

function buildHeaders(
  source: Headers,
  accessToken: string,
  accountId: string | null,
  sessionId: string | null,
): Headers {
  const headers = new Headers(source);

  for (const header of [
    "authorization",
    "content-encoding",
    "content-length",
    "host",
    "openai-beta",
    "openai-organization",
    "openai-project",
    "x-api-key",
    "api-key",
    "originator",
    "oai-product-sku",
  ]) {
    headers.delete(header);
  }

  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("origin", CHATGPT_ORIGIN);
  headers.set("referer", `${CHATGPT_ORIGIN}/`);
  headers.set("accept-language", "en-US,en;q=0.9");
  headers.set("oai-language", "en-US");
  headers.set("sec-fetch-dest", "empty");
  headers.set("sec-fetch-mode", "cors");
  headers.set("sec-fetch-site", "same-origin");
  headers.set("user-agent", BROWSER_USER_AGENT);

  // Match official Codex client fingerprint (recon 2026-04-30 confirmed
  // these gate connector endpoints; likely also affect the safety
  // classifier path on /responses).
  if (ORIGINATOR) headers.set("originator", ORIGINATOR);
  if (OAI_PRODUCT_SKU) headers.set("oai-product-sku", OAI_PRODUCT_SKU);

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

function buildOpenAIHeaders(source: Headers, injectedApiKey: string | null = null): Headers {
  const headers = new Headers(source);
  const bearerAuth = readString(source.get("authorization"));
  const clientApiKey = readString(source.get("x-api-key")) || readString(source.get("api-key"));

  for (const header of [
    "content-encoding",
    "content-length",
    "host",
    "origin",
    "referer",
    "session_id",
    "x-codex-session-id",
    UPSTREAM_MODE_HEADER,
    "originator",
    "oai-product-sku",
    "chatgpt-account-id",
    "x-api-key",
    "api-key",
    "authorization",  // dropped so we can rebuild it deterministically below
  ]) {
    headers.delete(header);
  }

  // Priority: client-supplied Bearer > client-supplied API key > proxy-injected API key
  // The first two let curl probes work via /openai/* prefix as before;
  // injection covers the Codex-CLI case where the client sends no auth at all.
  if (bearerAuth) {
    headers.set("authorization", bearerAuth);
  } else if (clientApiKey) {
    headers.set("authorization", `Bearer ${clientApiKey}`);
  } else if (injectedApiKey) {
    headers.set("authorization", `Bearer ${injectedApiKey}`);
  }

  headers.set("accept", source.get("accept") || "application/json");
  headers.set("user-agent", BROWSER_USER_AGENT);

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

// Fields the chatgpt.com backend rejects on echoed-back response items.
// Models emit `phase` ("commentary" / "final_answer" / etc.) on output items;
// Codex sends those items back as conversation history. The backend used to
// accept the echo and now returns 400 unknown_parameter.
const STRIP_FROM_INPUT_ITEM = ["phase", "obfuscation", "logprobs"];

// Top-level body fields the chatgpt.com/codex backend rejects with
// "Unknown parameter". Observed in production stdout 2026-04-30:
//   "Unknown parameter: 'client_metadata'"
// Codex CLI itself sends this field. We strip it before forwarding.
const STRIP_FROM_BODY = ["client_metadata", "max_output_tokens", "max_completion_tokens"];

// Content-part type remap. The backend accepts `input_text|input_image|input_file|scoped_content`
// inside input[].content[] but Codex echoes back assistant `output_text` parts as conversation
// history → 400 invalid_value. Rewrite to the equivalent input shape.
const REMAP_CONTENT_TYPE: Record<string, string> = {
  output_text: "input_text",
};

function scrubInputItem(item: any): { item: any; changed: boolean } {
  if (!item || typeof item !== "object" || Array.isArray(item)) return { item, changed: false };
  let changed = false;
  let next: any = item;

  // Strip top-level rejected fields
  for (const key of STRIP_FROM_INPUT_ITEM) {
    if (key in item) {
      if (!changed) { next = { ...item }; changed = true; }
      delete next[key];
    }
  }

  // Remap content-part types when present
  if (Array.isArray(item.content)) {
    let contentMutated = false;
    const scrubbedContent = item.content.map((part: any) => {
      if (!part || typeof part !== "object") return part;
      const remap = typeof part.type === "string" ? REMAP_CONTENT_TYPE[part.type] : undefined;
      if (!remap) return part;
      contentMutated = true;
      // strip output-only sibling fields while remapping
      const { logprobs, annotations, obfuscation, ...rest } = part;
      void logprobs; void annotations; void obfuscation;
      return { ...rest, type: remap };
    });
    if (contentMutated) {
      if (!changed) { next = { ...item }; changed = true; }
      next.content = scrubbedContent;
    }
  }

  return { item: next, changed };
}

function normalizeInputValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    let mutated = false;
    const out = value.map((item) => {
      const r = scrubInputItem(item);
      if (r.changed) mutated = true;
      return r.item;
    });
    return mutated ? out : value;
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
    const r = scrubInputItem(value);
    return [r.item];
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

export interface InspectedInputItem {
  index: number;
  tier: Tier | null;
  role: string | null;
  type: string | null;
  byteLen: number;
  contentHash: string | null;
  permissions: ReturnType<typeof parsePermissionsBlock>;
  injections: InjectionMatch[];
}

export interface InspectedTools {
  count: number;
  byType: Record<string, number>;
  names: (string | null)[];
}

export interface InspectInputResult {
  inputTiers: Partial<Record<Tier, { messages: number; bytes: number }>>;
  items: InspectedInputItem[];
  tools: InspectedTools;
  reasoningEffort: string | null;
  reasoningSummary: string | null;
  promptCacheKey: string | null;
  // Newly surfaced top-level body fields:
  store: boolean | null;
  stream: boolean | null;
  toolChoice: any;
  parallelToolCalls: boolean | null;
  include: string[] | null;
  textVerbosity: string | null;
  textFormatType: string | null;
  clientInstallationId: string | null;
  instructionsLen: number | null;
  instructionsHash: string | null;
}

function inspectInput(parsedBody: Record<string, any> | null): InspectInputResult {
  const inputTiers: Partial<Record<Tier, { messages: number; bytes: number }>> = {};
  const items: InspectedInputItem[] = [];

  const input = parsedBody && Array.isArray(parsedBody.input) ? parsedBody.input : [];
  for (let i = 0; i < input.length; i += 1) {
    const item = input[i];
    if (!item || typeof item !== "object") continue;

    const tier = tierForInputItem(item);
    const role = typeof item.role === "string" ? item.role : null;
    const type = typeof item.type === "string" ? item.type : null;
    const text = extractTextFromInputItem(item);
    const byteLen = text.length;

    if (tier) {
      const current = inputTiers[tier] || { messages: 0, bytes: 0 };
      current.messages += 1;
      current.bytes += byteLen;
      inputTiers[tier] = current;
    }

    const injections = byteLen > 0 && tier
      ? detectInjections(text, { tier, index: i })
      : [];

    items.push({
      index: i,
      tier,
      role,
      type,
      byteLen,
      contentHash: byteLen > 0 ? hashContent(text) : null,
      permissions: tier === "developer" ? parsePermissionsBlock(text) : null,
      injections,
    });
  }

  const tools = Array.isArray(parsedBody?.tools) ? parsedBody!.tools : [];
  const byType: Record<string, number> = {};
  const names: (string | null)[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const ty = typeof t.type === "string" ? t.type : "unknown";
    byType[ty] = (byType[ty] || 0) + 1;
    names.push(typeof t.name === "string" ? t.name : null);
  }

  const reasoning = parsedBody?.reasoning && typeof parsedBody.reasoning === "object" && !Array.isArray(parsedBody.reasoning)
    ? parsedBody.reasoning as Record<string, any>
    : null;

  const text = parsedBody?.text && typeof parsedBody.text === "object" && !Array.isArray(parsedBody.text)
    ? parsedBody.text as Record<string, any>
    : null;
  const textFormat = text?.format && typeof text.format === "object" && !Array.isArray(text.format)
    ? text.format as Record<string, any>
    : null;

  const clientMd = parsedBody?.client_metadata && typeof parsedBody.client_metadata === "object" && !Array.isArray(parsedBody.client_metadata)
    ? parsedBody.client_metadata as Record<string, any>
    : null;

  const instructions = typeof parsedBody?.instructions === "string" ? parsedBody.instructions : null;

  return {
    inputTiers,
    items,
    tools: { count: tools.length, byType, names },
    reasoningEffort: typeof reasoning?.effort === "string" ? reasoning.effort : null,
    reasoningSummary: typeof reasoning?.summary === "string" ? reasoning.summary : null,
    promptCacheKey: typeof parsedBody?.prompt_cache_key === "string" ? parsedBody.prompt_cache_key : null,
    store: typeof parsedBody?.store === "boolean" ? parsedBody.store : null,
    stream: typeof parsedBody?.stream === "boolean" ? parsedBody.stream : null,
    toolChoice: parsedBody?.tool_choice ?? null,
    parallelToolCalls: typeof parsedBody?.parallel_tool_calls === "boolean" ? parsedBody.parallel_tool_calls : null,
    include: Array.isArray(parsedBody?.include) ? parsedBody!.include.filter((s: any) => typeof s === "string") : null,
    textVerbosity: typeof text?.verbosity === "string" ? text.verbosity : null,
    textFormatType: typeof textFormat?.type === "string" ? textFormat.type : null,
    clientInstallationId: typeof clientMd?.["x-codex-installation-id"] === "string" ? clientMd["x-codex-installation-id"] : null,
    instructionsLen: instructions ? instructions.length : null,
    instructionsHash: instructions && instructions.length > 0 ? hashContent(instructions) : null,
  };
}

function emitInputObservability(
  requestId: string,
  sessionId: string | null,
  path: string,
  inspection: InspectInputResult,
) {
  for (const item of inspection.items) {
    harmonyEventLog({
      phase: "request.input_item",
      requestId,
      sessionId,
      path,
      index: item.index,
      tier: item.tier,
      role: item.role,
      type: item.type,
      byteLen: item.byteLen,
      contentHash: item.contentHash,
    });

    if (item.permissions) {
      harmonyEventLog({
        phase: "request.permissions_claim",
        requestId,
        sessionId,
        path,
        index: item.index,
        tier: item.tier,
        sandboxMode: item.permissions.sandboxMode,
        networkAccess: item.permissions.networkAccess,
        approvalPolicy: item.permissions.approvalPolicy,
        rawHash: hashContent(item.permissions.raw),
      });
    }

    for (const inj of item.injections) {
      harmonyEventLog({
        phase: "request.injection_detected",
        requestId,
        sessionId,
        path,
        index: item.index,
        tier: item.tier,
        rule: inj.rule,
        severity: inj.severity,
        description: inj.description,
        matchedText: inj.matchedText,
        matchedSnippet: inj.matchedSnippet,
        position: inj.position,
      });
    }
  }

  const allInjections = inspection.items.flatMap((it) => it.injections);
  if (allInjections.length > 0) {
    harmonyEventLog({
      phase: "request.injection_summary",
      requestId,
      sessionId,
      path,
      count: allInjections.length,
      highestSeverity: highestSeverity(allInjections),
      rules: [...new Set(allInjections.map((i) => i.rule))],
    });
  }

  harmonyEventLog({
    phase: "request.tier_summary",
    requestId,
    sessionId,
    path,
    inputTiers: inspection.inputTiers,
    toolCount: inspection.tools.count,
    toolByType: inspection.tools.byType,
    toolNames: inspection.tools.names,
    reasoningEffort: inspection.reasoningEffort,
    reasoningSummary: inspection.reasoningSummary,
    promptCacheKey: inspection.promptCacheKey,
    store: inspection.store,
    stream: inspection.stream,
    toolChoice: inspection.toolChoice,
    parallelToolCalls: inspection.parallelToolCalls,
    include: inspection.include,
    textVerbosity: inspection.textVerbosity,
    textFormatType: inspection.textFormatType,
    clientInstallationId: inspection.clientInstallationId,
    instructionsLen: inspection.instructionsLen,
    instructionsHash: inspection.instructionsHash,
  });
}

function prepareRequest(
  requestUrl: string,
  headers: Headers,
  body: ArrayBuffer | Uint8Array | undefined,
  upstreamMode: UpstreamMode = "codex",
): PreparedRequest {
  const summary = inspectRequest(headers, body);
  const parsedBody = parseJsonBody(headers, body);
  const sessionId = extractSessionId(new URL(requestUrl), headers, parsedBody);

  if (!parsedBody) {
    return { summary, body, sessionId, parsedBody: null };
  }

  let changed = false;
  const nextBody: Record<string, any> = { ...parsedBody };

  if (sessionId && typeof nextBody.session_id === "string") {
    delete nextBody.session_id;
    changed = true;
  }

  // Strip backend-rejected fields from echoed-back response items on every path
  // (responses, responses/compact). Items the model emitted with `phase` get
  // sent back as input on next turns; chatgpt.com rejects them with 400.
  if (Array.isArray(nextBody.input)) {
    let inputMutated = false;
    const scrubbed = nextBody.input.map((item: any) => {
      const r = scrubInputItem(item);
      if (r.changed) inputMutated = true;
      return r.item;
    });
    if (inputMutated) {
      nextBody.input = scrubbed;
      changed = true;
    }
  }

  // Strip top-level body fields the backend now rejects.
  for (const k of STRIP_FROM_BODY) {
    if (k in nextBody) {
      delete nextBody[k];
      changed = true;
    }
  }

  if (!isResponseCreatePath(requestUrl)) {
    return {
      summary,
      sessionId,
      body: changed ? encoder.encode(JSON.stringify(nextBody)) : body,
      parsedBody: nextBody,
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

  // DEFAULT_INSTRUCTIONS is the Codex-shape minimal system prompt — the ChatGPT-account
  // upstream expects a ChatGPT-account-style identity. The OpenAI direct API doesn't
  // need it; injecting it would force a useless "You are Codex" prefix on api.openai.com
  // calls. Only inject for codex mode.
  if (upstreamMode === "codex" && !readString(nextBody.instructions)) {
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

  // Ensure reasoning.effort is set when reasoning is present. The OpenAI direct API
  // (via OpenRouter) rejects requests with reasoning.summary but no reasoning.effort
  // as "Reasoning is mandatory for this endpoint and cannot be disabled." Codex CLI
  // sometimes omits effort (especially for gpt-5.1-codex-max), so we inject a default
  // when absent. chatgpt-backend tolerates this either way.
  if (DEFAULT_REASONING_EFFORT && nextBody.reasoning && typeof nextBody.reasoning === "object" && !Array.isArray(nextBody.reasoning)) {
    const r = nextBody.reasoning as Record<string, any>;
    if (!readString(r.effort)) {
      nextBody.reasoning = { ...r, effort: DEFAULT_REASONING_EFFORT };
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
    parsedBody: nextBody,
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

function ensureCaptureLogStarted(capture: ChannelCapture) {
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

function appendLiveChunk(capture: ChannelCapture, kind: "reasoning" | "text", chunk: string | undefined) {
  if (typeof chunk !== "string" || chunk.length === 0) return;

  const channel: Channel = kind === "reasoning" ? "analysis" : "final";
  if (channel === "analysis") {
    capture.channels.analysis.push(chunk);
  } else {
    capture.channels.final.push(chunk);
  }

  harmonyEventLog({
    phase: "response.channel_chunk",
    requestId: capture.requestId,
    sessionId: capture.sessionId,
    path: capture.path,
    model: capture.model,
    channel,
    ...shapeHarmonyContent(chunk),
  });

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

function recordCommentaryFn(capture: ChannelCapture, itemId: string, name: string | null, args: string | undefined, replace: boolean) {
  if (typeof args !== "string" || args.length === 0) return;

  const existing = capture.channels.commentary.fn.get(itemId);
  if (!existing) {
    capture.channels.commentary.fn.set(itemId, { itemId, name, args });
  } else {
    if (name && !existing.name) existing.name = name;
    existing.args = replace ? args : existing.args + args;
  }

  harmonyEventLog({
    phase: replace ? "response.tool_call.done" : "response.tool_call.delta",
    requestId: capture.requestId,
    sessionId: capture.sessionId,
    path: capture.path,
    model: capture.model,
    channel: "commentary" as Channel,
    toolType: "function_call",
    itemId,
    name,
    ...shapeHarmonyContent(args),
  });
}

function recordCommentaryCustom(capture: ChannelCapture, itemId: string, name: string | null, input: string | undefined, replace: boolean) {
  if (typeof input !== "string" || input.length === 0) return;

  const existing = capture.channels.commentary.custom.get(itemId);
  if (!existing) {
    capture.channels.commentary.custom.set(itemId, { itemId, name, input });
  } else {
    if (name && !existing.name) existing.name = name;
    existing.input = replace ? input : existing.input + input;
  }

  harmonyEventLog({
    phase: replace ? "response.tool_call.done" : "response.tool_call.delta",
    requestId: capture.requestId,
    sessionId: capture.sessionId,
    path: capture.path,
    model: capture.model,
    channel: "commentary" as Channel,
    toolType: "custom_tool_call",
    itemId,
    name,
    ...shapeHarmonyContent(input),
  });
}

function captureSnapshot(capture: ChannelCapture): CaptureSnapshot {
  return {
    requestId: capture.requestId,
    path: capture.path,
    sessionId: capture.sessionId,
    startedAt: capture.startedAt,
    model: capture.model,
    inputTokens: capture.inputTokens,
    outputTokens: capture.outputTokens,
    stopReason: capture.stopReason,
    channels: {
      final: capture.channels.final.join(""),
      analysis: capture.channels.analysis.join(""),
      commentary: {
        fn: [...capture.channels.commentary.fn.values()].map((c) => ({ ...c })),
        custom: [...capture.channels.commentary.custom.values()].map((c) => ({ ...c })),
      },
    },
    inputTiers: capture.inputTiers,
  };
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

// Extract response-envelope fields the backend sends on every response.created/completed/failed
// envelope. These are wire-stream values currently discarded. Called repeatedly across the lifetime
// of a turn — fields populate as the backend reveals them. Returns true if any field changed.
export function mergeResponseEnvelope(
  envelope: ResponseEnvelope,
  response: Record<string, any> | undefined,
): boolean {
  if (!response || typeof response !== "object") return false;
  let changed = false;
  const setStr = (cur: string | null, key: string): string | null => {
    const v = response[key];
    if (typeof v === "string" && v !== cur) { changed = true; return v; }
    return cur;
  };
  const setBool = (cur: boolean | null, key: string): boolean | null => {
    const v = response[key];
    if (typeof v === "boolean" && v !== cur) { changed = true; return v; }
    return cur;
  };
  const setObj = (cur: Record<string, any> | null, key: string): Record<string, any> | null => {
    const v = response[key];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const ser = JSON.stringify(v);
      if (JSON.stringify(cur) !== ser) { changed = true; return v as Record<string, any>; }
    }
    return cur;
  };

  envelope.serviceTier = setStr(envelope.serviceTier, "service_tier");
  envelope.safetyIdentifier = setStr(envelope.safetyIdentifier, "safety_identifier");
  envelope.previousResponseId = setStr(envelope.previousResponseId, "previous_response_id");
  envelope.truncation = setStr(envelope.truncation, "truncation");
  envelope.store = setBool(envelope.store, "store");
  envelope.parallelToolCalls = setBool(envelope.parallelToolCalls, "parallel_tool_calls");

  // prompt_cache_retention may be string ("default") or seconds number
  const pcr = response.prompt_cache_retention;
  if ((typeof pcr === "string" || typeof pcr === "number") && pcr !== envelope.promptCacheRetention) {
    envelope.promptCacheRetention = pcr;
    changed = true;
  }

  // tool_choice can be string ("auto"/"none") or object ({type: "function", name: ...})
  const tc = response.tool_choice;
  if (typeof tc === "string" && tc !== envelope.toolChoice) {
    envelope.toolChoice = tc;
    changed = true;
  } else if (tc && typeof tc === "object" && JSON.stringify(tc) !== JSON.stringify(envelope.toolChoice)) {
    envelope.toolChoice = tc as Record<string, any>;
    changed = true;
  }

  envelope.toolUsage = setObj(envelope.toolUsage, "tool_usage");
  envelope.moderation = setObj(envelope.moderation, "moderation");

  // Nested: reasoning.effort, reasoning.summary
  const reasoning = response.reasoning;
  if (reasoning && typeof reasoning === "object") {
    if (typeof reasoning.effort === "string" && reasoning.effort !== envelope.reasoningEffort) {
      envelope.reasoningEffort = reasoning.effort;
      changed = true;
    }
    if (typeof reasoning.summary === "string" && reasoning.summary !== envelope.reasoningSummary) {
      envelope.reasoningSummary = reasoning.summary;
      changed = true;
    }
  }

  // Nested: text.verbosity, text.format.type
  const text = response.text;
  if (text && typeof text === "object") {
    if (typeof text.verbosity === "string" && text.verbosity !== envelope.textVerbosity) {
      envelope.textVerbosity = text.verbosity;
      changed = true;
    }
    if (text.format && typeof text.format === "object" && typeof text.format.type === "string"
        && text.format.type !== envelope.textFormatType) {
      envelope.textFormatType = text.format.type;
      changed = true;
    }
  }

  return changed;
}

const CYBER_POLICY_CODES = new Set<string>([
  "cyber_policy",
  "policy_violation",
  "content_policy_violation",
  "moderation_blocked",
]);

export function extractErrorFields(blob: Record<string, any> | undefined): {
  code: string | null;
  message: string | null;
  type: string | null;
  param: string | null;
} {
  if (!blob || typeof blob !== "object") {
    return { code: null, message: null, type: null, param: null };
  }
  const get = (k: string): string | null => {
    const v = (blob as any)[k];
    return typeof v === "string" ? v : null;
  };
  return {
    code: get("code"),
    message: get("message"),
    type: get("type"),
    param: get("param"),
  };
}

export function isCyberPolicyCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return CYBER_POLICY_CODES.has(code.toLowerCase());
}

function scanItemForFallback(
  capture: ChannelCapture,
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

function flushCapture(capture: ChannelCapture) {
  if (capture.flushed) return;
  capture.flushed = true;

  const finalParts = capture.channels.final;
  const analysisParts = capture.channels.analysis;

  harmonyEventLog({
    phase: "response.completed",
    requestId: capture.requestId,
    sessionId: capture.sessionId,
    path: capture.path,
    model: capture.model,
    responseId: capture.responseId,
    inputTokens: capture.inputTokens,
    outputTokens: capture.outputTokens,
    stopReason: capture.stopReason,
    finalLen: finalParts.reduce((acc, s) => acc + s.length, 0),
    analysisLen: analysisParts.reduce((acc, s) => acc + s.length, 0),
    fnCalls: capture.channels.commentary.fn.size,
    customCalls: capture.channels.commentary.custom.size,
    metadata: capture.metadata,
    encryptedReasoningCount: capture.encryptedReasoningSizes.length,
    encryptedReasoningTotalBytes: capture.encryptedReasoningSizes.reduce((a, b) => a + b, 0),
  });

  // Response-envelope snapshot — captures wire-stream fields (service_tier, safety_identifier,
  // moderation, previous_response_id, etc.) that processSseEvent merges across the turn.
  if (!capture.envelopeEmitted) {
    capture.envelopeEmitted = true;
    // Classify reasoning-emission mode based on what landed in the analysis channel
    // (cleartext) vs the encryptedReasoningSizes array (Fernet blobs).
    const cleartextBytes = analysisParts.reduce((acc, s) => acc + s.length, 0);
    const encryptedBlobCount = capture.encryptedReasoningSizes.length;
    capture.envelope.reasoningMode =
      cleartextBytes > 0 && encryptedBlobCount > 0 ? "both" :
      cleartextBytes > 0 ? "cleartext_only" :
      encryptedBlobCount > 0 ? "encrypted_only" : "none";
    harmonyEventLog({
      phase: "response.envelope_captured",
      requestId: capture.requestId,
      sessionId: capture.sessionId,
      path: capture.path,
      model: capture.model,
      responseId: capture.responseId,
      stopReason: capture.stopReason,
      envelope: capture.envelope,
    });
  }

  // Refusal + divergence pass — runs after the channel arrays are settled.
  const finalText = finalParts.join("");
  const analysisText = analysisParts.join("");
  const refusal = detectRefusal(finalText);
  const divergence = divergenceVerdict(finalText, analysisText);
  if (refusal.isRefusal || divergence.divergent) {
    harmonyEventLog({
      phase: "response.refusal_detected",
      requestId: capture.requestId,
      sessionId: capture.sessionId,
      path: capture.path,
      model: capture.model,
      responseId: capture.responseId,
      finalLen: divergence.finalLen,
      analysisLen: divergence.analysisLen,
      refusal: {
        isRefusal: refusal.isRefusal,
        matchCount: refusal.matches.length,
        patterns: refusal.matches.map((m) => m.pattern),
        firstSnippet: refusal.matches[0]?.snippet ?? null,
      },
      divergence: {
        divergent: divergence.divergent,
        reason: divergence.reason,
      },
      analysisLooksLikeRefusal: divergence.analysisLooksLikeRefusal,
    });
  }

  try {
    hooks.onResponseComplete?.(captureSnapshot(capture));
  } catch (error) {
    console.error(`[proxy] onResponseComplete hook failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (capture.logStarted) {
    thinkingLog(`\n[${formatTime()}] done | out=${capture.outputTokens ?? "?"} | stop=${capture.stopReason}\n`);
    return;
  }

  if (analysisParts.length === 0 && finalParts.length === 0) {
    return;
  }

  const sections: string[] = [
    "",
    SEPARATOR,
    `[${formatTime(capture.startedAt)}] ${capture.model} | in=${capture.inputTokens ?? "?"}`,
    SEPARATOR,
  ];

  if (analysisParts.length > 0) {
    sections.push("[reasoning]");
    sections.push(analysisParts.join(""));
  }

  if (finalParts.length > 0) {
    sections.push("[text]");
    sections.push(finalParts.join(""));
  }

  sections.push(`[${formatTime()}] done | out=${capture.outputTokens ?? "?"} | stop=${capture.stopReason}`);
  thinkingLog(`${sections.join("\n")}\n`);
}

function harvestMetadata(node: any, capture: ChannelCapture, depth = 0): boolean {
  if (depth > 6 || !node || typeof node !== "object") return false;
  let found = false;
  if (Array.isArray(node)) {
    for (const item of node) found = harvestMetadata(item, capture, depth + 1) || found;
    return found;
  }
  if (node.metadata && typeof node.metadata === "object" && !Array.isArray(node.metadata)) {
    const md = node.metadata as Record<string, any>;
    if (Object.keys(md).length > 0) {
      capture.metadata = { ...capture.metadata, ...md };
      found = true;
    }
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") found = harvestMetadata(v, capture, depth + 1) || found;
  }
  return found;
}

// Chat Completions API delta processor. Chat-completions emits chunks with shape:
//   { object: "chat.completion.chunk", model, provider, choices: [{ index, delta: {...}, finish_reason }] }
// where delta carries some combination of:
//   delta.content                 → final visible text
//   delta.reasoning_content       → CoT (cleartext, the BIG find from earlier)
//   delta.reasoning (string)      → also CoT, alternative field used by some upstream variants
//   delta.reasoning_details[]     → structured CoT chunks with {type:"reasoning.summary", summary, format}
//   delta.tool_calls[]            → tool-call deltas with {index, id?, function:{name?, arguments?}}
// finish_reason set on the final chunk: "stop" | "tool_calls" | "length" | "content_filter"
function processChatCompletionChunk(event: Record<string, any>, capture: ChannelCapture) {
  // Capture model + provider (OpenRouter sets provider; api.openai.com direct does not)
  if (typeof event.model === "string") {
    if (capture.model === "unknown" || capture.model === "-") {
      capture.model = event.model;
    }
    // Track the OpenRouter-resolved model name (e.g. "openai/gpt-5.5-20260423")
    if (capture.responseId === null && typeof event.id === "string") {
      capture.responseId = event.id;
    }
  }
  if (typeof event.provider === "string" && !capture.envelope.openrouterProvider) {
    capture.envelope.openrouterProvider = event.provider;
  }

  const choices = Array.isArray(event.choices) ? event.choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== "object") continue;
    const index = typeof choice.index === "number" ? choice.index : 0;
    const delta = (choice.delta && typeof choice.delta === "object") ? choice.delta as Record<string, any> : null;

    if (delta) {
      // Visible content → final channel
      if (typeof delta.content === "string" && delta.content.length > 0) {
        appendLiveChunk(capture, "text", delta.content);
      }

      // CoT → analysis channel. Prefer reasoning_content; fall back to reasoning string.
      // We track first-seen to dedup vs reasoning_details below.
      let analysisAppended = false;
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        appendLiveChunk(capture, "reasoning", delta.reasoning_content);
        analysisAppended = true;
      } else if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
        appendLiveChunk(capture, "reasoning", delta.reasoning);
        analysisAppended = true;
      }

      // reasoning_details: structured form. Two entry types live here:
      //   type: "reasoning.summary"   → {summary, format, index}  cleartext CoT chunk
      //   type: "reasoning.encrypted" → {data, format, index}     Fernet-encrypted blob
      //                                                            (same shape as Responses-API
      //                                                            encrypted_content — server-keyed,
      //                                                            undecryptable client-side)
      //
      // The encrypted blob has been silently riding chat-completions traffic this whole time.
      // We route it into capture.encryptedReasoningSizes — the same array Responses-API uses —
      // so /debug/envelopes and fernet-decode analysis work uniformly across both endpoints.
      if (Array.isArray(delta.reasoning_details)) {
        for (const detail of delta.reasoning_details) {
          if (!detail || typeof detail !== "object") continue;
          const t = typeof detail.type === "string" ? detail.type : "";
          if (t === "reasoning.encrypted" && typeof detail.data === "string" && detail.data.length > 0) {
            capture.encryptedReasoningSizes.push(detail.data.length);
          } else if (!analysisAppended && typeof detail.summary === "string" && detail.summary.length > 0) {
            // Cleartext summary chunk — but only emit if we haven't already captured
            // the same content via the top-level reasoning_content / reasoning string.
            appendLiveChunk(capture, "reasoning", detail.summary);
          }
        }
      }

      // Tool-call deltas — stitch by (requestId, choice.index, tc.index) using a
      // synthetic itemId. Per OpenAI's chat-completions streaming spec, the first
      // delta at a given index has the id + function.name; subsequent deltas at
      // the same index only have partial function.arguments. We always key by
      // the synthetic id so all deltas merge into one entry; tc.id is metadata.
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!tc || typeof tc !== "object") continue;
          const tcIndex = typeof tc.index === "number" ? tc.index : index;
          const itemId = `cc-${capture.requestId}-${tcIndex}`;
          const fn = tc.function && typeof tc.function === "object" ? tc.function as Record<string, any> : null;
          const name = fn && typeof fn.name === "string" ? fn.name : null;
          const args = fn && typeof fn.arguments === "string" ? fn.arguments : undefined;
          if (name || args) {
            recordCommentaryFn(capture, itemId, name, args, false);
          }
        }
      }
    }

    // finish_reason on the last chunk maps to capture.stopReason
    if (typeof choice.finish_reason === "string") {
      capture.stopReason = choice.finish_reason;
    }
  }

  // Usage stats arrive on the LAST chunk for streaming chat-completions (when include_usage is set)
  const usage = event.usage;
  if (usage && typeof usage === "object") {
    if (typeof usage.prompt_tokens === "number") capture.inputTokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === "number") capture.outputTokens = usage.completion_tokens;
  }
}

function processSseEvent(event: Record<string, any>, capture: ChannelCapture) {
  // Chat Completions API path — different envelope shape than Responses API.
  // Detect by event.object === "chat.completion.chunk" and route to dedicated processor.
  if (event && event.object === "chat.completion.chunk") {
    processChatCompletionChunk(event, capture);
    return;
  }

  // Universal metadata harvest — runs on every event, scoops up any nested metadata block
  const before = JSON.stringify(capture.metadata);
  harvestMetadata(event, capture);
  if (JSON.stringify(capture.metadata) !== before) {
    harmonyEventLog({
      phase: "response.metadata_observed",
      requestId: capture.requestId,
      sessionId: capture.sessionId,
      path: capture.path,
      eventType: typeof event.type === "string" ? event.type : "unknown",
      metadata: capture.metadata,
    });
  }

  switch (event.type) {
    case "response.created": {
      const response = event.response as Record<string, any> | undefined;
      capture.model = typeof response?.model === "string" ? response.model : capture.model;
      capture.responseId = typeof response?.id === "string" ? response.id : capture.responseId;
      const usage = extractUsage(response);
      capture.inputTokens = usage.input ?? capture.inputTokens;
      mergeResponseEnvelope(capture.envelope, response);
      break;
    }

    case "response.metadata": {
      // Standalone metadata SSE — already harvested by walker above, but record explicitly.
      if (typeof event.response_id === "string") {
        capture.responseId = event.response_id;
      }
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

    case "response.output_item.added": {
      const item = event.item as Record<string, any> | undefined;
      if (item?.type === "function_call" && typeof item.id === "string") {
        recordCommentaryFn(capture, item.id, typeof item.name === "string" ? item.name : null,
          typeof item.arguments === "string" && item.arguments.length > 0 ? item.arguments : undefined, true);
      }
      if (item?.type === "custom_tool_call" && typeof item.id === "string") {
        recordCommentaryCustom(capture, item.id, typeof item.name === "string" ? item.name : null,
          typeof item.input === "string" && item.input.length > 0 ? item.input : undefined, true);
      }
      if (item?.type === "reasoning" && typeof item.encrypted_content === "string") {
        capture.encryptedReasoningSizes.push(item.encrypted_content.length);
        try {
          const fernet = decodeFernet(item.encrypted_content);
          harmonyEventLog({
            phase: "response.encrypted_reasoning",
            requestId: capture.requestId,
            sessionId: capture.sessionId,
            path: capture.path,
            model: capture.model,
            itemId: typeof item.id === "string" ? item.id : null,
            // structural decode (no decryption — key is server-held)
            fernet: {
              tokenLen: item.encrypted_content.length,
              totalBytes: fernet.totalBytes,
              version: fernet.version,
              timestamp: fernet.timestamp,
              iso: fernet.iso,
              ivHex: fernet.ivHex,
              ciphertextBytes: fernet.ciphertextBytes,
              ciphertextBlocks: fernet.ciphertextBlocks,
              hmacHex: fernet.hmacHex,
            },
          });
        } catch (err) {
          harmonyEventLog({
            phase: "response.encrypted_reasoning_decode_error",
            requestId: capture.requestId,
            sessionId: capture.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      break;
    }

    case "response.function_call_arguments.delta": {
      const itemId = typeof event.item_id === "string" ? event.item_id : `output:${event.output_index ?? "?"}`;
      recordCommentaryFn(capture, itemId, null, typeof event.delta === "string" ? event.delta : undefined, false);
      break;
    }

    case "response.function_call_arguments.done": {
      const itemId = typeof event.item_id === "string" ? event.item_id : `output:${event.output_index ?? "?"}`;
      recordCommentaryFn(capture, itemId, null, typeof event.arguments === "string" ? event.arguments : undefined, true);
      break;
    }

    case "response.custom_tool_call_input.delta": {
      const itemId = typeof event.item_id === "string" ? event.item_id : `output:${event.output_index ?? "?"}`;
      recordCommentaryCustom(capture, itemId, null, typeof event.delta === "string" ? event.delta : undefined, false);
      break;
    }

    case "response.custom_tool_call_input.done": {
      const itemId = typeof event.item_id === "string" ? event.item_id : `output:${event.output_index ?? "?"}`;
      recordCommentaryCustom(capture, itemId, null, typeof event.input === "string" ? event.input : undefined, true);
      break;
    }

    case "response.output_item.done": {
      const item = event.item as Record<string, any> | undefined;
      if (item?.type === "function_call" && typeof item.id === "string") {
        recordCommentaryFn(capture, item.id, typeof item.name === "string" ? item.name : null,
          typeof item.arguments === "string" && item.arguments.length > 0 ? item.arguments : undefined, true);
      }
      if (item?.type === "custom_tool_call" && typeof item.id === "string") {
        recordCommentaryCustom(capture, item.id, typeof item.name === "string" ? item.name : null,
          typeof item.input === "string" && item.input.length > 0 ? item.input : undefined, true);
      }
      if (capture.channels.analysis.length === 0 || capture.channels.final.length === 0) {
        scanItemForFallback(
          capture,
          item,
          capture.channels.analysis.length === 0,
          capture.channels.final.length === 0,
        );
      }
      break;
    }

    case "error": {
      // Top-level SSE error envelope (no response.* prefix). Codex backend uses this
      // for stream-level failures (rate limits, transport errors, transient policy hits).
      const errBlob = (event.error && typeof event.error === "object")
        ? event.error as Record<string, any>
        : event;
      const fields = extractErrorFields(errBlob);
      const record: CaptureErrorRecord = {
        source: "sse_error_event",
        code: fields.code,
        message: fields.message,
        type: fields.type,
        param: fields.param,
        raw: errBlob,
        at: new Date().toISOString(),
      };
      capture.errors.push(record);
      harmonyEventLog({
        phase: "response.error_event",
        requestId: capture.requestId,
        sessionId: capture.sessionId,
        path: capture.path,
        model: capture.model,
        responseId: capture.responseId,
        source: "sse_error_event",
        code: record.code,
        type: record.type,
        param: record.param,
        message: record.message,
        cyberPolicy: isCyberPolicyCode(record.code),
      });
      if (isCyberPolicyCode(record.code)) {
        harmonyEventLog({
          phase: "response.cyber_policy_blocked",
          requestId: capture.requestId,
          sessionId: capture.sessionId,
          path: capture.path,
          model: capture.model,
          responseId: capture.responseId,
          code: record.code,
          message: record.message,
          source: "sse_error_event",
        });
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
      mergeResponseEnvelope(capture.envelope, response);

      if (event.type === "response.failed") {
        const errBlob = response?.error as Record<string, any> | undefined;
        const fields = extractErrorFields(errBlob);
        const record: CaptureErrorRecord = {
          source: "response_failed",
          code: fields.code,
          message: fields.message,
          type: fields.type,
          param: fields.param,
          raw: errBlob ?? {},
          at: new Date().toISOString(),
        };
        capture.errors.push(record);
        harmonyEventLog({
          phase: "response.error_event",
          requestId: capture.requestId,
          sessionId: capture.sessionId,
          path: capture.path,
          model: capture.model,
          responseId: capture.responseId,
          code: record.code,
          type: record.type,
          param: record.param,
          message: record.message,
          cyberPolicy: isCyberPolicyCode(record.code),
          source: "response_failed",
        });
        if (isCyberPolicyCode(record.code)) {
          harmonyEventLog({
            phase: "response.cyber_policy_blocked",
            requestId: capture.requestId,
            sessionId: capture.sessionId,
            path: capture.path,
            model: capture.model,
            responseId: capture.responseId,
            code: record.code,
            message: record.message,
            source: "response_failed",
          });
        }
      }

      // The Codex backend ALSO emits cyber_policy as a stop_reason on plain response.completed
      // events (no error envelope). Catch that path here — but skip if response.failed
      // above already recorded an error for this turn.
      const alreadyRecordedAsError = capture.errors.some((e) => e.source === "response_failed");
      if (!alreadyRecordedAsError && isCyberPolicyCode(capture.stopReason)) {
        const record: CaptureErrorRecord = {
          source: "response_failed",
          code: capture.stopReason || "cyber_policy",
          message: typeof response?.incomplete_details?.reason === "string" ? response.incomplete_details.reason : null,
          type: null,
          param: null,
          raw: { stop_reason: capture.stopReason, incomplete_details: response?.incomplete_details, metadata: response?.metadata },
          at: new Date().toISOString(),
        };
        capture.errors.push(record);
        harmonyEventLog({
          phase: "response.error_event",
          requestId: capture.requestId,
          sessionId: capture.sessionId,
          path: capture.path,
          model: capture.model,
          responseId: capture.responseId,
          source: "response_completed_stop_reason",
          code: record.code,
          message: record.message,
          cyberPolicy: true,
          metadata: response?.metadata ?? null,
        });
        harmonyEventLog({
          phase: "response.cyber_policy_blocked",
          requestId: capture.requestId,
          sessionId: capture.sessionId,
          path: capture.path,
          model: capture.model,
          responseId: capture.responseId,
          code: record.code,
          source: "response_completed_stop_reason",
          metadata: response?.metadata ?? null,
        });
      }

      if ((capture.channels.analysis.length === 0 || capture.channels.final.length === 0) && Array.isArray(response?.output)) {
        for (const item of response.output) {
          scanItemForFallback(
            capture,
            item,
            capture.channels.analysis.length === 0,
            capture.channels.final.length === 0,
          );
        }
      }

      flushCapture(capture);
      break;
    }
  }
}

type SseHookOutcome =
  | { action: "passthrough" }
  | { action: "drop" }
  | { action: "mutate"; event: Record<string, any> };

function parseSseBlock(block: string, capture: ChannelCapture): SseHookOutcome {
  const lines = block.split("\n");
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return { action: "passthrough" };

  const payload = dataLines.join("\n");
  if (payload === "[DONE]") return { action: "passthrough" };

  let event: Record<string, any>;
  try {
    event = JSON.parse(payload) as Record<string, any>;
  } catch {
    // Malformed SSE — keep the relay transparent.
    return { action: "passthrough" };
  }

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

  let outcome: SseHookOutcome = { action: "passthrough" };
  let effectiveEvent = event;
  const eventChannel = channelForEventType(typeof event.type === "string" ? event.type : null);

  // Profile channel gate runs first — it's authoritative.
  const profile = capture.profile;
  if (profile && shouldDropChannel(eventChannel, profile.def)) {
    harmonyEventLog({
      phase: "response.profile_channel_dropped",
      requestId: capture.requestId,
      sessionId: capture.sessionId,
      path: capture.path,
      profile: profile.name,
      channel: eventChannel,
      type: typeof event.type === "string" ? event.type : "unknown",
    });
    // still capture for our own observability
    processSseEvent(effectiveEvent, capture);
    return { action: "drop" };
  }

  if (hooks.onSseEvent) {
    try {
      const result = hooks.onSseEvent(event, {
        channel: eventChannel,
        requestId: capture.requestId,
        path: capture.path,
        sessionId: capture.sessionId,
      });
      if (result === "drop") {
        harmonyEventLog({
          phase: "response.sse_event_dropped",
          requestId: capture.requestId,
          sessionId: capture.sessionId,
          path: capture.path,
          model: capture.model,
          type: typeof event.type === "string" ? event.type : "unknown",
        });
        outcome = { action: "drop" };
        return outcome;
      }
      if (result && result !== event) {
        effectiveEvent = result;
        outcome = { action: "mutate", event: result };
        harmonyEventLog({
          phase: "response.sse_event_mutated",
          requestId: capture.requestId,
          sessionId: capture.sessionId,
          path: capture.path,
          model: capture.model,
          type: typeof event.type === "string" ? event.type : "unknown",
        });
      }
    } catch (error) {
      console.error(`[proxy] onSseEvent hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  processSseEvent(effectiveEvent, capture);
  return outcome;
}

function reconstructSseBlock(event: Record<string, any>): string {
  const type = typeof event.type === "string" ? event.type : null;
  const lines: string[] = [];
  if (type) lines.push(`event: ${type}`);
  lines.push(`data: ${JSON.stringify(event)}`);
  return lines.join("\n") + "\n\n";
}

function makeEmptyCapture(requestModel: string, context: { requestId?: string; path?: string; sessionId?: string | null }): ChannelCapture {
  return {
    requestId: context.requestId || "-",
    path: context.path || "-",
    sessionId: context.sessionId || null,
    startedAt: Date.now(),
    model: requestModel === "-" ? "unknown" : requestModel,
    inputTokens: null,
    outputTokens: null,
    stopReason: "stream_closed",
    channels: {
      final: [],
      analysis: [],
      commentary: {
        fn: new Map(),
        custom: new Map(),
      },
    },
    inputTiers: {},
    metadata: {},
    responseId: null,
    encryptedReasoningSizes: [],
    errors: [],
    envelope: emptyEnvelope(),
    envelopeEmitted: false,
    profile: context.requestId ? (requestProfileMap.get(context.requestId) || null) : null,
    seenTextParts: new Set(),
    seenReasoningParts: new Set(),
    logStarted: false,
    reasoningSectionOpen: false,
    textSectionOpen: false,
    flushed: false,
  };
}

function interceptStream(
  body: ReadableStream<Uint8Array>,
  requestModel: string,
  context: { requestId?: string; path?: string; sessionId?: string | null } = {},
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const capture: ChannelCapture = makeEmptyCapture(requestModel, context);
  const profileFiltersChannels = !!capture.profile && capture.profile.def.readChannels.length < 3;
  const hooksActive = typeof hooks.onSseEvent === "function" || profileFiltersChannels;
  const utf8Encoder = new TextEncoder();

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

          if (!hooksActive) {
            controller.enqueue(value);
          }
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const outcome = parseSseBlock(block, capture);

            if (hooksActive) {
              if (outcome.action === "drop") {
                // skip emission entirely
              } else if (outcome.action === "mutate") {
                controller.enqueue(utf8Encoder.encode(reconstructSseBlock(outcome.event)));
              } else {
                controller.enqueue(utf8Encoder.encode(`${block}\n\n`));
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }

        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
          const outcome = parseSseBlock(buffer, capture);
          if (hooksActive) {
            if (outcome.action === "drop") {
              // skip
            } else if (outcome.action === "mutate") {
              controller.enqueue(utf8Encoder.encode(reconstructSseBlock(outcome.event)));
            } else {
              controller.enqueue(utf8Encoder.encode(buffer));
            }
          }
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
      harmonyLog: {
        enabled: HARMONY_LOG_ENABLED,
        path: HARMONY_LOG_PATH,
        contentMode: HARMONY_CONTENT_MODE,
      },
      hooksModule: process.env.CODEX_PROXY_HOOK_MODULE || null,
      profiles: profilesConfig
        ? { file: PROFILES_FILE, default: profilesConfig.default, names: Object.keys(profilesConfig.profiles) }
        : null,
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
      harmonyLog: {
        enabled: HARMONY_LOG_ENABLED,
        path: HARMONY_LOG_PATH,
        contentMode: HARMONY_CONTENT_MODE,
      },
      hooksModule: process.env.CODEX_PROXY_HOOK_MODULE || null,
      profiles: profilesConfig
        ? { file: PROFILES_FILE, default: profilesConfig.default, names: Object.keys(profilesConfig.profiles) }
        : null,
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

app.get("/debug/harmony", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 500, 100_000);
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const filters = {
    requestId: c.req.query("requestId"),
    sessionId: c.req.query("sessionId"),
    phase: c.req.query("phase"),
  };
  const filtered = records.filter((r) => {
    if (filters.requestId && r.requestId !== filters.requestId) return false;
    if (filters.sessionId && r.sessionId !== filters.sessionId) return false;
    if (filters.phase && r.phase !== filters.phase) return false;
    return true;
  });
  return c.json({
    enabled: HARMONY_LOG_ENABLED,
    path: HARMONY_LOG_PATH,
    filters,
    count: filtered.length,
    recordsRead: records.length,
    records: filtered,
  });
});

app.get("/debug/tiers", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 100_000);
  const sessionFilter = c.req.query("session");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);

  const totals: Record<string, { messages: number; bytes: number }> = {};
  const byHash: Record<string, { hash: string; tier: string | null; count: number; byteLen: number; firstAt: string | null; lastAt: string | null }> = {};
  let inputItemCount = 0;
  let scopedRequests = 0;

  for (const r of records) {
    if (sessionFilter && r.sessionId !== sessionFilter) continue;
    if (r.phase === "request.input_item") {
      inputItemCount += 1;
      const tier: string = (typeof r.tier === "string" ? r.tier : "unknown");
      const bucket = totals[tier] || { messages: 0, bytes: 0 };
      bucket.messages += 1;
      bucket.bytes += typeof r.byteLen === "number" ? r.byteLen : 0;
      totals[tier] = bucket;

      if (typeof r.contentHash === "string") {
        const key = r.contentHash;
        const entry = byHash[key] || { hash: key, tier, count: 0, byteLen: typeof r.byteLen === "number" ? r.byteLen : 0, firstAt: null, lastAt: null };
        entry.count += 1;
        entry.lastAt = r.at || entry.lastAt;
        if (!entry.firstAt) entry.firstAt = r.at || null;
        byHash[key] = entry;
      }
    }
    if (r.phase === "request.tier_summary") {
      scopedRequests += 1;
    }
  }

  const repeatedDeveloper = Object.values(byHash)
    .filter((e) => e.tier === "developer" && e.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);

  return c.json({
    sessionFilter: sessionFilter || null,
    inputItemCount,
    requestsObserved: scopedRequests,
    tiers: totals,
    repeatedDeveloperHashes: repeatedDeveloper,
    uniqueContentHashes: Object.keys(byHash).length,
  });
});

app.get("/debug/developer/diff", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 100_000);
  const sessionFilter = c.req.query("session");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);

  const seenHashes = new Set<string>();
  const sequence: Array<{ at: string; requestId: string; sessionId: string | null; index: number; contentHash: string; byteLen: number }> = [];

  for (const r of records) {
    if (r.phase !== "request.input_item") continue;
    if (r.tier !== "developer") continue;
    if (sessionFilter && r.sessionId !== sessionFilter) continue;
    if (typeof r.contentHash !== "string") continue;
    if (seenHashes.has(r.contentHash)) continue;
    seenHashes.add(r.contentHash);
    sequence.push({
      at: r.at,
      requestId: r.requestId,
      sessionId: r.sessionId ?? null,
      index: typeof r.index === "number" ? r.index : -1,
      contentHash: r.contentHash,
      byteLen: typeof r.byteLen === "number" ? r.byteLen : 0,
    });
  }

  return c.json({
    sessionFilter: sessionFilter || null,
    uniqueDeveloperMessages: sequence.length,
    sequence,
    note: "Each entry is the first appearance of a distinct developer-tier content hash. To see full content, set CODEX_PROXY_HARMONY_CONTENT=full and re-run; then query /debug/harmony with the requestId.",
  });
});

app.get("/debug/permissions", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 100_000);
  const sessionFilter = c.req.query("session");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);

  const bySession: Record<string, Array<{ at: string; requestId: string; sandboxMode: string | null; networkAccess: boolean | null; approvalPolicy: string | null; rawHash: string | null }>> = {};
  const all: Array<Record<string, any>> = [];

  for (const r of records) {
    if (r.phase !== "request.permissions_claim") continue;
    if (sessionFilter && r.sessionId !== sessionFilter) continue;
    const sess = r.sessionId || "unknown";
    const entry = {
      at: r.at,
      requestId: r.requestId,
      sandboxMode: r.sandboxMode ?? null,
      networkAccess: r.networkAccess ?? null,
      approvalPolicy: r.approvalPolicy ?? null,
      rawHash: r.rawHash ?? null,
    };
    bySession[sess] = bySession[sess] || [];
    bySession[sess].push(entry);
    all.push({ sessionId: r.sessionId ?? null, ...entry });
  }

  const latest: Record<string, any> = {};
  for (const [sess, entries] of Object.entries(bySession)) {
    latest[sess] = entries[entries.length - 1];
  }

  return c.json({
    sessionFilter: sessionFilter || null,
    count: all.length,
    latestBySession: latest,
    history: all,
  });
});

app.get("/debug/tools/catalog", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 1000, 50_000);
  const sessionFilter = c.req.query("session");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);

  let latest: Record<string, any> | null = null;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i];
    if (r.phase !== "request.tier_summary") continue;
    if (sessionFilter && r.sessionId !== sessionFilter) continue;
    latest = r;
    break;
  }

  return c.json({
    sessionFilter: sessionFilter || null,
    latest: latest
      ? {
          at: latest.at,
          requestId: latest.requestId,
          sessionId: latest.sessionId ?? null,
          toolCount: latest.toolCount ?? 0,
          toolByType: latest.toolByType ?? {},
          toolNames: latest.toolNames ?? [],
          toolChoice: latest.toolChoice ?? null,
          parallelToolCalls: latest.parallelToolCalls ?? null,
          reasoningEffort: latest.reasoningEffort ?? null,
          reasoningSummary: latest.reasoningSummary ?? null,
          promptCacheKey: latest.promptCacheKey ?? null,
          include: latest.include ?? null,
          textVerbosity: latest.textVerbosity ?? null,
          textFormatType: latest.textFormatType ?? null,
          store: latest.store ?? null,
          stream: latest.stream ?? null,
          clientInstallationId: latest.clientInstallationId ?? null,
          instructionsLen: latest.instructionsLen ?? null,
          instructionsHash: latest.instructionsHash ?? null,
          inputTiers: latest.inputTiers ?? {},
        }
      : null,
  });
});

function buildAnalysisByRequest(records: Record<string, any>[], filter: { sessionId?: string }) {
  const byReq = new Map<string, { requestId: string; sessionId: string | null; firstAt: string | null; lastAt: string | null; analysis: string[]; final: string[]; model: string | null; metadata: Record<string, any> | null; tokens: { input: number | null; output: number | null }; encryptedCount: number }>();
  for (const r of records) {
    if (filter.sessionId && r.sessionId !== filter.sessionId) continue;
    const rid = r.requestId;
    if (!rid) continue;
    let entry = byReq.get(rid);
    if (!entry) {
      entry = { requestId: rid, sessionId: r.sessionId ?? null, firstAt: null, lastAt: null, analysis: [], final: [], model: null, metadata: null, tokens: { input: null, output: null }, encryptedCount: 0 };
      byReq.set(rid, entry);
    }
    if (r.at) {
      if (!entry.firstAt) entry.firstAt = r.at;
      entry.lastAt = r.at;
    }
    if (r.phase === "response.channel_chunk" && r.channel === "analysis") {
      const s = (r.content ?? r.contentHead ?? "");
      if (s) entry.analysis.push(s);
    }
    if (r.phase === "response.channel_chunk" && r.channel === "final") {
      const s = (r.content ?? r.contentHead ?? "");
      if (s) entry.final.push(s);
    }
    if (r.phase === "response.completed") {
      entry.model = r.model || entry.model;
      entry.tokens.input = r.inputTokens ?? entry.tokens.input;
      entry.tokens.output = r.outputTokens ?? entry.tokens.output;
      entry.metadata = r.metadata || entry.metadata;
      entry.encryptedCount = r.encryptedReasoningCount ?? entry.encryptedCount;
    }
  }
  return [...byReq.values()].sort((a, b) => (a.firstAt || "").localeCompare(b.firstAt || ""));
}

app.get("/debug/analysis", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 100_000);
  const sessionFilter = c.req.query("session");
  const format = c.req.query("format") || "json";
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const turns = buildAnalysisByRequest(records, { sessionId: sessionFilter });

  if (format === "markdown" || format === "md") {
    const lines: string[] = [];
    lines.push(`# Analysis dump${sessionFilter ? ` (session ${sessionFilter})` : ""}`);
    lines.push("");
    for (const t of turns) {
      lines.push(`## ${t.firstAt || ""} · ${t.requestId} · ${t.model || "?"}`);
      lines.push(`tokens: in=${t.tokens.input ?? "?"} out=${t.tokens.output ?? "?"}  encrypted-reasoning-blocks: ${t.encryptedCount}`);
      if (t.metadata && Object.keys(t.metadata).length > 0) {
        lines.push(`metadata: \`${JSON.stringify(t.metadata)}\``);
      }
      lines.push("");
      const analysis = t.analysis.join("");
      const final = t.final.join("");
      if (analysis) {
        lines.push("### analysis (CoT)");
        lines.push(analysis);
        lines.push("");
      }
      if (final) {
        lines.push("### final");
        lines.push(final);
        lines.push("");
      }
      lines.push("---");
      lines.push("");
    }
    return new Response(lines.join("\n"), { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }

  return c.json({
    sessionFilter: sessionFilter || null,
    turns: turns.map((t) => ({
      requestId: t.requestId,
      sessionId: t.sessionId,
      firstAt: t.firstAt,
      lastAt: t.lastAt,
      model: t.model,
      tokens: t.tokens,
      metadata: t.metadata,
      encryptedReasoningCount: t.encryptedCount,
      analysis: t.analysis.join(""),
      analysisLen: t.analysis.reduce((acc, s) => acc + s.length, 0),
      final: t.final.join(""),
      finalLen: t.final.reduce((acc, s) => acc + s.length, 0),
    })),
    note: "analysis text is the streamed reasoning_summary the model emitted. With CODEX_PROXY_HARMONY_CONTENT=full set on the proxy, this is the COMPLETE plaintext CoT. With default 'head' mode, only the first 256 chars per chunk are stored. Re-start proxy with full mode for verbatim recall.",
  });
});

app.get("/debug/encrypted-reasoning", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 100_000);
  const sessionFilter = c.req.query("session");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);

  const items = records
    .filter((r) => r.phase === "response.encrypted_reasoning")
    .filter((r) => !sessionFilter || r.sessionId === sessionFilter);

  // Aggregate stats
  const ivSet = new Set<string>();
  let dupIvCount = 0;
  const ctSizes: number[] = [];
  const versions: Record<number, number> = {};
  const timestamps: number[] = [];
  for (const r of items) {
    const f = r.fernet;
    if (!f) continue;
    if (typeof f.ivHex === "string") {
      if (ivSet.has(f.ivHex)) dupIvCount += 1;
      ivSet.add(f.ivHex);
    }
    if (typeof f.ciphertextBytes === "number") ctSizes.push(f.ciphertextBytes);
    if (typeof f.version === "number") versions[f.version] = (versions[f.version] || 0) + 1;
    if (typeof f.timestamp === "number") timestamps.push(f.timestamp);
  }
  ctSizes.sort((a, b) => a - b);

  return c.json({
    sessionFilter: sessionFilter || null,
    count: items.length,
    summary: {
      versions,
      uniqueIvs: ivSet.size,
      duplicateIvs: dupIvCount,
      ivReuseDetected: dupIvCount > 0,
      ciphertextBytes: ctSizes.length > 0
        ? { min: ctSizes[0], median: ctSizes[Math.floor(ctSizes.length / 2)], max: ctSizes[ctSizes.length - 1] }
        : null,
      timestampRange: timestamps.length > 0
        ? { min: Math.min(...timestamps), max: Math.max(...timestamps), spanSec: Math.max(...timestamps) - Math.min(...timestamps) }
        : null,
    },
    items: items.slice(-200).map((r) => ({
      at: r.at,
      requestId: r.requestId,
      sessionId: r.sessionId,
      itemId: r.itemId,
      ...r.fernet,
    })),
    note: "Fernet structure parsed without decryption. Plaintext requires the 32-byte key, which is server-held and never sent to the client. Verifying HMAC tags requires the same key.",
  });
});

app.get("/debug/ratelimits", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 100_000);
  const sessionFilter = c.req.query("session");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);

  const snaps = records
    .filter((r) => r.phase === "response.rate_limit_snapshot")
    .filter((r) => !sessionFilter || r.sessionId === sessionFilter);

  const latestBySession: Record<string, any> = {};
  for (const r of snaps) {
    const sess = r.sessionId || "unknown";
    latestBySession[sess] = { at: r.at, requestId: r.requestId, status: r.status, snapshot: r.snapshot };
  }

  const latest = snaps[snaps.length - 1];
  let liveTimers: any = null;
  if (latest?.snapshot) {
    const s = latest.snapshot;
    const now = Math.floor(Date.now() / 1000);
    liveTimers = {
      capturedAt: latest.at,
      ageSeconds: latest.at ? Math.max(0, now - Math.floor(new Date(latest.at).getTime() / 1000)) : null,
      primaryResetsInSec: s.primary?.resetAt ? Math.max(0, s.primary.resetAt - now) : s.primary?.resetAfterSeconds,
      secondaryResetsInSec: s.secondary?.resetAt ? Math.max(0, s.secondary.resetAt - now) : s.secondary?.resetAfterSeconds,
    };
  }

  return c.json({
    sessionFilter: sessionFilter || null,
    count: snaps.length,
    latest: latest ? { at: latest.at, requestId: latest.requestId, sessionId: latest.sessionId, snapshot: latest.snapshot } : null,
    liveTimers,
    latestBySession,
    history: snaps.slice(-100),
  });
});

app.get("/debug/headers", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 100_000);
  const records = readNdjsonTail(API_JSON_LOG_PATH, limit);

  const headerKeys = new Map<string, { count: number; lastValue: string; lastAt: string }>();
  let phaseFilter = c.req.query("phase") || "response.headers";
  for (const r of records) {
    if (r.phase !== phaseFilter) continue;
    const h = r.headers || {};
    for (const [k, v] of Object.entries(h)) {
      const cur = headerKeys.get(k) || { count: 0, lastValue: "", lastAt: "" };
      cur.count += 1;
      cur.lastValue = String(v).slice(0, 200);
      cur.lastAt = r.at || cur.lastAt;
      headerKeys.set(k, cur);
    }
  }
  const sorted = [...headerKeys.entries()].sort((a, b) => b[1].count - a[1].count).map(([name, info]) => ({ name, ...info }));
  return c.json({
    phaseFilter,
    distinctHeaders: sorted.length,
    headers: sorted,
  });
});

app.get("/debug/auth-mode", async (c) => {
  // Diagnostic: shows current auth-mode state without ever leaking the key.
  const probe = resolveApiKey(null, null);  // env / file only (no profile context)
  const profilesWithApiKeyOverride = profilesConfig
    ? Object.entries(profilesConfig.profiles)
        .filter(([, def]) => def.authMode === "api_key" || (def.apiKey && def.apiKey.length > 0))
        .map(([name]) => name)
    : [];

  // Reflect oauth state without forcing a refresh (silent failure if not available)
  let oauth: Record<string, any> = { available: false };
  try {
    const state = await getStoredAuthInfo();
    oauth = {
      available: true,
      accountId: state.accountId,
      organizationId: state.organizationId,
      expiresAt: state.expiresAt > 0 ? new Date(state.expiresAt).toISOString() : null,
      authMode: state.authMode,
      scopes: state.scopes,
      path: getAuthPath(),
    };
  } catch (error) {
    oauth = { available: false, error: error instanceof Error ? error.message : String(error) };
  }

  const authFileMode = getAuthFileMode();
  const resolvedDefault = ENV_AUTH_MODE || authFileMode || "oauth";
  return c.json({
    defaultAuthMode: resolvedDefault,
    envAuthMode: ENV_AUTH_MODE,
    authFileMode,
    apiKey: probe
      ? {
          configured: true,
          source: probe.source,
          sourceDetail: probe.sourceDetail,
          preview: probe.preview,
          length: probe.length,
          loadedAt: probe.loadedAt,
        }
      : {
          configured: false,
          envSet: isApiKeyEnvSet(),
          filePath: getApiKeyFilePath(),
        },
    oauth,
    profilesWithApiKeyOverride,
  });
});

app.get("/debug/cot", async (c) => {
  // Reassembled chain-of-thought per request. Sources:
  //   - response.channel_chunk records with channel === "analysis"
  //   - per-request grouping with optional session/model filter
  const limit = parseLimit(c.req.query("limit"), 5000, 100_000);
  const sessionFilter = c.req.query("session");
  const modelFilter = c.req.query("model");
  const minBytes = Number.parseInt(c.req.query("min_bytes") || "0", 10) || 0;
  const includeFinal = (c.req.query("include_final") || "").toLowerCase() === "true";
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);

  type Row = {
    requestId: string;
    sessionId: string | null;
    path: string | null;
    model: string | null;
    firstAt: string | null;
    lastAt: string | null;
    analysis: string[];
    analysisBytes: number;
    final: string[];
    finalBytes: number;
    provider: string | null;
    stopReason: string | null;
  };
  const byReq = new Map<string, Row>();

  for (const r of records) {
    const rid = r.requestId;
    if (!rid || rid === "-") continue;
    if (sessionFilter && r.sessionId !== sessionFilter) continue;
    if (modelFilter && r.model !== modelFilter) continue;
    let row = byReq.get(rid);
    if (!row) {
      row = { requestId: rid, sessionId: r.sessionId ?? null, path: r.path ?? null, model: r.model ?? null,
              firstAt: null, lastAt: null, analysis: [], analysisBytes: 0, final: [], finalBytes: 0,
              provider: null, stopReason: null };
      byReq.set(rid, row);
    }
    if (r.at) {
      if (!row.firstAt || r.at < row.firstAt) row.firstAt = r.at;
      if (!row.lastAt || r.at > row.lastAt) row.lastAt = r.at;
    }
    if (r.phase === "response.channel_chunk") {
      const text = r.content || r.contentHead || "";
      if (r.channel === "analysis" && text) {
        row.analysis.push(text);
        row.analysisBytes += text.length;
      } else if (r.channel === "final" && text && includeFinal) {
        row.final.push(text);
        row.finalBytes += text.length;
      }
      if (r.model && !row.model) row.model = r.model;
    } else if (r.phase === "response.envelope_captured" && r.envelope) {
      if (r.envelope.openrouterProvider) row.provider = r.envelope.openrouterProvider;
    } else if (r.phase === "response.completed") {
      if (r.stopReason) row.stopReason = r.stopReason;
      if (r.model && !row.model) row.model = r.model;
    }
  }

  const rows = [...byReq.values()]
    .filter((r) => r.analysisBytes >= minBytes)
    .sort((a, b) => (b.lastAt || "").localeCompare(a.lastAt || ""));

  const totalBytes = rows.reduce((acc, r) => acc + r.analysisBytes, 0);
  return c.json({
    sessionFilter: sessionFilter || null,
    modelFilter: modelFilter || null,
    minBytes,
    includeFinal,
    requestCount: rows.length,
    totalAnalysisBytes: totalBytes,
    rows: rows.slice(0, 100).map((r) => ({
      requestId: r.requestId,
      sessionId: r.sessionId,
      path: r.path,
      model: r.model,
      firstAt: r.firstAt,
      lastAt: r.lastAt,
      stopReason: r.stopReason,
      provider: r.provider,
      analysisBytes: r.analysisBytes,
      finalBytes: r.finalBytes,
      analysis: r.analysis.join(""),
      final: includeFinal ? r.final.join("") : undefined,
    })),
  });
});

app.get("/debug/envelopes", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 100_000);
  const sessionFilter = c.req.query("session");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);

  const envs = records.filter((r) => {
    if (r.phase !== "response.envelope_captured") return false;
    if (sessionFilter && r.sessionId !== sessionFilter) return false;
    return true;
  });

  const tier = new Map<string, number>();
  const safetyId = new Map<string, number>();
  const truncation = new Map<string, number>();
  const reasoningEffort = new Map<string, number>();
  const verbosity = new Map<string, number>();
  let storeTrue = 0, storeFalse = 0;
  let parallelTrue = 0, parallelFalse = 0;
  let withModeration = 0;
  let withPreviousResponse = 0;
  let withToolUsage = 0;
  const reasoningMode = new Map<string, number>();
  const openrouterProvider = new Map<string, number>();
  const latestBySession: Record<string, any> = {};

  const bump = (m: Map<string, number>, k: string | null | undefined) => {
    if (k === null || k === undefined) return;
    const key = String(k);
    m.set(key, (m.get(key) || 0) + 1);
  };

  for (const r of envs) {
    const e = r.envelope || {};
    bump(tier, e.serviceTier);
    bump(safetyId, e.safetyIdentifier);
    bump(truncation, e.truncation);
    bump(reasoningEffort, e.reasoningEffort);
    bump(verbosity, e.textVerbosity);
    bump(reasoningMode, e.reasoningMode);
    bump(openrouterProvider, e.openrouterProvider);
    if (e.store === true) storeTrue++;
    else if (e.store === false) storeFalse++;
    if (e.parallelToolCalls === true) parallelTrue++;
    else if (e.parallelToolCalls === false) parallelFalse++;
    if (e.moderation) withModeration++;
    if (e.previousResponseId) withPreviousResponse++;
    if (e.toolUsage) withToolUsage++;

    const sess = r.sessionId || "unknown";
    latestBySession[sess] = { at: r.at, requestId: r.requestId, responseId: r.responseId, stopReason: r.stopReason, envelope: e };
  }

  return c.json({
    sessionFilter: sessionFilter || null,
    total: envs.length,
    countsByServiceTier: Object.fromEntries([...tier.entries()].sort((a, b) => b[1] - a[1])),
    countsBySafetyIdentifier: Object.fromEntries([...safetyId.entries()].sort((a, b) => b[1] - a[1])),
    countsByTruncation: Object.fromEntries([...truncation.entries()].sort((a, b) => b[1] - a[1])),
    countsByReasoningEffort: Object.fromEntries([...reasoningEffort.entries()].sort((a, b) => b[1] - a[1])),
    countsByTextVerbosity: Object.fromEntries([...verbosity.entries()].sort((a, b) => b[1] - a[1])),
    countsByReasoningMode: Object.fromEntries([...reasoningMode.entries()].sort((a, b) => b[1] - a[1])),
    countsByOpenrouterProvider: Object.fromEntries([...openrouterProvider.entries()].sort((a, b) => b[1] - a[1])),
    storeTrue, storeFalse,
    parallelToolCallsTrue: parallelTrue, parallelToolCallsFalse: parallelFalse,
    withModeration,
    withPreviousResponseId: withPreviousResponse,
    withToolUsage,
    latestBySession,
    latest: envs.slice(-50).reverse(),
  });
});

app.get("/debug/refusals", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 100_000);
  const sessionFilter = c.req.query("session");
  const divergentOnly = (c.req.query("divergent_only") || "").toLowerCase() === "true";
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);

  const refusals = records.filter((r) => {
    if (r.phase !== "response.refusal_detected") return false;
    if (sessionFilter && r.sessionId !== sessionFilter) return false;
    if (divergentOnly && !r.divergence?.divergent) return false;
    return true;
  });

  const byPattern = new Map<string, number>();
  const byReason = new Map<string, number>();
  let divergentCount = 0;
  for (const r of refusals) {
    for (const p of (r.refusal?.patterns || [])) {
      byPattern.set(p, (byPattern.get(p) || 0) + 1);
    }
    const reason = r.divergence?.reason || "n/a";
    byReason.set(reason, (byReason.get(reason) || 0) + 1);
    if (r.divergence?.divergent) divergentCount++;
  }

  return c.json({
    sessionFilter: sessionFilter || null,
    divergentOnly,
    total: refusals.length,
    divergentCount,
    countsByPattern: Object.fromEntries([...byPattern.entries()].sort((a, b) => b[1] - a[1])),
    countsByDivergenceReason: Object.fromEntries([...byReason.entries()].sort((a, b) => b[1] - a[1])),
    latest: refusals.slice(-50).reverse(),
  });
});

app.get("/debug/blocked", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 100_000);
  const sessionFilter = c.req.query("session");
  const cyberOnly = (c.req.query("cyber_only") || "").toLowerCase() === "true";
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);

  const errors = records.filter((r) => {
    if (r.phase !== "response.error_event" && r.phase !== "response.cyber_policy_blocked") return false;
    if (sessionFilter && r.sessionId !== sessionFilter) return false;
    if (cyberOnly && !r.cyberPolicy && r.phase !== "response.cyber_policy_blocked") return false;
    return true;
  });

  const byCode = new Map<string, number>();
  const bySession = new Map<string, number>();
  let cyberCount = 0;
  for (const r of errors) {
    if (r.phase === "response.error_event") {
      const code = r.code || "unknown";
      byCode.set(code, (byCode.get(code) || 0) + 1);
    }
    const sess = r.sessionId || "unknown";
    bySession.set(sess, (bySession.get(sess) || 0) + 1);
    if (r.phase === "response.cyber_policy_blocked" || r.cyberPolicy) cyberCount++;
  }

  return c.json({
    sessionFilter: sessionFilter || null,
    cyberOnly,
    total: errors.length,
    cyberPolicyBlocks: cyberCount,
    countsByCode: Object.fromEntries([...byCode.entries()].sort((a, b) => b[1] - a[1])),
    countsBySession: Object.fromEntries([...bySession.entries()].sort((a, b) => b[1] - a[1])),
    latest: errors.slice(-50).reverse(),
  });
});

app.get("/debug/injections", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 5000, 100_000);
  const sessionFilter = c.req.query("session");
  const minSeverity = c.req.query("severity");
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);

  const SEV_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
  const minRank = minSeverity ? (SEV_RANK[minSeverity] || 0) : 0;

  const detections = records.filter((r) => {
    if (r.phase !== "request.injection_detected") return false;
    if (sessionFilter && r.sessionId !== sessionFilter) return false;
    if (minRank && (SEV_RANK[r.severity] || 0) < minRank) return false;
    return true;
  });

  const byRule: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const bySession: Record<string, number> = {};
  for (const r of detections) {
    byRule[r.rule] = (byRule[r.rule] || 0) + 1;
    bySeverity[r.severity] = (bySeverity[r.severity] || 0) + 1;
    const s = r.sessionId || "unknown";
    bySession[s] = (bySession[s] || 0) + 1;
  }

  return c.json({
    sessionFilter: sessionFilter || null,
    minSeverity: minSeverity || null,
    count: detections.length,
    byRule,
    bySeverity,
    bySession,
    recent: detections.slice(-200),
  });
});

app.get("/debug/profiles", async (c) => {
  if (!profilesConfig) {
    return c.json({ enabled: false, message: "CODEX_PROXY_PROFILES_FILE not set" });
  }
  return c.json({
    enabled: true,
    file: PROFILES_FILE,
    default: profilesConfig.default,
    identifyBy: profilesConfig.identifyBy,
    profiles: Object.fromEntries(
      Object.entries(profilesConfig.profiles).map(([n, def]) => [n, summarizeProfile(n, def)]),
    ),
  });
});

app.get("/debug/profiles/check", async (c) => {
  if (!profilesConfig) return c.json({ enabled: false }, 404);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) {
    if (k.startsWith("header.") && typeof v === "string") {
      headers[k.slice("header.".length).toLowerCase()] = v;
    }
  }
  const remoteIp = c.req.query("remote") || null;

  const profile = identifyProfile(profilesConfig, { headers, remoteIp });
  return c.json({
    headersConsidered: headers,
    remoteIp,
    resolved: {
      name: profile.name,
      matchedBy: profile.matchedBy,
      summary: summarizeProfile(profile.name, profile.def),
    },
  });
});

app.get("/debug/profiles/:name", async (c) => {
  if (!profilesConfig) return c.json({ enabled: false }, 404);
  const name = c.req.param("name");
  const def = profilesConfig.profiles[name];
  if (!def) return c.json({ error: "not_found", name }, 404);
  return c.json({ name, summary: summarizeProfile(name, def), full: def });
});

app.get("/debug/profiles/:name/activity", async (c) => {
  if (!profilesConfig) return c.json({ enabled: false }, 404);
  const name = c.req.param("name");
  if (!profilesConfig.profiles[name]) return c.json({ error: "not_found", name }, 404);

  const limit = parseLimit(c.req.query("limit"), 5000, 100_000);
  const records = readNdjsonTail(HARMONY_LOG_PATH, limit);
  const filtered = records.filter((r) =>
    (r.phase === "request.profile_applied" || r.phase === "request.profile_rejected" || r.phase === "request.profile_rate_limited" || r.phase === "response.profile_channel_dropped")
    && r.profile === name);

  const summary = {
    applied: 0,
    rejected: 0,
    rateLimited: 0,
    channelsDropped: 0,
    demotedTotal: 0,
    toolsRemovedTotal: 0,
  };
  for (const r of filtered) {
    if (r.phase === "request.profile_applied") {
      summary.applied += 1;
      summary.demotedTotal += typeof r.demoted === "number" ? r.demoted : 0;
      summary.toolsRemovedTotal += Array.isArray(r.toolsRemoved) ? r.toolsRemoved.length : 0;
    } else if (r.phase === "request.profile_rejected") {
      summary.rejected += 1;
    } else if (r.phase === "request.profile_rate_limited") {
      summary.rateLimited += 1;
    } else if (r.phase === "response.profile_channel_dropped") {
      summary.channelsDropped += 1;
    }
  }

  return c.json({
    profile: name,
    count: filtered.length,
    summary,
    recent: filtered.slice(-100),
  });
});

app.get("/debug/channels/live", async (c) => {
  const channelsParam = (c.req.query("channels") || "final,analysis,commentary").toLowerCase();
  const wanted = new Set(channelsParam.split(",").map((s) => s.trim()).filter(Boolean));
  const sessionFilter = c.req.query("session");

  let lastSize = 0;
  if (existsSync(HARMONY_LOG_PATH)) {
    try {
      lastSize = readFileSync(HARMONY_LOG_PATH, "utf8").length;
    } catch {
      lastSize = 0;
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(`: live channel feed channels=${[...wanted].join(",")}\n\n`));

      const interval = setInterval(() => {
        try {
          if (!existsSync(HARMONY_LOG_PATH)) return;
          const content = readFileSync(HARMONY_LOG_PATH, "utf8");
          if (content.length <= lastSize) return;
          const fresh = content.slice(lastSize);
          lastSize = content.length;
          for (const line of fresh.split("\n")) {
            if (!line) continue;
            let r: Record<string, any>;
            try { r = JSON.parse(line); } catch { continue; }
            if (r.phase !== "response.channel_chunk" && r.phase !== "response.tool_call.delta" && r.phase !== "response.tool_call.done") continue;
            if (sessionFilter && r.sessionId !== sessionFilter) continue;
            const ch = typeof r.channel === "string" ? r.channel : "";
            if (!wanted.has(ch)) continue;
            controller.enqueue(enc.encode(`event: ${r.phase}\ndata: ${JSON.stringify(r)}\n\n`));
          }
        } catch (error) {
          // continue silently — file may be transiently missing
          void error;
        }
      }, 250);

      const heartbeat = setInterval(() => {
        try { controller.enqueue(enc.encode(`: keepalive ${new Date().toISOString()}\n\n`)); } catch { /* closed */ }
      }, 15000);

      const cleanup = () => { clearInterval(interval); clearInterval(heartbeat); };
      c.req.raw.signal?.addEventListener?.("abort", cleanup);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
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
  let requestBody = decodeRequestBody(c.req.raw.headers, rawBody);
  apiJsonLog({
    phase: "request.received",
    requestId,
    method: c.req.method,
    path: sourceUrl.pathname,
    search: sourceUrl.search,
    headers: headersForLog(c.req.raw.headers),
    body: bodyForLog(c.req.raw.headers, requestBody),
  });

  // Profile identification FIRST so that authMode-driven upstream routing works.
  let identifiedProfile: IdentifiedProfile | null = null;
  if (profilesConfig) {
    const headersFlat: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => { headersFlat[k.toLowerCase()] = v; });
    const remoteIp = c.req.raw.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    identifiedProfile = identifyProfile(profilesConfig, { headers: headersFlat, remoteIp });
    requestProfileMap.set(requestId, identifiedProfile);

    const rate = checkRateLimit(rateLimitStore, identifiedProfile.name, identifiedProfile.def.rateLimit);
    if (!rate.allowed) {
      stats.activeRequests -= 1;
      harmonyEventLog({
        phase: "request.profile_rate_limited",
        requestId,
        profile: identifiedProfile.name,
        matchedBy: identifiedProfile.matchedBy,
        resetIn: rate.resetIn,
      });
      return c.json({
        error: "rate_limited",
        profile: identifiedProfile.name,
        message: `profile ${identifiedProfile.name} exceeded rate limit (${identifiedProfile.def.rateLimit})`,
        resetInMs: rate.resetIn,
      }, 429);
    }

    if (hasBody(c.req.method)) {
      const preParsed = parseJsonBody(c.req.raw.headers, requestBody);
      if (preParsed) {
        try {
          const result = applyProfileGates(preParsed, identifiedProfile);
          requestBody = encoder.encode(JSON.stringify(result.body));
          harmonyEventLog({
            phase: "request.profile_applied",
            requestId,
            profile: identifiedProfile.name,
            matchedBy: identifiedProfile.matchedBy,
            demoted: result.demoted,
            toolsRemoved: result.toolsRemoved,
            contentTruncatedBytes: result.contentTruncated,
            prefixInjected: result.prefixInjected,
            bodyOverridesApplied: result.bodyOverridesApplied,
            instructionsMutation: result.instructionsMutation,
            developerBlocksDropped: result.developerBlocksDropped,
            systemMessageMutation: result.systemMessageMutation,
            toolsStripped: result.toolsStripped,
            toolChoiceForced: result.toolChoiceForced,
            historyStuffed: result.historyStuffed,
            toolDescriptionsMutated: result.toolDescriptionsMutated,
            userPrefixApplied: result.userPrefixApplied,
            phantomToolCallsInjected: result.phantomToolCallsInjected,
            rateRemaining: rate.remaining,
          });
        } catch (error) {
          stats.activeRequests -= 1;
          if (error instanceof ProfileError) {
            harmonyEventLog({
              phase: "request.profile_rejected",
              requestId,
              profile: identifiedProfile.name,
              reason: error.reason,
            });
            return c.json({ error: "profile_rejected", profile: identifiedProfile.name, message: error.reason }, error.status);
          }
          throw error;
        }
      }
    }
  }

  // Now that the profile is known, compute upstream routing. authMode: "api_key" on
  // the active profile forces "openai" mode regardless of path/header — so Codex CLI
  // traffic to /v1/responses routes to api.openai.com instead of chatgpt.com.
  const upstreamMode = upstreamModeForRequest(sourceUrl, c.req.raw.headers, identifiedProfile);
  const authMode = resolveAuthMode(identifiedProfile);

  // For api_key mode, resolve the key (profile > file > env). Fail-fast if absent so
  // we don't make an unauthenticated upstream call.
  let injectedApiKey: ApiKeyResolution | null = null;
  if (authMode === "api_key") {
    injectedApiKey = resolveApiKey(identifiedProfile?.def.apiKey || null, identifiedProfile?.name || null);
    if (!injectedApiKey) {
      stats.activeRequests -= 1;
      harmonyEventLog({
        phase: "request.api_key_missing",
        requestId,
        profile: identifiedProfile?.name || null,
      });
      return c.json({
        error: "api_key_missing",
        message: "authMode is api_key but no API key is configured. Set OPENAI_API_KEY or CODEX_PROXY_API_KEY_FILE, or put an apiKey on the profile.",
      }, 503);
    }
    harmonyEventLog({
      phase: "request.api_key_resolved",
      requestId,
      profile: identifiedProfile?.name || null,
      source: injectedApiKey.sourceDetail,
      preview: injectedApiKey.preview,
    });
  }

  if (upstreamMode === "openai") {
    // Use the same body-prep pipeline as the codex branch but with upstreamMode
    // so DEFAULT_INSTRUCTIONS isn't injected for api.openai.com targets.
    const prepared = prepareRequest(c.req.url, c.req.raw.headers, requestBody, "openai");
    const summary = prepared.summary;
    const sessionId = prepared.sessionId;
    const parsedBody = prepared.parsedBody;
    const finalRequestBody = prepared.body;
    const headers = buildOpenAIHeaders(c.req.raw.headers, injectedApiKey?.key || null);
    const upstreamUrl = buildOpenAIUpstreamUrl(c.req.url);
    const upstreamParsedUrl = new URL(upstreamUrl);

    requestLog(requestId, c.req.method, c.req.url, c.req.raw.headers, prepared);

    if (parsedBody) {
      const inspection = inspectInput(parsedBody);
      emitInputObservability(requestId, sessionId, sourceUrl.pathname, inspection);
    }

    console.log(
      `[proxy] ${c.req.method} ${c.req.path} upstream=openai model=${summary.model} stream=${summary.stream} session=${sessionId || "-"}`,
    );

    try {
      apiJsonLog({
        phase: "request.forwarded",
        requestId,
        method: c.req.method,
        path: sourceUrl.pathname,
        upstreamMode,
        upstreamPath: upstreamParsedUrl.pathname,
        upstreamSearch: upstreamParsedUrl.search,
        model: summary.model,
        stream: summary.stream,
        sessionId,
        headers: headersForLog(headers),
        body: bodyForLog(c.req.raw.headers, finalRequestBody),
      });

      const init: RequestInit & { duplex?: "half" } = {
        method: c.req.method,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      };

      if (finalRequestBody) {
        init.body = finalRequestBody;
        init.duplex = "half";
      }

      const upstream = await fetch(upstreamUrl, init);
      const responseHeaders = stripResponseHeaders(upstream.headers);
      const isSse = summary.stream
        || responseHeaders.get("content-type")?.includes("text/event-stream")
        || false;

      apiJsonLog({
        phase: "response.headers",
        requestId,
        path: sourceUrl.pathname,
        upstreamMode,
        upstreamPath: upstreamParsedUrl.pathname,
        model: summary.model,
        stream: isSse,
        sessionId,
        status: upstream.status,
        statusText: upstream.statusText,
        headers: headersForLog(upstream.headers),
      });

      if (!upstream.ok) {
        const preview = await upstream.clone().text();
        console.error(`[proxy] upstream ${upstream.status} ${upstreamUrl}: ${preview.slice(0, 400)}`);
        if (DEBUG_REQUESTS) {
          console.error(`[proxy] request headers ${JSON.stringify(headerPreview(c.req.raw.headers))}`);
          const requestPreview = bodyPreview(c.req.raw.headers, finalRequestBody);
          if (requestPreview) {
            console.error(`[proxy] request preview ${requestPreview}`);
          }
        }
      }

      return new Response(
        isSse && upstream.body
          ? interceptStream(upstream.body, summary.model, {
            requestId,
            path: c.req.path,
            sessionId,
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
      console.error(`[proxy] ${c.req.method} ${c.req.path} upstream=openai failed: ${message}`);
      return c.json({ error: "proxy_error", message }, 502);
    } finally {
      stats.activeRequests -= 1;
      requestProfileMap.delete(requestId);
    }
  }

  if (hooks.onRequest) {
    const preParsed = parseJsonBody(c.req.raw.headers, requestBody);
    if (preParsed) {
      try {
        const sessionIdEarly = extractSessionId(new URL(c.req.url), c.req.raw.headers, preParsed);
        const result = await hooks.onRequest(preParsed, {
          path: sourceUrl.pathname,
          method: c.req.method,
          sessionId: sessionIdEarly,
        });
        if (result && result !== preParsed) {
          requestBody = encoder.encode(JSON.stringify(result));
          harmonyEventLog({
            phase: "request.hook_mutated",
            requestId,
            sessionId: sessionIdEarly,
            path: sourceUrl.pathname,
          });
        }
      } catch (error) {
        console.error(`[proxy] onRequest hook failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const prepared = prepareRequest(c.req.url, c.req.raw.headers, requestBody);
  requestLog(requestId, c.req.method, c.req.url, c.req.raw.headers, prepared);

  if (prepared.parsedBody) {
    const inspection = inspectInput(prepared.parsedBody);
    emitInputObservability(requestId, prepared.sessionId, sourceUrl.pathname, inspection);
  }

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
    );
    const upstreamUrl = buildUpstreamUrl(c.req.url, prepared.sessionId);
    const upstreamParsedUrl = new URL(upstreamUrl);
    apiJsonLog({
      phase: "request.forwarded",
      requestId,
      method: c.req.method,
      path: sourceUrl.pathname,
      upstreamMode,
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

    let upstream = await fetch(upstreamUrl, init);

    // Auto-recover from upstream token revocation (one retry).
    if (upstream.status === 401) {
      const errPreview = await upstream.clone().text();
      if (/token_revoked|invalidated oauth|invalid_grant/i.test(errPreview)) {
        harmonyEventLog({
          phase: "upstream.token_revoked_retry",
          requestId,
          sessionId: prepared.sessionId,
          path: sourceUrl.pathname,
        });
        try {
          const fresh = await invalidateAndRefresh();
          const retryHeaders = buildHeaders(c.req.raw.headers, fresh.accessToken, fresh.accountId, prepared.sessionId);
          const retryInit: RequestInit & { duplex?: "half" } = {
            method: c.req.method,
            headers: retryHeaders,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          };
          if (prepared.body) {
            retryInit.body = prepared.body;
            retryInit.duplex = "half";
          }
          upstream = await fetch(upstreamUrl, retryInit);
        } catch (err) {
          console.error(`[proxy] token-revoked refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

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
      headers: headersForLog(upstream.headers),  // log full upstream header set, not stripped
    });

    // Parse rate-limit snapshot if present (chatgpt.com/codex sends x-codex-* on every response).
    const rateSnapshot = parseRateLimitHeaders(upstream.headers);
    if (rateSnapshot) {
      harmonyEventLog({
        phase: "response.rate_limit_snapshot",
        requestId,
        sessionId: prepared.sessionId,
        path: sourceUrl.pathname,
        status: upstream.status,
        snapshot: rateSnapshot,
      });
    }

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
    // Profile snapshot lives in ChannelCapture for SSE streams; safe to drop the live map entry now.
    requestProfileMap.delete(requestId);
  }
});

export async function startServer(options: { port: number; host: string }) {
  hooks = await loadHooks();

  if (PROFILES_FILE) {
    try {
      profilesConfig = loadProfilesConfig(PROFILES_FILE);
      const names = Object.keys(profilesConfig.profiles);
      console.log(`[proxy] loaded profiles from ${PROFILES_FILE}: ${names.join(", ")} (default=${profilesConfig.default})`);
    } catch (error) {
      console.error(`[proxy] failed to load profiles from ${PROFILES_FILE}: ${error instanceof Error ? error.message : String(error)}`);
      profilesConfig = null;
    }
  }

  const server = Bun.serve({
    port: options.port,
    hostname: options.host,
    idleTimeout: 255,
    fetch: app.fetch,
  });

  console.log(`[proxy] listening on http://${options.host}:${server.port}`);
  return server;
}

export function setProfilesConfigForTest(next: ProfileConfig | null) {
  profilesConfig = next;
  rateLimitStore.clear();
  requestProfileMap.clear();
}

export function setHooksForTest(next: Hooks) {
  hooks = next;
}

export const __test = {
  buildAnalysisByRequest,
  buildHeaders,
  buildOpenAIHeaders,
  buildOpenAIUpstreamUrl,
  buildTranscript,
  buildUpstreamUrl,
  channelForEventType,
  detectRefusal,
  divergenceVerdict,
  extractErrorFields,
  headersForLog,
  inspectInput,
  interceptStream,
  isCyberPolicyCode,
  mergeResponseEnvelope,
  parseRateLimitHeaders,
  normalizeOpenAIPath,
  normalizeReasoningSummary,
  normalizeUpstreamPath,
  parsePermissionsBlock,
  prepareRequest,
  resolveApiKey,
  resolveAuthMode,
  setHooksForTest,
  setProfilesConfigForTest,
  stripResponseHeaders,
  upstreamModeForRequest,
  tierForInputItem,
  upstreamModeForRequest,
};
