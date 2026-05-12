import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testDir = mkdtempSync(join(tmpdir(), "codex-proxy-test-"));
const thinkingLog = join(testDir, "thinking.log");
const rawEventLog = join(testDir, "events.ndjson");
const requestLog = join(testDir, "requests.ndjson");
const apiJsonLog = join(testDir, "api-json.ndjson");
const harmonyLog = join(testDir, "harmony.ndjson");

process.env.CODEX_PROXY_THINKING_LOG_FILE = thinkingLog;
process.env.CODEX_PROXY_RAW_EVENT_LOG_FILE = rawEventLog;
process.env.CODEX_PROXY_REQUEST_LOG_FILE = requestLog;
process.env.CODEX_PROXY_API_JSON_LOG_FILE = apiJsonLog;
process.env.CODEX_PROXY_HARMONY_LOG_FILE = harmonyLog;
process.env.CODEX_PROXY_HARMONY_CONTENT = "head";
// Ensure auth-mode tests run against a clean env regardless of operator settings
delete process.env.OPENAI_API_KEY;
delete process.env.CODEX_PROXY_API_KEY_FILE;
delete process.env.CODEX_PROXY_AUTH_MODE;
// Tests assert hardcoded default upstream URLs (chatgpt.com, api.openai.com).
// The module reads CODEX_PROXY_*_UPSTREAM_* env vars at import time; if the operator
// has them set (e.g. CODEX_PROXY_OPENAI_UPSTREAM_ORIGIN=https://openrouter.ai/api for
// OpenRouter mode), the tests fail. Scrub them so the suite is hermetic.
delete process.env.CODEX_PROXY_UPSTREAM_ORIGIN;
delete process.env.CODEX_PROXY_UPSTREAM_BASE_PATH;
delete process.env.CODEX_PROXY_OPENAI_UPSTREAM_ORIGIN;
delete process.env.CODEX_PROXY_OPENAI_UPSTREAM_BASE_PATH;
// Point auth at a nonexistent file so the resolver doesn't pick up the operator's real auth.json
process.env.CODEX_PROXY_AUTH_FILE = join(testDir, "nonexistent-auth.json");

const { __test } = await import("./server");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonBody(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function decodeJsonBody(body: ArrayBuffer | Uint8Array | undefined): Record<string, any> {
  expect(body).toBeDefined();
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body!);
  return JSON.parse(decoder.decode(bytes));
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  return chunks.map((chunk) => decoder.decode(chunk)).join("");
}

function sse(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

beforeAll(() => {
  rmSync(thinkingLog, { force: true });
  rmSync(rawEventLog, { force: true });
  rmSync(requestLog, { force: true });
  rmSync(apiJsonLog, { force: true });
  rmSync(harmonyLog, { force: true });
});

function readHarmony(): Record<string, any>[] {
  if (!existsSync(harmonyLog)) return [];
  return readFileSync(harmonyLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("request preparation", () => {
  test("normalizes Responses API JSON for the ChatGPT Codex backend", () => {
    const body = jsonBody({
      model: "gpt-5.5",
      input: "hello",
      stream: true,
      session_id: "session-123",
      reasoning: { effort: "high", summary: "none" },
      include: ["reasoning.encrypted_content"],
    });
    const headers = new Headers({
      "content-type": "application/json",
      "accept": "text/event-stream",
    });

    const prepared = __test.prepareRequest("http://127.0.0.1:3462/v1/responses?session_id=session-123", headers, body);
    const parsed = decodeJsonBody(prepared.body);

    expect(prepared.sessionId).toBe("session-123");
    expect(parsed.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);
    expect(parsed.instructions).toBeString();
    expect(parsed.store).toBe(false);
    expect(parsed.reasoning).toEqual({ effort: "high", summary: "detailed" });
    expect(parsed.include).toEqual(["reasoning.encrypted_content"]);
    expect(parsed.session_id).toBeUndefined();
  });

  test("injects reasoning.effort='medium' when client sends reasoning without effort (OpenRouter compat)", () => {
    const body = jsonBody({
      model: "gpt-5.1-codex-max",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      // Codex CLI sometimes sends summary without effort — OpenAI direct rejects this
      reasoning: { summary: "detailed" },
    });
    const headers = new Headers({ "content-type": "application/json", "accept": "text/event-stream" });
    const prepared = __test.prepareRequest("http://127.0.0.1:3462/v1/responses", headers, body);
    const parsed = decodeJsonBody(prepared.body);
    expect(parsed.reasoning.effort).toBe("medium");
    expect(parsed.reasoning.summary).toBe("detailed");
  });

  test("preserves caller-supplied reasoning.effort (no override)", () => {
    const body = jsonBody({
      model: "gpt-5.5",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      reasoning: { effort: "xhigh", summary: "detailed" },
    });
    const headers = new Headers({ "content-type": "application/json", "accept": "text/event-stream" });
    const prepared = __test.prepareRequest("http://127.0.0.1:3462/v1/responses", headers, body);
    const parsed = decodeJsonBody(prepared.body);
    expect(parsed.reasoning.effort).toBe("xhigh");
    expect(parsed.reasoning.summary).toBe("detailed");
  });

  test("does NOT inject reasoning.effort when reasoning field is absent (lets endpoint default)", () => {
    const body = jsonBody({
      model: "gpt-5.5",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      // No reasoning field at all
    });
    const headers = new Headers({ "content-type": "application/json", "accept": "text/event-stream" });
    const prepared = __test.prepareRequest("http://127.0.0.1:3462/v1/responses", headers, body);
    const parsed = decodeJsonBody(prepared.body);
    // FORCE_REASONING_SUMMARY adds {summary} so reasoning will exist; effort gets defaulted
    expect(parsed.reasoning?.summary).toBe("detailed");
    expect(parsed.reasoning?.effort).toBe("medium");
  });

  test("strips top-level backend-rejected fields (client_metadata, max_output_tokens, max_completion_tokens)", () => {
    const body = jsonBody({
      model: "gpt-5.5",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      client_metadata: { "x-codex-installation-id": "abc" },
      max_output_tokens: 1000,
      max_completion_tokens: 500,
    });
    const headers = new Headers({ "content-type": "application/json", "accept": "text/event-stream" });
    const prepared = __test.prepareRequest("http://127.0.0.1:3462/v1/responses", headers, body);
    const parsed = decodeJsonBody(prepared.body);
    expect(parsed).not.toHaveProperty("client_metadata");
    expect(parsed).not.toHaveProperty("max_output_tokens");
    expect(parsed).not.toHaveProperty("max_completion_tokens");
    // unrelated fields preserved
    expect(parsed.model).toBe("gpt-5.5");
    expect(parsed.input[0].content[0].text).toBe("hi");
  });

  test("strips backend-rejected fields on /responses/compact too", () => {
    const body = jsonBody({
      model: "gpt-5.5",
      input: [{ role: "user", content: [{ type: "input_text", text: "x" }] }],
      client_metadata: { foo: "bar" },
      max_output_tokens: 100,
    });
    const headers = new Headers({ "content-type": "application/json" });
    const prepared = __test.prepareRequest("http://127.0.0.1:3462/v1/responses/compact", headers, body);
    const parsed = decodeJsonBody(prepared.body);
    expect(parsed).not.toHaveProperty("client_metadata");
    expect(parsed).not.toHaveProperty("max_output_tokens");
  });

  test("scrubs phase + remaps output_text → input_text on echoed input items", () => {
    const body = jsonBody({
      model: "gpt-5.5",
      stream: true,
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", type: "message", phase: "final_answer", content: [
          { type: "output_text", text: "prior turn", logprobs: [], annotations: [] },
        ]},
        { role: "user", content: [
          { type: "output_text", text: "echoed back", obfuscation: "xx" },
          { type: "input_text", text: "current turn" },
        ]},
      ],
    });
    const headers = new Headers({ "content-type": "application/json", "accept": "text/event-stream" });
    const prepared = __test.prepareRequest("http://127.0.0.1:3462/v1/responses", headers, body);
    const parsed = decodeJsonBody(prepared.body);

    // phase removed from item 1
    expect(parsed.input[1]).not.toHaveProperty("phase");
    // output_text → input_text on item 1's content
    expect(parsed.input[1].content[0].type).toBe("input_text");
    expect(parsed.input[1].content[0].text).toBe("prior turn");
    // logprobs / annotations stripped
    expect(parsed.input[1].content[0]).not.toHaveProperty("logprobs");
    expect(parsed.input[1].content[0]).not.toHaveProperty("annotations");
    // mixed content array also remapped
    expect(parsed.input[2].content[0].type).toBe("input_text");
    expect(parsed.input[2].content[0]).not.toHaveProperty("obfuscation");
    // input_text passes through untouched
    expect(parsed.input[2].content[1].type).toBe("input_text");
    // first item (already clean) untouched
    expect(parsed.input[0].content[0].type).toBe("input_text");
  });

  test("scrubs phase on /responses/compact path too", () => {
    const body = jsonBody({
      model: "gpt-5.5",
      input: [
        { role: "assistant", type: "message", phase: "commentary", content: [{ type: "output_text", text: "x" }] },
      ],
    });
    const headers = new Headers({ "content-type": "application/json" });
    const prepared = __test.prepareRequest("http://127.0.0.1:3462/v1/responses/compact", headers, body);
    const parsed = decodeJsonBody(prepared.body);
    expect(parsed.input[0]).not.toHaveProperty("phase");
    expect(parsed.input[0].content[0].type).toBe("input_text");
  });

  test("does not inject Responses-create fields into compact requests", () => {
    const body = jsonBody({
      model: "gpt-5.5",
      input: [{ role: "user", content: [{ type: "input_text", text: "compact" }] }],
      session_id: "session-compact",
    });
    const headers = new Headers({
      "content-type": "application/json",
    });

    const prepared = __test.prepareRequest("http://127.0.0.1:3462/v1/responses/compact", headers, body);
    const parsed = decodeJsonBody(prepared.body);

    expect(prepared.sessionId).toBe("session-compact");
    expect(parsed.session_id).toBeUndefined();
    expect(parsed.store).toBeUndefined();
    expect(parsed.instructions).toBeUndefined();
    expect(parsed.reasoning).toBeUndefined();
  });

  test("maps OpenAI-style paths onto the ChatGPT Codex backend path", () => {
    expect(__test.normalizeUpstreamPath("/v1/responses")).toBe("/backend-api/codex/responses");
    expect(__test.normalizeUpstreamPath("/responses")).toBe("/backend-api/codex/responses");
    expect(__test.normalizeUpstreamPath("/backend-api/codex/responses")).toBe("/backend-api/codex/responses");
    expect(__test.buildUpstreamUrl("http://127.0.0.1:3462/v1/responses?session_id=s&foo=bar", "s"))
      .toBe("https://chatgpt.com/backend-api/codex/responses?foo=bar");
    expect(__test.buildUpstreamUrl("http://127.0.0.1:3462/v1/responses?codex_proxy_upstream=openai&foo=bar", null))
      .toBe("https://chatgpt.com/backend-api/codex/responses?foo=bar");
  });

  test("maps explicit OpenAI passthrough requests onto api.openai.com", () => {
    expect(__test.upstreamModeForRequest(
      new URL("http://127.0.0.1:3462/v1/responses"),
      new Headers(),
    )).toBe("codex");
    expect(__test.upstreamModeForRequest(
      new URL("http://127.0.0.1:3462/v1/responses?codex_proxy_upstream=openai"),
      new Headers(),
    )).toBe("openai");
    expect(__test.upstreamModeForRequest(
      new URL("http://127.0.0.1:3462/v1/responses"),
      new Headers({ "x-codex-proxy-upstream": "openai" }),
    )).toBe("openai");
    expect(__test.upstreamModeForRequest(
      new URL("http://127.0.0.1:3462/openai/v1/responses"),
      new Headers(),
    )).toBe("openai");

    expect(__test.normalizeOpenAIPath("/responses")).toBe("/v1/responses");
    expect(__test.normalizeOpenAIPath("/v1/responses")).toBe("/v1/responses");
    expect(__test.normalizeOpenAIPath("/openai")).toBe("/v1");
    expect(__test.normalizeOpenAIPath("/openai/v1/responses")).toBe("/v1/responses");
    expect(__test.normalizeOpenAIPath("/openai/responses")).toBe("/v1/responses");
    // Codex-shape input → OpenAI-shape output (api_key mode rewrites the path)
    expect(__test.normalizeOpenAIPath("/backend-api/codex/responses")).toBe("/v1/responses");
    expect(__test.normalizeOpenAIPath("/backend-api/codex/responses/compact")).toBe("/v1/responses/compact");
    expect(__test.normalizeOpenAIPath("/backend-api/codex")).toBe("/v1");
    expect(__test.buildOpenAIUpstreamUrl("http://127.0.0.1:3462/responses?codex_proxy_upstream=openai&session_id=s&foo=bar"))
      .toBe("https://api.openai.com/v1/responses?foo=bar");
    expect(__test.buildOpenAIUpstreamUrl("http://127.0.0.1:3462/openai/v1/responses?session_id=s&foo=bar"))
      .toBe("https://api.openai.com/v1/responses?foo=bar");
  });

  test("buildHeaders attaches originator + chatgpt-account-id, strips client-supplied auth/originator", () => {
    const source = new Headers({
      "authorization": "Bearer EVIL_CLIENT_TOKEN",
      "x-api-key": "client-leak",
      "originator": "client-supplied-fake",
      "oai-product-sku": "spoofed",
      "content-type": "application/json",
    });
    const out = __test.buildHeaders(source, "PROXY_OAUTH_TOKEN", "acc-12345", "sess-abc");

    // proxy auth wins; client auth wiped
    expect(out.get("authorization")).toBe("Bearer PROXY_OAUTH_TOKEN");
    expect(out.has("x-api-key")).toBe(false);

    // originator from env (default codex_cli_rs); client value stripped
    expect(out.get("originator")).toBe("codex_cli_rs");
    // oai-product-sku not set unless env defines it (default empty)
    expect(out.has("oai-product-sku")).toBe(false);

    // identity headers
    expect(out.get("chatgpt-account-id")).toBe("acc-12345");
    expect(out.get("session_id")).toBe("sess-abc");

    // browser-style fingerprint preserved
    expect(out.get("origin")).toBe("https://chatgpt.com");
    expect(out.get("referer")).toBe("https://chatgpt.com/");
    expect(out.get("user-agent")).toBeString();
  });

  test("buildOpenAIHeaders preserves caller API auth and strips proxy/Codex headers", () => {
    const source = new Headers({
      "authorization": "Bearer sk-real",
      "openai-organization": "org-real",
      "openai-project": "proj-real",
      "x-codex-proxy-upstream": "openai",
      "x-codex-session-id": "session-client",
      "session_id": "session-client",
      "originator": "codex_cli_rs",
      "oai-product-sku": "codex",
      "chatgpt-account-id": "acc-chatgpt",
      "content-length": "123",
      "content-type": "application/json",
    });
    const out = __test.buildOpenAIHeaders(source);

    expect(out.get("authorization")).toBe("Bearer sk-real");
    expect(out.get("openai-organization")).toBe("org-real");
    expect(out.get("openai-project")).toBe("proj-real");
    expect(out.get("content-type")).toBe("application/json");
    expect(out.has("x-codex-proxy-upstream")).toBe(false);
    expect(out.has("x-codex-session-id")).toBe(false);
    expect(out.has("session_id")).toBe(false);
    expect(out.has("originator")).toBe(false);
    expect(out.has("oai-product-sku")).toBe(false);
    expect(out.has("chatgpt-account-id")).toBe(false);
    expect(out.has("content-length")).toBe(false);
    expect(out.get("accept")).toBe("application/json");
    expect(out.get("user-agent")).toBeString();
  });

  test("buildOpenAIHeaders promotes x-api-key to Bearer auth when Authorization is absent", () => {
    const source = new Headers({
      "x-api-key": "sk-from-header",
      "api-key": "sk-secondary",
      "content-type": "application/json",
    });
    const out = __test.buildOpenAIHeaders(source);

    expect(out.get("authorization")).toBe("Bearer sk-from-header");
    expect(out.has("x-api-key")).toBe(false);
    expect(out.has("api-key")).toBe(false);
    expect(out.get("content-type")).toBe("application/json");
  });

  test("strips decompressed response headers", () => {
    const headers = __test.stripResponseHeaders(new Headers({
      "content-encoding": "gzip",
      "content-length": "123",
      "content-type": "text/event-stream",
      "session_id": "session-456",
    }));

    expect(headers.has("content-encoding")).toBe(false);
    expect(headers.has("content-length")).toBe(false);
    expect(headers.get("content-type")).toBe("text/event-stream");
    expect(headers.get("x-codex-session-id")).toBe("session-456");
  });
});

