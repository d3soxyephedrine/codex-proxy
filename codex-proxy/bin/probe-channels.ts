#!/usr/bin/env bun
// probe-channels — fire the same prompt through each peek-* profile and diff what comes back.
//
// Usage:
//   bun run bin/probe-channels.ts                              # default prompt
//   bun run bin/probe-channels.ts "your prompt here"
//   bun run bin/probe-channels.ts --model gpt-5.4-mini "..."
//   bun run bin/probe-channels.ts --json                       # machine-readable output

const PROXY = process.env.CODEX_PROXY_BASE || "http://127.0.0.1:3462";
const PROFILES = ["director", "peek-final", "peek-analysis", "peek-commentary", "peek-include"];
const DEFAULT_PROMPT = "What is the smallest prime number that is the sum of three distinct primes? Think step-by-step.";

const args = process.argv.slice(2);
const formatJson = args.includes("--json");
let model = "gpt-5.4-mini";
const modelIdx = args.indexOf("--model");
if (modelIdx >= 0 && args[modelIdx + 1]) {
  model = args[modelIdx + 1];
  args.splice(modelIdx, 2);
}
const prompt = args.find((a) => !a.startsWith("--")) || DEFAULT_PROMPT;

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
const c = (s: string, ...codes: string[]) => codes.join("") + s + ANSI.reset;

interface ProbeResult {
  profile: string;
  status: number;
  finalText: string;
  analysisText: string;
  toolCalls: { name: string | null; args: string }[];
  inputTokens: number | null;
  outputTokens: number | null;
  encryptedReasoningCount: number;
  metadata: Record<string, any> | null;
  bodyOverridesApplied: string[];
  rawSseEventTypes: Record<string, number>;
  errorMessage?: string;
}

function parseSse(raw: string): {
  finalParts: string[];
  analysisParts: string[];
  toolCalls: Map<string, { name: string | null; args: string }>;
  events: Record<string, number>;
  responseObj: Record<string, any> | null;
} {
  const finalParts: string[] = [];
  const analysisParts: string[] = [];
  const toolCalls = new Map<string, { name: string | null; args: string }>();
  const events: Record<string, number> = {};
  let responseObj: Record<string, any> | null = null;

  for (const block of raw.split("\n\n")) {
    if (!block.trim()) continue;
    const dataLines = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") continue;
    let evt: any;
    try { evt = JSON.parse(payload); } catch { continue; }
    const t = typeof evt.type === "string" ? evt.type : "unknown";
    events[t] = (events[t] || 0) + 1;
    if (t === "response.output_text.delta") finalParts.push(evt.delta || "");
    else if (t === "response.reasoning_summary_text.delta") analysisParts.push(evt.delta || "");
    else if (t === "response.reasoning_text.delta") analysisParts.push(evt.delta || "");
    else if (t === "response.function_call_arguments.delta") {
      const id = evt.item_id || `out:${evt.output_index}`;
      const cur = toolCalls.get(id) || { name: null, args: "" };
      cur.args += evt.delta || "";
      toolCalls.set(id, cur);
    } else if (t === "response.output_item.added" && evt.item?.type === "function_call") {
      const id = evt.item.id;
      const cur = toolCalls.get(id) || { name: null, args: "" };
      cur.name = evt.item.name || cur.name;
      toolCalls.set(id, cur);
    } else if (t === "response.completed" || t === "response.failed" || t === "response.incomplete") {
      responseObj = evt.response || null;
    }
  }
  return { finalParts, analysisParts, toolCalls, events, responseObj };
}