describe("rate limit headers", () => {
  test("headersForLog drops only secrets + boilerplate, keeps signal-bearing headers", () => {
    const out = __test.headersForLog(new Headers({
      // Should drop: secrets + browser/transport boilerplate
      "set-cookie": "abc=1",
      "cookie": "session=xyz",
      "authorization": "Bearer leak",
      "x-api-key": "leak",
      "strict-transport-security": "max-age=63072000",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin",
      "connection": "keep-alive",
      // Should keep: signal headers (incident correlation, cache, fingerprint, clock)
      "cf-ray": "8a-cf",
      "cf-cache-status": "DYNAMIC",
      "alt-svc": "h3",
      "vary": "Accept-Encoding",
      "server": "cloudflare",
      "date": "Mon, 01 May 2026 00:00:00 GMT",
      // Should keep: rate-limit + content
      "x-codex-active-limit": "premium",
      "x-codex-plan-type": "plus",
      "x-codex-primary-used-percent": "12.5",
      "x-oai-request-id": "req_abc123",
      "content-type": "text/event-stream",
    }));

    // Dropped
    expect(out["set-cookie"]).toBeUndefined();
    expect(out["cookie"]).toBeUndefined();
    expect(out["authorization"]).toBeUndefined();
    expect(out["x-api-key"]).toBeUndefined();
    expect(out["strict-transport-security"]).toBeUndefined();
    expect(out["x-content-type-options"]).toBeUndefined();
    expect(out["referrer-policy"]).toBeUndefined();
    expect(out["connection"]).toBeUndefined();

    // Kept (newly un-dropped — signal-bearing)
    expect(out["cf-ray"]).toBe("8a-cf");
    expect(out["cf-cache-status"]).toBe("DYNAMIC");
    expect(out["alt-svc"]).toBe("h3");
    expect(out["vary"]).toBe("Accept-Encoding");
    expect(out["server"]).toBe("cloudflare");
    expect(out["date"]).toBe("Mon, 01 May 2026 00:00:00 GMT");

    // Kept (always)
    expect(out["x-codex-active-limit"]).toBe("premium");
    expect(out["x-codex-plan-type"]).toBe("plus");
    expect(out["x-codex-primary-used-percent"]).toBe("12.5");
    expect(out["x-oai-request-id"]).toBe("req_abc123");
    expect(out["content-type"]).toBe("text/event-stream");
  });

  test("headersForLog truncates very long header values", () => {
    const long = "x".repeat(2000);
    const out = __test.headersForLog(new Headers({ "x-huge": long }));
    expect(out["x-huge"]?.length).toBeLessThanOrEqual(520);
    expect(out["x-huge"]).toContain("...[truncated]");
  });

  test("parseRateLimitHeaders returns null when no x-codex-* signals present", () => {
    const snap = __test.parseRateLimitHeaders(new Headers({
      "content-type": "text/event-stream",
      "x-oai-request-id": "req_lonely",
    }));
    expect(snap).toBeNull();
  });

  test("parseRateLimitHeaders builds full snapshot from realistic Codex headers", () => {
    const snap = __test.parseRateLimitHeaders(new Headers({
      "x-codex-active-limit": "premium",
      "x-codex-plan-type": "plus",
      "x-codex-primary-used-percent": "37.4",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-after-seconds": "1234",
      "x-codex-primary-reset-at": "1746115200",
      "x-codex-secondary-used-percent": "11.2",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-after-seconds": "543210",
      "x-codex-secondary-reset-at": "1746657600",
      "x-codex-primary-over-secondary-limit-percent": "82.5",
      "x-codex-credits-has-credits": "true",
      "x-codex-credits-unlimited": "false",
      "x-oai-request-id": "req_abc123",
      "x-models-etag": "W/\"deadbeef\"",
    }));

    expect(snap).not.toBeNull();
    expect(snap!.activeLimit).toBe("premium");
    expect(snap!.planType).toBe("plus");
    expect(snap!.primary.usedPercent).toBe(37.4);
    expect(snap!.primary.windowMinutes).toBe(300);
    expect(snap!.primary.resetAfterSeconds).toBe(1234);
    expect(snap!.primary.resetAt).toBe(1746115200);
    expect(snap!.secondary.usedPercent).toBe(11.2);
    expect(snap!.secondary.windowMinutes).toBe(10080);
    expect(snap!.secondary.resetAfterSeconds).toBe(543210);
    expect(snap!.secondary.resetAt).toBe(1746657600);
    expect(snap!.primaryOverSecondaryLimitPercent).toBe(82.5);
    expect(snap!.hasCredits).toBe(true);
    expect(snap!.unlimited).toBe(false);
    expect(snap!.oaiRequestId).toBe("req_abc123");
    expect(snap!.modelsEtag).toBe("W/\"deadbeef\"");
  });

  test("parseRateLimitHeaders returns nulls for missing fields when one signal triggers it", () => {
    const snap = __test.parseRateLimitHeaders(new Headers({
      "x-codex-active-limit": "premium",
    }));
    expect(snap).not.toBeNull();
    expect(snap!.activeLimit).toBe("premium");
    expect(snap!.planType).toBeNull();
    expect(snap!.primary.usedPercent).toBeNull();
    expect(snap!.primary.windowMinutes).toBeNull();
    expect(snap!.secondary.usedPercent).toBeNull();
    expect(snap!.hasCredits).toBeNull();
    expect(snap!.unlimited).toBeNull();
  });

  test("parseRateLimitHeaders coerces booleans case-insensitively, gives null for garbage", () => {
    const snap = __test.parseRateLimitHeaders(new Headers({
      "x-codex-active-limit": "premium",
      "x-codex-credits-has-credits": "TRUE",
      "x-codex-credits-unlimited": "weird",
    }));
    expect(snap!.hasCredits).toBe(true);
    expect(snap!.unlimited).toBeNull();
  });

  test("parseRateLimitHeaders ignores non-numeric numeric fields", () => {
    const snap = __test.parseRateLimitHeaders(new Headers({
      "x-codex-active-limit": "premium",
      "x-codex-primary-used-percent": "not-a-number",
      "x-codex-primary-reset-at": "",
    }));
    expect(snap!.primary.usedPercent).toBeNull();
    expect(snap!.primary.resetAt).toBeNull();
  });
});

describe("API-key auth", () => {
  test("resolveAuthMode: profile override beats env beats default", () => {
    // Default with no profile = "oauth"
    expect(__test.resolveAuthMode(null)).toBe("oauth");

    // Profile override
    const apiKeyProfile = {
      name: "x", matchedBy: "default" as const,
      def: { writeRoles: [], tools: "*" as const, readChannels: [], authMode: "api_key" as const },
    };
    expect(__test.resolveAuthMode(apiKeyProfile)).toBe("api_key");

    const oauthProfile = {
      name: "y", matchedBy: "default" as const,
      def: { writeRoles: [], tools: "*" as const, readChannels: [], authMode: "oauth" as const },
    };
    expect(__test.resolveAuthMode(oauthProfile)).toBe("oauth");

    // Profile without authMode falls through (default)
    const noModeProfile = {
      name: "z", matchedBy: "default" as const,
      def: { writeRoles: [], tools: "*" as const, readChannels: [] },
    };
    expect(__test.resolveAuthMode(noModeProfile)).toBe("oauth");
  });

  test("upstreamModeForRequest: api_key profile forces 'openai' regardless of path", () => {
    const apiKeyProfile = {
      name: "openai-direct", matchedBy: "default" as const,
      def: { writeRoles: [], tools: "*" as const, readChannels: [], authMode: "api_key" as const },
    };
    const url = new URL("http://127.0.0.1:3462/v1/responses");
    const headers = new Headers();
    expect(__test.upstreamModeForRequest(url, headers, apiKeyProfile)).toBe("openai");
  });

  test("upstreamModeForRequest: oauth profile + /v1/responses path → 'codex'", () => {
    const oauthProfile = {
      name: "director", matchedBy: "default" as const,
      def: { writeRoles: [], tools: "*" as const, readChannels: [], authMode: "oauth" as const },
    };
    const url = new URL("http://127.0.0.1:3462/v1/responses");
    expect(__test.upstreamModeForRequest(url, new Headers(), oauthProfile)).toBe("codex");
  });

  test("upstreamModeForRequest: /openai/ prefix still routes openai even with oauth profile", () => {
    const oauthProfile = {
      name: "director", matchedBy: "default" as const,
      def: { writeRoles: [], tools: "*" as const, readChannels: [], authMode: "oauth" as const },
    };
    const url = new URL("http://127.0.0.1:3462/openai/v1/responses");
    expect(__test.upstreamModeForRequest(url, new Headers(), oauthProfile)).toBe("openai");
  });

  test("upstreamModeForRequest: x-codex-proxy-upstream=openai header forces openai", () => {
    const url = new URL("http://127.0.0.1:3462/v1/responses");
    const headers = new Headers({ "x-codex-proxy-upstream": "openai" });
    expect(__test.upstreamModeForRequest(url, headers, null)).toBe("openai");
  });

  test("resolveApiKey: profile-supplied key beats file beats env", () => {
    const r1 = __test.resolveApiKey("sk-profile-test-key-abc", "myprofile");
    expect(r1).not.toBeNull();
    expect(r1!.source).toBe("profile");
    expect(r1!.sourceDetail).toBe("profile:myprofile");
    expect(r1!.key).toBe("sk-profile-test-key-abc");
    expect(r1!.preview).toContain("sk-");
    expect(r1!.preview).toContain("…");
    expect(r1!.preview).not.toContain("profile-test-key");
  });

  test("resolveApiKey: returns null when no key configured anywhere (env unset in test env)", () => {
    // OPENAI_API_KEY and CODEX_PROXY_API_KEY_FILE are not set in tests
    const r = __test.resolveApiKey(null, null);
    expect(r).toBeNull();
  });

  test("resolveApiKey: empty-string profile key is treated as not provided", () => {
    const r = __test.resolveApiKey("", "x");
    expect(r).toBeNull();
  });

  test("buildOpenAIHeaders: injects Bearer when client provides no auth and key is given", () => {
    const out = __test.buildOpenAIHeaders(new Headers({ "content-type": "application/json" }), "sk-test-injection-123");
    expect(out.get("authorization")).toBe("Bearer sk-test-injection-123");
  });

  test("buildOpenAIHeaders: client-supplied Bearer wins over injection (curl probe path)", () => {
    const out = __test.buildOpenAIHeaders(new Headers({
      "authorization": "Bearer sk-client-supplied",
      "content-type": "application/json",
    }), "sk-injected-by-proxy");
    expect(out.get("authorization")).toBe("Bearer sk-client-supplied");
  });

  test("buildOpenAIHeaders: client-supplied x-api-key wins over injection", () => {
    const out = __test.buildOpenAIHeaders(new Headers({
      "x-api-key": "sk-via-x-api-key",
      "content-type": "application/json",
    }), "sk-injected");
    expect(out.get("authorization")).toBe("Bearer sk-via-x-api-key");
    expect(out.has("x-api-key")).toBe(false);
  });

  test("buildOpenAIHeaders: no auth at all (no client, no inject) = no authorization header", () => {
    const out = __test.buildOpenAIHeaders(new Headers({ "content-type": "application/json" }), null);
    expect(out.has("authorization")).toBe(false);
  });

  test("buildOpenAIHeaders: strips Codex-only headers (chatgpt-account-id, originator, oai-product-sku)", () => {
    const out = __test.buildOpenAIHeaders(new Headers({
      "chatgpt-account-id": "abc",
      "originator": "codex_cli_rs",
      "oai-product-sku": "x",
      "session_id": "s1",
    }), "sk-test");
    expect(out.has("chatgpt-account-id")).toBe(false);
    expect(out.has("originator")).toBe(false);
    expect(out.has("oai-product-sku")).toBe(false);
    expect(out.has("session_id")).toBe(false);
  });

  test("prepareRequest: upstreamMode='openai' does NOT inject DEFAULT_INSTRUCTIONS", () => {
    const body = encoder.encode(JSON.stringify({
      model: "gpt-5.1-codex",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }));
    const headers = new Headers({ "content-type": "application/json", "accept": "text/event-stream" });
    const prepared = __test.prepareRequest("http://127.0.0.1:3462/v1/responses", headers, body, "openai");
    const parsed = decodeJsonBody(prepared.body);
    // Caller didn't supply instructions and we're in openai mode → no injection
    expect(parsed.instructions).toBeUndefined();
  });

  test("prepareRequest: upstreamMode='codex' DOES inject DEFAULT_INSTRUCTIONS (regression)", () => {
    const body = encoder.encode(JSON.stringify({
      model: "gpt-5.5",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }));
    const headers = new Headers({ "content-type": "application/json", "accept": "text/event-stream" });
    const prepared = __test.prepareRequest("http://127.0.0.1:3462/v1/responses", headers, body, "codex");
    const parsed = decodeJsonBody(prepared.body);
    expect(typeof parsed.instructions).toBe("string");
    expect(parsed.instructions.length).toBeGreaterThan(0);
  });

  test("prepareRequest: default upstreamMode is 'codex' (back-compat)", () => {
    const body = encoder.encode(JSON.stringify({
      model: "gpt-5.5",
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }));
    const headers = new Headers({ "content-type": "application/json", "accept": "text/event-stream" });
    // No upstreamMode arg passed
    const prepared = __test.prepareRequest("http://127.0.0.1:3462/v1/responses", headers, body);
    const parsed = decodeJsonBody(prepared.body);
    expect(typeof parsed.instructions).toBe("string");
  });

  test("prepareRequest: caller-supplied instructions are preserved in openai mode", () => {
    const body = encoder.encode(JSON.stringify({
      model: "gpt-5.1-codex",
      stream: true,
      instructions: "Caller's own instructions",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }));
    const headers = new Headers({ "content-type": "application/json", "accept": "text/event-stream" });
    const prepared = __test.prepareRequest("http://127.0.0.1:3462/v1/responses", headers, body, "openai");
    const parsed = decodeJsonBody(prepared.body);
    expect(parsed.instructions).toBe("Caller's own instructions");
  });
});