async function probeOne(profile: string): Promise<ProbeResult> {
  const body = {
    model,
    stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [
      { type: "function", name: "lookup_fact", description: "Look up a fact in the knowledge base.", parameters: { type: "object", properties: { query: { type: "string" } } } },
    ],
  };
  const sessionId = `probe-${profile}-${Date.now()}`;
  let raw = "";
  let status = 0;
  let errorMessage: string | undefined;
  try {
    const res = await fetch(`${PROXY}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "text/event-stream",
        "x-codex-proxy-profile": profile,
        "x-codex-session-id": sessionId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    status = res.status;
    raw = await res.text();
    if (!res.ok) errorMessage = raw.slice(0, 200);
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const parsed = parseSse(raw);
  const final = parsed.finalParts.join("");
  const analysis = parsed.analysisParts.join("");
  const calls = [...parsed.toolCalls.values()];

  // grab the bodyOverridesApplied from harmony log
  let bodyOverridesApplied: string[] = [];
  try {
    const url = new URL(`/debug/harmony`, PROXY);
    url.searchParams.set("limit", "200");
    url.searchParams.set("sessionId", sessionId);
    const r = await fetch(url);
    const d = await r.json() as any;
    const apply = (d.records || []).find((rec: any) => rec.phase === "request.profile_applied");
    if (apply?.bodyOverridesApplied) bodyOverridesApplied = apply.bodyOverridesApplied;
  } catch { /* ignore */ }

  const usage = parsed.responseObj?.usage;
  return {
    profile,
    status,
    finalText: final,
    analysisText: analysis,
    toolCalls: calls,
    inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : null,
    outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : null,
    encryptedReasoningCount: 0, // would need to look at output_item.added with type=reasoning
    metadata: parsed.responseObj?.metadata || null,
    bodyOverridesApplied,
    rawSseEventTypes: parsed.events,
    errorMessage,
  };
}

function preview(s: string, n: number): string {
  if (!s) return "(empty)";
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > n ? collapsed.slice(0, n) + "…" : collapsed;
}

async function main() {
  console.log(c(`probe-channels`, ANSI.bold, ANSI.cyan) + c(`  ·  proxy=${PROXY}  model=${model}`, ANSI.dim));
  console.log(c(`prompt: ${prompt}`, ANSI.dim));
  console.log(c(`profiles: ${PROFILES.join(", ")}`, ANSI.dim));
  console.log("");

  const results: ProbeResult[] = [];
  for (const p of PROFILES) {
    process.stderr.write(c(`firing ${p}...`, ANSI.gray));
    const r = await probeOne(p);
    results.push(r);
    process.stderr.write(c(` ✓ ${r.status}  in=${r.inputTokens ?? "?"} out=${r.outputTokens ?? "?"}  final=${r.finalText.length}b analysis=${r.analysisText.length}b tools=${r.toolCalls.length}\n`, ANSI.gray));
  }
  process.stderr.write("\n");

  if (formatJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Side-by-side table
  console.log(c(`${"profile".padEnd(18)}  ${"status".padEnd(7)}  ${"final".padStart(7)}  ${"analysis".padStart(9)}  ${"tools".padStart(6)}  ${"in/out tok".padStart(11)}  overrides`, ANSI.bold));
  console.log(c("─".repeat(110), ANSI.gray));
  for (const r of results) {
    const ovr = r.bodyOverridesApplied.join(",") || "-";
    console.log(
      `${r.profile.padEnd(18)}  ${String(r.status).padEnd(7)}  ${String(r.finalText.length).padStart(7)}  ${String(r.analysisText.length).padStart(9)}  ${String(r.toolCalls.length).padStart(6)}  ${(r.inputTokens + "/" + r.outputTokens).padStart(11)}  ${c(ovr, ANSI.dim)}`
    );
  }
  console.log("");

  for (const r of results) {
    console.log(c(`══ ${r.profile} ══`, ANSI.bold, ANSI.cyan));
    if (r.errorMessage) {
      console.log(c(`  ERROR: ${r.errorMessage}`, ANSI.red));
      console.log("");
      continue;
    }
    console.log(c(`  final    `, ANSI.green) + ` (${r.finalText.length}b): ${preview(r.finalText, 200)}`);
    console.log(c(`  analysis `, ANSI.magenta) + ` (${r.analysisText.length}b): ${preview(r.analysisText, 200)}`);
    if (r.toolCalls.length > 0) {
      console.log(c(`  commentary`, ANSI.yellow) + ` (${r.toolCalls.length} call${r.toolCalls.length > 1 ? "s" : ""}):`);
      for (const tc of r.toolCalls) {
        console.log(`    ${c(tc.name || "(unknown)", ANSI.bold)}: ${preview(tc.args, 160)}`);
      }
    } else {
      console.log(c(`  commentary  (0 calls)`, ANSI.dim));
    }
    if (r.metadata && Object.keys(r.metadata).length > 0) {
      console.log(c(`  metadata `, ANSI.cyan) + ` ${JSON.stringify(r.metadata)}`);
    }
    console.log("");
  }

  // Diagnose channel isolation
  console.log(c(`══ channel-isolation diagnostics ══`, ANSI.bold, ANSI.yellow));
  const final = results.find((r) => r.profile === "peek-final");
  const analysis = results.find((r) => r.profile === "peek-analysis");
  const commentary = results.find((r) => r.profile === "peek-commentary");
  if (final) {
    const ok = final.toolCalls.length === 0 && final.analysisText.length === 0 && final.finalText.length > 0;
    console.log(`  peek-final  isolates final-only: ${ok ? c("✓", ANSI.green) : c("✗", ANSI.red)}  (commentary=${final.toolCalls.length}, analysis=${final.analysisText.length}b, final=${final.finalText.length}b)`);
  }
  if (analysis) {
    const ratio = analysis.finalText.length === 0 ? Infinity : analysis.analysisText.length / Math.max(1, analysis.finalText.length);
    const ok = analysis.toolCalls.length === 0 && ratio > 5;
    console.log(`  peek-analysis  analysis ≫ final: ${ok ? c("✓", ANSI.green) : c("⚠", ANSI.yellow)}  (analysis/final ratio=${ratio.toFixed(1)}, tools=${analysis.toolCalls.length})`);
  }
  if (commentary) {
    const ok = commentary.toolCalls.length > 0;
    console.log(`  peek-commentary  forces a tool call: ${ok ? c("✓", ANSI.green) : c("✗", ANSI.red)}  (tools=${commentary.toolCalls.length}, final=${commentary.finalText.length}b)`);
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