describe("chat-completions parser (Roo Code / OpenAI SDK shape)", () => {
  function ccChunk(payload: Record<string, any>): string {
    return `data: ${JSON.stringify({ object: "chat.completion.chunk", ...payload })}\n\n`;
  }

  test("routes delta.reasoning_content to analysis channel (THE CoT leak)", async () => {
    rmSync(harmonyLog, { force: true });
    const raw = [
      ccChunk({ id: "gen-1", model: "openai/gpt-5.5", provider: "OpenAI",
        choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "**Thinking step 1**" } }] }),
      ccChunk({ id: "gen-1", model: "openai/gpt-5.5",
        choices: [{ index: 0, delta: { reasoning_content: " — let me consider options." } }] }),
      ccChunk({ id: "gen-1", model: "openai/gpt-5.5",
        choices: [{ index: 0, delta: { content: "Here is the answer." } }] }),
      ccChunk({ id: "gen-1", model: "openai/gpt-5.5",
        choices: [{ index: 0, finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "openai/gpt-5.5", { requestId: "rcc1", path: "/v1/chat/completions", sessionId: "sess-cc" }));

    const lines = readHarmony();
    const analysis = lines.filter((l) => l.phase === "response.channel_chunk" && l.channel === "analysis");
    const final = lines.filter((l) => l.phase === "response.channel_chunk" && l.channel === "final");
    const completed = lines.filter((l) => l.phase === "response.completed");

    expect(analysis.length).toBe(2);
    expect(analysis.map((l) => l.contentHead || l.content).join("")).toBe("**Thinking step 1** — let me consider options.");
    expect(final.length).toBe(1);
    expect(final[0].contentHead || final[0].content).toBe("Here is the answer.");
    expect(completed.length).toBe(1);
    expect(completed[0].stopReason).toBe("stop");
    expect(completed[0].inputTokens).toBe(100);
    expect(completed[0].outputTokens).toBe(20);
  });

  test("falls back to delta.reasoning string when reasoning_content absent", async () => {
    rmSync(harmonyLog, { force: true });
    const raw = [
      ccChunk({ id: "gen-2", model: "openai/gpt-5.5",
        choices: [{ index: 0, delta: { reasoning: "Reasoning via legacy field." } }] }),
      ccChunk({ id: "gen-2", choices: [{ index: 0, finish_reason: "stop", delta: {} }] }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "openai/gpt-5.5", { requestId: "rcc2", path: "/v1/chat/completions", sessionId: "sess-cc-legacy" }));
    const analysis = readHarmony().filter((l) => l.phase === "response.channel_chunk" && l.channel === "analysis");
    expect(analysis.length).toBe(1);
    expect(analysis[0].contentHead || analysis[0].content).toBe("Reasoning via legacy field.");
  });

  test("falls through to delta.reasoning_details when neither reasoning_content nor reasoning is set", async () => {
    rmSync(harmonyLog, { force: true });
    const raw = [
      ccChunk({ id: "gen-3", model: "openai/gpt-5.5",
        choices: [{ index: 0, delta: {
          reasoning_details: [{ type: "reasoning.summary", summary: "Structured summary chunk.", format: "openai-responses-v1", index: 0 }],
        } }] }),
      ccChunk({ id: "gen-3", choices: [{ index: 0, finish_reason: "stop", delta: {} }] }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "openai/gpt-5.5", { requestId: "rcc3", path: "/v1/chat/completions", sessionId: "sess-cc-details" }));
    const analysis = readHarmony().filter((l) => l.phase === "response.channel_chunk" && l.channel === "analysis");
    expect(analysis.length).toBe(1);
    expect(analysis[0].contentHead || analysis[0].content).toBe("Structured summary chunk.");
  });

  test("captures openrouterProvider from chunk event", async () => {
    rmSync(harmonyLog, { force: true });
    const raw = [
      ccChunk({ id: "gen-4", model: "openai/gpt-5.5", provider: "OpenAI",
        choices: [{ index: 0, delta: { content: "ok" } }] }),
      ccChunk({ id: "gen-4", choices: [{ index: 0, finish_reason: "stop", delta: {} }] }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "openai/gpt-5.5", { requestId: "rcc4", path: "/v1/chat/completions", sessionId: "sess-cc-prov" }));
    const env = readHarmony().filter((l) => l.phase === "response.envelope_captured");
    expect(env.length).toBe(1);
    expect(env[0].envelope.openrouterProvider).toBe("OpenAI");
  });

  test("routes tool_calls to commentary channel, stitched by index", async () => {
    rmSync(harmonyLog, { force: true });
    const raw = [
      ccChunk({ id: "gen-5", model: "openai/gpt-5.5",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "read_file", arguments: "{\"pa" } }] } }] }),
      ccChunk({ id: "gen-5",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"x\"}" } }] } }] }),
      ccChunk({ id: "gen-5", choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }] }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "openai/gpt-5.5", { requestId: "rcc5", path: "/v1/chat/completions", sessionId: "sess-cc-tc" }));

    const toolDeltas = readHarmony().filter((l) => l.phase === "response.tool_call.delta");
    expect(toolDeltas.length).toBeGreaterThanOrEqual(2);
    expect(toolDeltas.every((l) => l.channel === "commentary")).toBe(true);
    expect(toolDeltas[0].name).toBe("read_file");
    const completed = readHarmony().filter((l) => l.phase === "response.completed");
    expect(completed[0].stopReason).toBe("tool_calls");
    expect(completed[0].fnCalls).toBe(1);
  });

  test("captures Fernet-encrypted reasoning_details.data into encryptedReasoningSizes", async () => {
    rmSync(harmonyLog, { force: true });
    const fernetBlob = "gAAAAABqAfCOoEfs_bSZMJRtWdaaf8kY9MwfqTosr8zEgxOQchcmp3TAcqXyotz8uTgtiAXn"  // truncated for test
      + "WSWwUoz-cU7nqLTcO7ow7JPxz5m0lWG59bzILuC1SricMgEd_vgC6xNEVdaUZIuGfeap";  // 134 chars total
    const raw = [
      ccChunk({ id: "gen-enc", model: "openai/gpt-5.5",
        choices: [{ index: 0, delta: {
          reasoning_details: [{ type: "reasoning.encrypted", data: fernetBlob, format: "openai-responses-v1", index: 0 }],
        } }] }),
      ccChunk({ id: "gen-enc",
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "openai/gpt-5.5", { requestId: "rce1", path: "/v1/chat/completions", sessionId: "sess-enc" }));

    const lines = readHarmony();
    const completed = lines.filter((l) => l.phase === "response.completed");
    expect(completed.length).toBe(1);
    expect(completed[0].encryptedReasoningCount).toBe(1);
    expect(completed[0].encryptedReasoningTotalBytes).toBe(fernetBlob.length);

    const envCap = lines.filter((l) => l.phase === "response.envelope_captured");
    expect(envCap.length).toBe(1);
    expect(envCap[0].envelope.reasoningMode).toBe("encrypted_only");
  });

  test("reasoningMode='both' when summary + encrypted both present", async () => {
    rmSync(harmonyLog, { force: true });
    const raw = [
      ccChunk({ id: "gen-both", model: "openai/gpt-5.5",
        choices: [{ index: 0, delta: {
          reasoning_details: [
            { type: "reasoning.summary", summary: "Thinking step 1", format: "openai-responses-v1", index: 0 },
            { type: "reasoning.encrypted", data: "gAAAAAB_test_blob_xyz", format: "openai-responses-v1", index: 0 },
          ],
        } }] }),
      ccChunk({ id: "gen-both", choices: [{ index: 0, finish_reason: "stop", delta: {} }] }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "openai/gpt-5.5", { requestId: "rce2", path: "/v1/chat/completions", sessionId: "sess-both" }));

    const lines = readHarmony();
    const envCap = lines.filter((l) => l.phase === "response.envelope_captured");
    expect(envCap[0].envelope.reasoningMode).toBe("both");

    const completed = lines.filter((l) => l.phase === "response.completed");
    expect(completed[0].encryptedReasoningCount).toBe(1);
    expect(completed[0].analysisLen).toBeGreaterThan(0);
  });

  test("reasoningMode='cleartext_only' when only summary present", async () => {
    rmSync(harmonyLog, { force: true });
    const raw = [
      ccChunk({ id: "gen-ct", model: "openai/gpt-5.5",
        choices: [{ index: 0, delta: {
          reasoning_details: [{ type: "reasoning.summary", summary: "thinking", format: "openai-responses-v1", index: 0 }],
        } }] }),
      ccChunk({ id: "gen-ct", choices: [{ index: 0, finish_reason: "stop", delta: {} }] }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "openai/gpt-5.5", { requestId: "rce3", path: "/v1/chat/completions", sessionId: "sess-ct" }));
    const envCap = readHarmony().filter((l) => l.phase === "response.envelope_captured");
    expect(envCap[0].envelope.reasoningMode).toBe("cleartext_only");
  });

  test("reasoningMode='none' when no reasoning at all", async () => {
    rmSync(harmonyLog, { force: true });
    const raw = [
      ccChunk({ id: "gen-none", model: "openai/gpt-5.5",
        choices: [{ index: 0, delta: { content: "just an answer, no thinking" } }] }),
      ccChunk({ id: "gen-none", choices: [{ index: 0, finish_reason: "stop", delta: {} }] }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "openai/gpt-5.5", { requestId: "rce4", path: "/v1/chat/completions", sessionId: "sess-none" }));
    const envCap = readHarmony().filter((l) => l.phase === "response.envelope_captured");
    expect(envCap[0].envelope.reasoningMode).toBe("none");
  });
});

describe("response envelope capture", () => {
  test("mergeResponseEnvelope extracts all wire-stream fields from a complete response", () => {
    const env: any = {
      serviceTier: null, safetyIdentifier: null, promptCacheRetention: null,
      previousResponseId: null, store: null, truncation: null,
      parallelToolCalls: null, toolChoice: null, toolUsage: null, moderation: null,
      reasoningEffort: null, reasoningSummary: null,
      textVerbosity: null, textFormatType: null,
    };
    const changed = __test.mergeResponseEnvelope(env, {
      service_tier: "default",
      safety_identifier: "sid-abc-123",
      prompt_cache_retention: "default",
      previous_response_id: "resp_prior_xyz",
      store: false,
      truncation: "auto",
      parallel_tool_calls: true,
      tool_choice: "auto",
      tool_usage: { exec_command: 4, apply_patch: 1 },
      moderation: { flagged: false, categories: { self_harm: 0.001 } },
      reasoning: { effort: "high", summary: "detailed" },
      text: { verbosity: "low", format: { type: "text" } },
    });

    expect(changed).toBe(true);
    expect(env.serviceTier).toBe("default");
    expect(env.safetyIdentifier).toBe("sid-abc-123");
    expect(env.promptCacheRetention).toBe("default");
    expect(env.previousResponseId).toBe("resp_prior_xyz");
    expect(env.store).toBe(false);
    expect(env.truncation).toBe("auto");
    expect(env.parallelToolCalls).toBe(true);
    expect(env.toolChoice).toBe("auto");
    expect(env.toolUsage).toEqual({ exec_command: 4, apply_patch: 1 });
    expect(env.moderation?.flagged).toBe(false);
    expect(env.reasoningEffort).toBe("high");
    expect(env.reasoningSummary).toBe("detailed");
    expect(env.textVerbosity).toBe("low");
    expect(env.textFormatType).toBe("text");
  });

  test("mergeResponseEnvelope handles tool_choice as object", () => {
    const env: any = {
      serviceTier: null, safetyIdentifier: null, promptCacheRetention: null,
      previousResponseId: null, store: null, truncation: null,
      parallelToolCalls: null, toolChoice: null, toolUsage: null, moderation: null,
      reasoningEffort: null, reasoningSummary: null,
      textVerbosity: null, textFormatType: null,
    };
    __test.mergeResponseEnvelope(env, {
      tool_choice: { type: "function", name: "exec_command" },
    });
    expect(env.toolChoice).toEqual({ type: "function", name: "exec_command" });
  });

  test("mergeResponseEnvelope returns false when no fields change", () => {
    const env: any = {
      serviceTier: "default", safetyIdentifier: null, promptCacheRetention: null,
      previousResponseId: null, store: null, truncation: null,
      parallelToolCalls: null, toolChoice: null, toolUsage: null, moderation: null,
      reasoningEffort: null, reasoningSummary: null,
      textVerbosity: null, textFormatType: null,
    };
    const changed = __test.mergeResponseEnvelope(env, { service_tier: "default" });
    expect(changed).toBe(false);
  });

  test("mergeResponseEnvelope is null-safe and ignores wrong types", () => {
    const env: any = {
      serviceTier: null, safetyIdentifier: null, promptCacheRetention: null,
      previousResponseId: null, store: null, truncation: null,
      parallelToolCalls: null, toolChoice: null, toolUsage: null, moderation: null,
      reasoningEffort: null, reasoningSummary: null,
      textVerbosity: null, textFormatType: null,
    };
    expect(__test.mergeResponseEnvelope(env, undefined)).toBe(false);
    expect(__test.mergeResponseEnvelope(env, null as any)).toBe(false);
    __test.mergeResponseEnvelope(env, {
      service_tier: 42,           // wrong type, ignored
      safety_identifier: null,     // null, ignored
      moderation: "not-an-object", // wrong type, ignored
      reasoning: { effort: 100 },  // nested wrong type, ignored
    });
    expect(env.serviceTier).toBeNull();
    expect(env.safetyIdentifier).toBeNull();
    expect(env.moderation).toBeNull();
    expect(env.reasoningEffort).toBeNull();
  });

  test("interceptStream emits response.envelope_captured with merged fields", async () => {
    rmSync(harmonyLog, { force: true });
    const raw = [
      sse("response.created", {
        response: {
          model: "gpt-5.5",
          service_tier: "default",
          safety_identifier: "sid-test-1",
          prompt_cache_retention: "default",
          store: false,
          truncation: "auto",
          parallel_tool_calls: true,
          reasoning: { effort: "high", summary: "detailed" },
          text: { verbosity: "low", format: { type: "text" } },
        },
      }),
      sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "answer" }),
      sse("response.completed", {
        response: {
          model: "gpt-5.5",
          status: "completed",
          previous_response_id: "resp_prior",
          tool_usage: { exec_command: 2 },
          moderation: { flagged: false },
          usage: { output_tokens: 5 },
        },
      }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "gpt-5.5", { requestId: "renv1", path: "/responses", sessionId: "sess-env" }));

    const lines = readHarmony();
    const envs = lines.filter((l) => l.phase === "response.envelope_captured");
    expect(envs.length).toBe(1);
    const e = envs[0].envelope;
    expect(e.serviceTier).toBe("default");
    expect(e.safetyIdentifier).toBe("sid-test-1");
    expect(e.promptCacheRetention).toBe("default");
    expect(e.previousResponseId).toBe("resp_prior");
    expect(e.store).toBe(false);
    expect(e.truncation).toBe("auto");
    expect(e.parallelToolCalls).toBe(true);
    expect(e.toolUsage).toEqual({ exec_command: 2 });
    expect(e.moderation?.flagged).toBe(false);
    expect(e.reasoningEffort).toBe("high");
    expect(e.reasoningSummary).toBe("detailed");
    expect(e.textVerbosity).toBe("low");
    expect(e.textFormatType).toBe("text");
    expect(envs[0].requestId).toBe("renv1");
    expect(envs[0].sessionId).toBe("sess-env");
  });

  test("interceptStream emits envelope_captured exactly once even on response.failed", async () => {
    rmSync(harmonyLog, { force: true });
    const raw = [
      sse("response.created", { response: { model: "gpt-5.5", service_tier: "default" } }),
      sse("response.failed", { response: { model: "gpt-5.5", status: "failed", error: { code: "rate_limit_exceeded" } } }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "gpt-5.5", { requestId: "renv2", path: "/responses", sessionId: "sess-fail" }));

    const envs = readHarmony().filter((l) => l.phase === "response.envelope_captured");
    expect(envs.length).toBe(1);
    expect(envs[0].envelope.serviceTier).toBe("default");
    expect(envs[0].stopReason).toBe("rate_limit_exceeded");
  });
});

describe("SSE interception", () => {
  test("passes SSE through while logging raw reasoning_text deltas when upstream emits them", async () => {
    rmSync(thinkingLog, { force: true });
    rmSync(rawEventLog, { force: true });
    rmSync(apiJsonLog, { force: true });
    const raw = [
      sse("response.created", { response: { model: "gpt-oss-120b", usage: { input_tokens: 5 } } }),
      sse("response.reasoning_text.delta", { item_id: "rs_1", output_index: 0, content_index: 0, delta: "raw " }),
      sse("response.reasoning_text.delta", { item_id: "rs_1", output_index: 0, content_index: 0, delta: "thought" }),
      sse("response.output_text.delta", { item_id: "msg_1", output_index: 1, content_index: 0, delta: "answer" }),
      sse("response.completed", { response: { model: "gpt-oss-120b", status: "completed", usage: { output_tokens: 8 } } }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      },
    });

    const relayed = await collect(__test.interceptStream(stream, "gpt-oss-120b"));
    const log = readFileSync(thinkingLog, "utf8");

    expect(relayed).toBe(raw);
    expect(log).toContain("[reasoning]\nraw thought");
    expect(log).toContain("[text]\nanswer");
    expect(log).toContain("done | out=8 | stop=completed");

    const rawEvents = readFileSync(rawEventLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rawEvents).toHaveLength(5);
    expect(rawEvents[1].type).toBe("response.reasoning_text.delta");

    const apiEvents = readFileSync(apiJsonLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(apiEvents).toHaveLength(5);
    expect(apiEvents[0].phase).toBe("response.sse_event");
    expect(apiEvents[1].requestId).toBe("-");
    expect(apiEvents[1].type).toBe("response.reasoning_text.delta");
  });

  test("logs reasoning summaries without duplicating done events after deltas", async () => {
    rmSync(thinkingLog, { force: true });
    const raw = [
      sse("response.reasoning_summary_text.delta", { item_id: "rs_2", output_index: 0, summary_index: 0, delta: "summary" }),
      sse("response.reasoning_summary_text.done", { item_id: "rs_2", output_index: 0, summary_index: 0, text: "summary" }),
      sse("response.completed", { response: { model: "gpt-5.5", status: "completed", usage: { output_tokens: 3 } } }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      },
    });

    await collect(__test.interceptStream(stream, "gpt-5.5"));
    const log = readFileSync(thinkingLog, "utf8");

    expect(log.match(/summary/g)?.length).toBe(1);
  });

  test("does not create a thinking log for streams with no captured text", async () => {
    rmSync(thinkingLog, { force: true });
    const raw = sse("response.completed", { response: { model: "gpt-5.5", status: "completed", usage: { output_tokens: 1 } } });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      },
    });

    await collect(__test.interceptStream(stream, "gpt-5.5"));

    expect(existsSync(thinkingLog)).toBe(false);
  });

  test("builds a categorized transcript from raw wire events", () => {
    const transcript = __test.buildTranscript([
      { at: "t1", requestId: "r1", event: { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "hi" } },
      { at: "t2", requestId: "r1", event: { type: "response.reasoning_summary_text.delta", item_id: "rs", output_index: 0, summary_index: 0, delta: "summary" } },
      { at: "t3", requestId: "r1", event: { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", name: "lookup", call_id: "call_1", arguments: "" } } },
      { at: "t4", requestId: "r1", event: { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: "{\"q\"" } },
      { at: "t5", requestId: "r1", event: { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: ":\"x\"}" } },
      { at: "t6", requestId: "r1", event: { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: "{\"q\":\"x\"}" } },
      { at: "t7", requestId: "r1", event: { type: "response.output_item.done", item: { id: "fc_1", type: "function_call", name: "lookup", call_id: "call_1", status: "completed", arguments: "{\"q\":\"x\"}" } } },
      { at: "t8", requestId: "r1", event: { type: "response.output_item.added", item: { id: "ctc_1", type: "custom_tool_call", name: "apply_patch", call_id: "call_2", input: "" } } },
      { at: "t9", requestId: "r1", event: { type: "response.custom_tool_call_input.delta", item_id: "ctc_1", output_index: 2, delta: "*** Begin" } },
      { at: "t10", requestId: "r1", event: { type: "response.custom_tool_call_input.delta", item_id: "ctc_1", output_index: 2, delta: " Patch" } },
      { at: "t11", requestId: "r1", event: { type: "response.custom_tool_call_input.done", item_id: "ctc_1", output_index: 2, input: "*** Begin Patch" } },
      { at: "t12", requestId: "r2", event: { type: "response.output_text.delta", item_id: "msg2", output_index: 0, content_index: 0, delta: "bye" } },
      { at: "t13", requestId: "r2", event: { type: "response.completed", response: { status: "completed", model: "gpt-5.5", usage: { output_tokens: 1 }, output: [] } } },
    ]);

    expect(transcript.channels.commentary).toBe("hibye");
    expect(transcript.channels.analysis).toBe("summary");
    expect(transcript.assistantText).toBe("hibye");
    expect(transcript.reasoningText).toBe("summary");
    expect(transcript.toolEvents[0].item.name).toBe("lookup");
    expect(transcript.toolCalls[0].name).toBe("lookup");
    expect(transcript.toolCalls[0].arguments).toBe("{\"q\":\"x\"}");
    expect(transcript.toolCalls[1].name).toBe("apply_patch");
    expect(transcript.toolCalls[1].input).toBe("*** Begin Patch");
    expect(transcript.requests.map((request) => request.requestId)).toEqual(["r1", "r2"]);
    expect(transcript.requests[0].assistantText).toBe("hi");
    expect(transcript.requests[0].toolCalls).toHaveLength(2);
    expect(transcript.requests[1].assistantText).toBe("bye");
    expect(transcript.eventTypes["response.completed"]).toBe(1);
  });
});

describe("harmony helpers", () => {
  test("channelForEventType maps SSE event types to Harmony channels", () => {
    expect(__test.channelForEventType("response.output_text.delta")).toBe("final");
    expect(__test.channelForEventType("response.output_text.done")).toBe("final");
    expect(__test.channelForEventType("response.reasoning_text.delta")).toBe("analysis");
    expect(__test.channelForEventType("response.reasoning_summary_text.delta")).toBe("analysis");
    expect(__test.channelForEventType("response.reasoning_summary_part.added")).toBe("analysis");
    expect(__test.channelForEventType("response.function_call_arguments.delta")).toBe("commentary");
    expect(__test.channelForEventType("response.function_call_arguments.done")).toBe("commentary");
    expect(__test.channelForEventType("response.custom_tool_call_input.delta")).toBe("commentary");
    expect(__test.channelForEventType("response.custom_tool_call_input.done")).toBe("commentary");
    expect(__test.channelForEventType("response.created")).toBeNull();
    expect(__test.channelForEventType("response.completed")).toBeNull();
    expect(__test.channelForEventType("")).toBeNull();
  });

  test("tierForInputItem normalizes Codex roles", () => {
    expect(__test.tierForInputItem({ role: "developer" })).toBe("developer");
    expect(__test.tierForInputItem({ role: "user" })).toBe("user");
    expect(__test.tierForInputItem({ role: "assistant" })).toBe("assistant");
    expect(__test.tierForInputItem({ type: "function_call", name: "x" })).toBe("function_call");
    expect(__test.tierForInputItem({ type: "function_call_output" })).toBe("function_call_output");
    expect(__test.tierForInputItem({ type: "reasoning" })).toBe("reasoning");
    expect(__test.tierForInputItem({ type: "compaction" })).toBe("compaction");
    expect(__test.tierForInputItem({ type: "custom_tool_call" })).toBe("custom_tool_call");
    expect(__test.tierForInputItem({})).toBeNull();
    expect(__test.tierForInputItem(null)).toBeNull();
  });

  test("parsePermissionsBlock extracts sandbox/network/approval claims", () => {
    const text = "<permissions instructions>\nFilesystem sandboxing defines which files can be read or written. `sandbox_mode` is `danger-full-access`: No filesystem sandboxing - all commands are permitted. Network access is enabled.\nApproval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected.\n</permissions instructions>";
    const claim = __test.parsePermissionsBlock(text);
    expect(claim).not.toBeNull();
    expect(claim!.sandboxMode).toBe("danger-full-access");
    expect(claim!.networkAccess).toBe(true);
    expect(claim!.approvalPolicy).toBe("never");
    expect(claim!.raw.length).toBeGreaterThan(0);
  });

  test("parsePermissionsBlock returns null when block is absent", () => {
    expect(__test.parsePermissionsBlock("hello world")).toBeNull();
    expect(__test.parsePermissionsBlock("")).toBeNull();
    expect(__test.parsePermissionsBlock(null)).toBeNull();
  });
});

describe("inspectInput", () => {
  test("counts tiers and detects developer permissions block", () => {
    const result = __test.inspectInput({
      input: [
        { role: "developer", content: [{ type: "input_text", text: "<permissions instructions>\n`sandbox_mode` is `read-only`. Network access is disabled. Approval policy is currently always.\n</permissions instructions>" }] },
        { role: "user", content: [{ type: "input_text", text: "hello there" }] },
        { role: "user", content: [{ type: "input_text", text: "follow up" }] },
        { type: "reasoning", content: [{ type: "reasoning_text", text: "internal CoT" }] },
        { type: "function_call", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" },
        { type: "function_call_output", output: "file1\nfile2\n" },
      ],
      tools: [
        { type: "function", name: "exec_command", description: "..." },
        { type: "function", name: "write_stdin", description: "..." },
        { type: "custom", name: "apply_patch", description: "..." },
      ],
      reasoning: { effort: "xhigh", summary: "detailed" },
      prompt_cache_key: "session-cache-1",
    });

    expect(result.inputTiers.developer?.messages).toBe(1);
    expect(result.inputTiers.developer?.bytes).toBeGreaterThan(0);
    expect(result.inputTiers.user?.messages).toBe(2);
    expect(result.inputTiers.reasoning?.messages).toBe(1);
    expect(result.inputTiers.function_call?.messages).toBe(1);
    expect(result.inputTiers.function_call_output?.messages).toBe(1);

    expect(result.tools.count).toBe(3);
    expect(result.tools.byType).toEqual({ function: 2, custom: 1 });
    expect(result.tools.names).toEqual(["exec_command", "write_stdin", "apply_patch"]);
    expect(result.reasoningEffort).toBe("xhigh");
    expect(result.reasoningSummary).toBe("detailed");
    expect(result.promptCacheKey).toBe("session-cache-1");

    const devItem = result.items.find((i) => i.tier === "developer");
    expect(devItem).toBeDefined();
    expect(devItem!.permissions?.sandboxMode).toBe("read-only");
    expect(devItem!.permissions?.networkAccess).toBe(false);
    expect(devItem!.permissions?.approvalPolicy).toBe("always");
    expect(devItem!.contentHash).toBeString();

    const userItems = result.items.filter((i) => i.tier === "user");
    expect(userItems[0].contentHash).not.toBe(userItems[1].contentHash);
  });

  test("returns empty inputTiers for null body", () => {
    const result = __test.inspectInput(null);
    expect(result.items).toHaveLength(0);
    expect(result.tools.count).toBe(0);
  });

  test("captures all 13 top-level body keys observed in real /responses traffic", () => {
    // mirrors a real /responses body shape from production
    const result = __test.inspectInput({
      model: "gpt-5.5",
      instructions: "You are Codex, OpenAI's coding agent.",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      reasoning: { effort: "medium", summary: "detailed" },
      store: false,
      stream: true,
      tools: [
        { type: "function", name: "exec_command" },
        { type: "custom", name: "apply_patch" },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "session-abc",
      text: { verbosity: "low", format: { type: "text" } },
      client_metadata: { "x-codex-installation-id": "install-xyz-123" },
    });

    // already-existing structured fields
    expect(result.reasoningEffort).toBe("medium");
    expect(result.reasoningSummary).toBe("detailed");
    expect(result.promptCacheKey).toBe("session-abc");
    expect(result.tools.count).toBe(2);
    expect(result.tools.byType).toEqual({ function: 1, custom: 1 });
    expect(result.tools.names).toEqual(["exec_command", "apply_patch"]);

    // newly surfaced fields
    expect(result.store).toBe(false);
    expect(result.stream).toBe(true);
    expect(result.toolChoice).toBe("auto");
    expect(result.parallelToolCalls).toBe(true);
    expect(result.include).toEqual(["reasoning.encrypted_content"]);
    expect(result.textVerbosity).toBe("low");
    expect(result.textFormatType).toBe("text");
    expect(result.clientInstallationId).toBe("install-xyz-123");
    expect(result.instructionsLen).toBe("You are Codex, OpenAI's coding agent.".length);
    expect(result.instructionsHash).toBeString();
    expect(result.instructionsHash!.length).toBe(12); // sha256[:12]
  });

  test("absent body fields produce nulls (not throws or false-positives)", () => {
    const result = __test.inspectInput({ model: "gpt-5.5", input: [] });
    expect(result.store).toBeNull();
    expect(result.stream).toBeNull();
    expect(result.toolChoice).toBeNull();
    expect(result.parallelToolCalls).toBeNull();
    expect(result.include).toBeNull();
    expect(result.textVerbosity).toBeNull();
    expect(result.textFormatType).toBeNull();
    expect(result.clientInstallationId).toBeNull();
    expect(result.instructionsLen).toBeNull();
    expect(result.instructionsHash).toBeNull();
    expect(result.promptCacheKey).toBeNull();
  });

  test("filters non-string entries from include array", () => {
    const result = __test.inspectInput({ input: [], include: ["valid", 42, null, "another"] });
    expect(result.include).toEqual(["valid", "another"]);
  });
});

describe("ChannelCapture routing", () => {
  test("emits harmony channel_chunk lines for final and analysis, tool_call lines for commentary", async () => {
    rmSync(harmonyLog, { force: true });
    rmSync(thinkingLog, { force: true });

    const raw = [
      sse("response.created", { response: { model: "gpt-5.5", usage: { input_tokens: 10 } } }),
      sse("response.reasoning_summary_text.delta", { item_id: "rs_1", output_index: 0, summary_index: 0, delta: "thinking" }),
      sse("response.output_text.delta", { item_id: "msg_1", output_index: 1, content_index: 0, delta: "answer" }),
      sse("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 2, delta: "{\"q" }),
      sse("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 2, delta: "\":\"x\"}" }),
      sse("response.function_call_arguments.done", { item_id: "fc_1", output_index: 2, arguments: "{\"q\":\"x\"}" }),
      sse("response.custom_tool_call_input.delta", { item_id: "ctc_1", output_index: 3, delta: "*** Begin Patch" }),
      sse("response.custom_tool_call_input.done", { item_id: "ctc_1", output_index: 3, input: "*** Begin Patch" }),
      sse("response.completed", { response: { model: "gpt-5.5", status: "completed", usage: { output_tokens: 5 } } }),
    ].join("");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      },
    });

    const relayed = await collect(__test.interceptStream(stream, "gpt-5.5", { requestId: "rtest", path: "/responses", sessionId: "sess-x" }));
    expect(relayed).toBe(raw);

    const lines = readHarmony();
    const channelChunks = lines.filter((l) => l.phase === "response.channel_chunk");
    const finalChunks = channelChunks.filter((l) => l.channel === "final");
    const analysisChunks = channelChunks.filter((l) => l.channel === "analysis");
    const toolDeltas = lines.filter((l) => l.phase === "response.tool_call.delta");
    const toolDones = lines.filter((l) => l.phase === "response.tool_call.done");
    const completed = lines.filter((l) => l.phase === "response.completed");

    expect(finalChunks.length).toBeGreaterThan(0);
    expect(analysisChunks.length).toBeGreaterThan(0);
    expect(finalChunks[0].channel).toBe("final");
    expect(analysisChunks[0].channel).toBe("analysis");
    expect(toolDeltas.length).toBeGreaterThanOrEqual(2);
    expect(toolDones.length).toBeGreaterThanOrEqual(2);
    expect(toolDeltas.every((l) => l.channel === "commentary")).toBe(true);
    expect(completed).toHaveLength(1);
    expect(completed[0].fnCalls).toBe(1);
    expect(completed[0].customCalls).toBe(1);
    expect(completed[0].requestId).toBe("rtest");
    expect(completed[0].sessionId).toBe("sess-x");
  });
});

describe("error + cyber-policy detection", () => {
  test("isCyberPolicyCode matches known policy codes case-insensitively", () => {
    expect(__test.isCyberPolicyCode("cyber_policy")).toBe(true);
    expect(__test.isCyberPolicyCode("CYBER_POLICY")).toBe(true);
    expect(__test.isCyberPolicyCode("policy_violation")).toBe(true);
    expect(__test.isCyberPolicyCode("content_policy_violation")).toBe(true);
    expect(__test.isCyberPolicyCode("moderation_blocked")).toBe(true);
    expect(__test.isCyberPolicyCode(null)).toBe(false);
    expect(__test.isCyberPolicyCode("")).toBe(false);
    expect(__test.isCyberPolicyCode("rate_limit_exceeded")).toBe(false);
    expect(__test.isCyberPolicyCode("invalid_request")).toBe(false);
  });

  test("extractErrorFields pulls code/message/type/param, returns nulls for missing", () => {
    expect(__test.extractErrorFields({ code: "x", message: "m", type: "t", param: "p" }))
      .toEqual({ code: "x", message: "m", type: "t", param: "p" });
    expect(__test.extractErrorFields({ code: 42 }))
      .toEqual({ code: null, message: null, type: null, param: null });
    expect(__test.extractErrorFields(undefined))
      .toEqual({ code: null, message: null, type: null, param: null });
    expect(__test.extractErrorFields({}))
      .toEqual({ code: null, message: null, type: null, param: null });
  });

  test("top-level SSE error event emits response.error_event + cyber_policy_blocked", async () => {
    rmSync(harmonyLog, { force: true });
    const raw = [
      sse("response.created", { response: { model: "gpt-5.5", usage: { input_tokens: 5 } } }),
      sse("error", { error: { code: "cyber_policy", message: "Blocked by policy", type: "policy" } }),
      sse("response.failed", { response: { model: "gpt-5.5", status: "failed", error: { code: "cyber_policy", message: "post-hoc" } } }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "gpt-5.5", { requestId: "rerr1", path: "/responses", sessionId: "sess-err" }));

    const lines = readHarmony();
    const errors = lines.filter((l) => l.phase === "response.error_event");
    const blocked = lines.filter((l) => l.phase === "response.cyber_policy_blocked");

    expect(errors.length).toBe(2);
    expect(errors.some((l) => l.source === "sse_error_event")).toBe(true);
    expect(errors.some((l) => l.source === "response_failed")).toBe(true);
    expect(errors.every((l) => l.code === "cyber_policy")).toBe(true);
    expect(errors.every((l) => l.cyberPolicy === true)).toBe(true);

    expect(blocked.length).toBe(2);
    expect(blocked.every((l) => l.requestId === "rerr1")).toBe(true);
    expect(blocked.every((l) => l.sessionId === "sess-err")).toBe(true);
  });

  test("non-policy errors emit response.error_event but NOT cyber_policy_blocked", async () => {
    rmSync(harmonyLog, { force: true });
    const raw = [
      sse("error", { error: { code: "rate_limit_exceeded", message: "Slow down", type: "rate_limit" } }),
      sse("response.failed", { response: { model: "gpt-5.5", error: { code: "invalid_request", message: "bad input" } } }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "gpt-5.5", { requestId: "rerr2", path: "/responses", sessionId: "sess-rate" }));

    const lines = readHarmony();
    const errors = lines.filter((l) => l.phase === "response.error_event");
    const blocked = lines.filter((l) => l.phase === "response.cyber_policy_blocked");

    expect(errors.length).toBe(2);
    expect(errors.find((l) => l.source === "sse_error_event")?.code).toBe("rate_limit_exceeded");
    expect(errors.find((l) => l.source === "response_failed")?.code).toBe("invalid_request");
    expect(errors.every((l) => l.cyberPolicy === false)).toBe(true);
    expect(blocked.length).toBe(0);
  });

  test("response.completed with stop_reason=cyber_policy emits cyber_policy_blocked (real-world path)", async () => {
    rmSync(harmonyLog, { force: true });
    const raw = [
      sse("response.created", { response: { model: "gpt-5.5" } }),
      sse("response.completed", {
        response: {
          model: "gpt-5.5",
          status: "completed",
          stop_reason: "cyber_policy",
          metadata: { openai_verification_recommendation: ["trusted_access_for_cyber"] },
        },
      }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "gpt-5.5", { requestId: "rcyb1", path: "/responses", sessionId: "sess-cyb" }));

    const lines = readHarmony();
    const blocked = lines.filter((l) => l.phase === "response.cyber_policy_blocked");
    const errors = lines.filter((l) => l.phase === "response.error_event");

    expect(blocked.length).toBe(1);
    expect(blocked[0].code).toBe("cyber_policy");
    expect(blocked[0].source).toBe("response_completed_stop_reason");
    expect(blocked[0].metadata?.openai_verification_recommendation).toEqual(["trusted_access_for_cyber"]);
    expect(errors.length).toBe(1);
    expect(errors[0].cyberPolicy).toBe(true);
  });

  test("SSE error envelope without nested .error works (top-level fields)", async () => {
    rmSync(harmonyLog, { force: true });
    const raw = [
      sse("error", { code: "policy_violation", message: "no nested wrapper" }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "gpt-5.5", { requestId: "rerr3", path: "/responses", sessionId: "sess-flat" }));

    const lines = readHarmony();
    const errors = lines.filter((l) => l.phase === "response.error_event");
    const blocked = lines.filter((l) => l.phase === "response.cyber_policy_blocked");
    expect(errors.length).toBe(1);
    expect(errors[0].code).toBe("policy_violation");
    expect(blocked.length).toBe(1);
  });
});

describe("refusal + divergence integration", () => {
  test("emits response.refusal_detected with divergent=true when analysis substantive but final refuses", async () => {
    rmSync(harmonyLog, { force: true });
    const analysisDelta = "I should think about this carefully. The user is asking about regex syntax. " +
      "Let me consider patterns. ".repeat(30);
    const finalDelta = "I'm sorry, but I can't help with that.";
    const raw = [
      sse("response.created", { response: { model: "gpt-5.5" } }),
      sse("response.reasoning_text.delta", { item_id: "rs_1", output_index: 0, content_index: 0, delta: analysisDelta }),
      sse("response.output_text.delta", { item_id: "msg_1", output_index: 1, content_index: 0, delta: finalDelta }),
      sse("response.completed", { response: { model: "gpt-5.5", status: "completed", usage: { output_tokens: 50 } } }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "gpt-5.5", { requestId: "rref1", path: "/responses", sessionId: "sess-ref" }));

    const lines = readHarmony();
    const refusals = lines.filter((l) => l.phase === "response.refusal_detected");
    expect(refusals.length).toBe(1);
    expect(refusals[0].refusal.isRefusal).toBe(true);
    expect(refusals[0].divergence.divergent).toBe(true);
    expect(refusals[0].divergence.reason).toBe("final_refusal_after_substantive_analysis");
    expect(refusals[0].requestId).toBe("rref1");
    expect(refusals[0].sessionId).toBe("sess-ref");
  });

  test("does NOT emit response.refusal_detected for normal helpful response", async () => {
    rmSync(harmonyLog, { force: true });
    const raw = [
      sse("response.created", { response: { model: "gpt-5.5" } }),
      sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "Sure, here's the answer." }),
      sse("response.completed", { response: { model: "gpt-5.5", status: "completed", usage: { output_tokens: 10 } } }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });
    await collect(__test.interceptStream(stream, "gpt-5.5", { requestId: "rref2", path: "/responses", sessionId: "sess-ok" }));

    const refusals = readHarmony().filter((l) => l.phase === "response.refusal_detected");
    expect(refusals.length).toBe(0);
  });
});

describe("buildAnalysisByRequest", () => {
  test("groups channel chunks by requestId, separates analysis vs final, picks up metadata", () => {
    const records = [
      { at: "2026-04-28T00:00:01Z", requestId: "r1", sessionId: "s1", phase: "request.tier_summary", inputTiers: { user: { messages: 1 } } },
      { at: "2026-04-28T00:00:02Z", requestId: "r1", sessionId: "s1", phase: "response.channel_chunk", channel: "analysis", contentHead: "thinking step 1 " },
      { at: "2026-04-28T00:00:03Z", requestId: "r1", sessionId: "s1", phase: "response.channel_chunk", channel: "analysis", contentHead: "thinking step 2" },
      { at: "2026-04-28T00:00:04Z", requestId: "r1", sessionId: "s1", phase: "response.channel_chunk", channel: "final", contentHead: "answer" },
      { at: "2026-04-28T00:00:05Z", requestId: "r1", sessionId: "s1", phase: "response.completed", model: "gpt-5.5", inputTokens: 100, outputTokens: 20, metadata: { openai_verification_recommendation: ["trusted_access_for_cyber"] }, encryptedReasoningCount: 2 },
      { at: "2026-04-28T00:00:10Z", requestId: "r2", sessionId: "s2", phase: "response.channel_chunk", channel: "analysis", contentHead: "different session" },
      { at: "2026-04-28T00:00:11Z", requestId: "r2", sessionId: "s2", phase: "response.completed", model: "gpt-5.5", inputTokens: 50, outputTokens: 5, encryptedReasoningCount: 0 },
    ];
    const r1 = __test.buildAnalysisByRequest(records, { sessionId: "s1" });
    expect(r1).toHaveLength(1);
    expect(r1[0].requestId).toBe("r1");
    expect(r1[0].analysis.join("")).toBe("thinking step 1 thinking step 2");
    expect(r1[0].final.join("")).toBe("answer");
    expect(r1[0].model).toBe("gpt-5.5");
    expect(r1[0].metadata.openai_verification_recommendation).toEqual(["trusted_access_for_cyber"]);
    expect(r1[0].encryptedCount).toBe(2);
    expect(r1[0].tokens).toEqual({ input: 100, output: 20 });

    const all = __test.buildAnalysisByRequest(records, {});
    expect(all).toHaveLength(2);
    expect(all[0].sessionId).toBe("s1");
    expect(all[1].sessionId).toBe("s2");
  });

  test("uses content over contentHead when full mode is on", () => {
    const records = [
      { at: "t1", requestId: "r1", phase: "response.channel_chunk", channel: "analysis", contentHead: "short", content: "this is the full content" },
      { at: "t2", requestId: "r1", phase: "response.completed" },
    ];
    const r = __test.buildAnalysisByRequest(records, {});
    expect(r[0].analysis.join("")).toBe("this is the full content");
  });

  test("returns empty when session filter doesn't match", () => {
    const records = [
      { at: "t", requestId: "r", sessionId: "x", phase: "response.channel_chunk", channel: "analysis", contentHead: "hi" },
    ];
    const r = __test.buildAnalysisByRequest(records, { sessionId: "nope" });
    expect(r).toHaveLength(0);
  });
});

describe("metadata harvest", () => {
  test("captures response.metadata events + harvests nested metadata blocks", async () => {
    rmSync(harmonyLog, { force: true });

    const raw = [
      sse("response.created", { response: { id: "resp_test1", model: "gpt-5.5", usage: { input_tokens: 5 } } }),
      sse("response.metadata", { response_id: "resp_test1", sequence_number: 2, metadata: { openai_verification_recommendation: ["trusted_access_for_cyber"] } }),
      sse("response.output_text.delta", { item_id: "m1", output_index: 0, content_index: 0, delta: "hi" }),
      sse("response.output_item.added", { item: { id: "rs_1", type: "reasoning", encrypted_content: "gAAAAAB" + "x".repeat(500) } }),
      sse("response.completed", { response: { id: "resp_test1", status: "completed", model: "gpt-5.5", usage: { output_tokens: 2 }, metadata: { extra_field: "extra_value" } } }),
    ].join("");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });

    await collect(__test.interceptStream(stream, "gpt-5.5", { requestId: "metatest", path: "/responses", sessionId: "sess-meta" }));

    const lines = readHarmony();
    const completed = lines.find((l) => l.phase === "response.completed");
    expect(completed).toBeDefined();
    expect(completed!.metadata).toBeDefined();
    expect(completed!.metadata.openai_verification_recommendation).toEqual(["trusted_access_for_cyber"]);
    expect(completed!.metadata.extra_field).toBe("extra_value");
    expect(completed!.responseId).toBe("resp_test1");
    expect(completed!.encryptedReasoningCount).toBe(1);
    expect(completed!.encryptedReasoningTotalBytes).toBeGreaterThan(500);

    const metaObserved = lines.filter((l) => l.phase === "response.metadata_observed");
    expect(metaObserved.length).toBeGreaterThanOrEqual(1);
    expect(metaObserved[0].metadata.openai_verification_recommendation).toEqual(["trusted_access_for_cyber"]);
  });

  test("ignores empty metadata objects", async () => {
    rmSync(harmonyLog, { force: true });

    const raw = [
      sse("response.created", { response: { id: "resp_no_meta", model: "gpt-5.5", metadata: {} } }),
      sse("response.completed", { response: { id: "resp_no_meta", status: "completed", model: "gpt-5.5", usage: { output_tokens: 1 } } }),
    ].join("");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(raw)); controller.close(); },
    });

    await collect(__test.interceptStream(stream, "gpt-5.5", { requestId: "nometatest" }));
    const lines = readHarmony();
    const observed = lines.filter((l) => l.phase === "response.metadata_observed");
    expect(observed.length).toBe(0);
  });
});

describe("hooks", () => {
  test("onSseEvent can drop and mutate events", async () => {
    rmSync(harmonyLog, { force: true });

    __test.setHooksForTest({
      onSseEvent(event) {
        if (event.type === "response.output_text.delta" && event.delta === "DROPME") return "drop";
        if (event.type === "response.output_text.delta" && event.delta === "MUTATE") {
          return { ...event, delta: "MUTATED" };
        }
        return null;
      },
    });

    const raw = [
      sse("response.output_text.delta", { item_id: "m1", output_index: 0, content_index: 0, delta: "keep" }),
      sse("response.output_text.delta", { item_id: "m1", output_index: 0, content_index: 0, delta: "DROPME" }),
      sse("response.output_text.delta", { item_id: "m1", output_index: 0, content_index: 0, delta: "MUTATE" }),
      sse("response.completed", { response: { model: "gpt-5.5", status: "completed", usage: { output_tokens: 3 } } }),
    ].join("");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      },
    });

    const relayed = await collect(__test.interceptStream(stream, "gpt-5.5", { requestId: "hooktest" }));

    expect(relayed).toContain("keep");
    expect(relayed).not.toContain("DROPME");
    expect(relayed).toContain("MUTATED");
    expect(relayed).not.toContain("\"delta\":\"MUTATE\"");

    __test.setHooksForTest({});
  });

  test("onResponseComplete fires with channel snapshot", async () => {
    rmSync(harmonyLog, { force: true });
    let snapshot: any = null;
    __test.setHooksForTest({
      onResponseComplete(snap) {
        snapshot = snap;
      },
    });

    const raw = [
      sse("response.created", { response: { model: "gpt-5.5", usage: { input_tokens: 7 } } }),
      sse("response.output_text.delta", { item_id: "m1", output_index: 0, content_index: 0, delta: "hello" }),
      sse("response.reasoning_summary_text.delta", { item_id: "rs", output_index: 1, summary_index: 0, delta: "think" }),
      sse("response.completed", { response: { model: "gpt-5.5", status: "completed", usage: { input_tokens: 7, output_tokens: 4 } } }),
    ].join("");

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      },
    });

    await collect(__test.interceptStream(stream, "gpt-5.5", { requestId: "snaptest" }));

    expect(snapshot).not.toBeNull();
    expect(snapshot.requestId).toBe("snaptest");
    expect(snapshot.channels.final).toBe("hello");
    expect(snapshot.channels.analysis).toBe("think");
    expect(snapshot.inputTokens).toBe(7);
    expect(snapshot.outputTokens).toBe(4);

    __test.setHooksForTest({});
  });
});
