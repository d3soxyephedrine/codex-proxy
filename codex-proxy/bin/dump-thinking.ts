#!/usr/bin/env bun
// dump-thinking — extract analysis-channel CoT from harmony.ndjson for one session
//
// Usage:
//   bun run bin/dump-thinking.ts                     # latest session, all turns
//   bun run bin/dump-thinking.ts <session-id>        # specific session
//   bun run bin/dump-thinking.ts --json              # JSON output
//   bun run bin/dump-thinking.ts <session-id> --raw  # plain text only

const PROXY = process.env.CODEX_PROXY_BASE || "http://127.0.0.1:3462";

const args = process.argv.slice(2);
const formatJson = args.includes("--json");
const raw = args.includes("--raw");
const sessionArg = args.find((a) => !a.startsWith("--")) || null;

async function fetchAnalysis(sessionId: string | null): Promise<any> {
  const url = new URL("/debug/analysis", PROXY);
  url.searchParams.set("limit", "100000");
  if (sessionId) url.searchParams.set("session", sessionId);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`proxy ${PROXY} returned ${res.status}: ${await res.text()}`);
  }
  return await res.json();
}

async function listSessions(): Promise<{ sessionId: string; turns: number; lastAt: string }[]> {
  const url = new URL("/debug/harmony", PROXY);
  url.searchParams.set("limit", "5000");
  url.searchParams.set("phase", "response.completed");
  const res = await fetch(url);
  const data = await res.json() as any;
  const seen = new Map<string, { turns: number; lastAt: string }>();
  for (const r of (data.records || [])) {
    const s = r.sessionId || "(unknown)";
    const cur = seen.get(s) || { turns: 0, lastAt: "" };
    cur.turns += 1;
    if (r.at && r.at > cur.lastAt) cur.lastAt = r.at;
    seen.set(s, cur);
  }
  return [...seen.entries()].map(([sessionId, v]) => ({ sessionId, ...v }));
}

async function main() {
  let sessionId = sessionArg;

  if (!sessionId) {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.error("no completed responses found in harmony log");
      process.exit(1);
    }
    sessions.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    sessionId = sessions[0].sessionId;
    if (!raw) console.error(`# auto-selected session: ${sessionId}  (${sessions[0].turns} turns, last ${sessions[0].lastAt})`);
    if (!raw) console.error(`# other recent sessions:`);
    if (!raw) for (const s of sessions.slice(1, 6)) console.error(`#   ${s.sessionId}  (${s.turns} turns)`);
    if (!raw) console.error("");
  }

  const data = await fetchAnalysis(sessionId);
  const turns = data.turns || [];

  if (formatJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (turns.length === 0) {
    console.error(`(no turns found for session ${sessionId})`);
    return;
  }

  if (raw) {
    for (const t of turns) {
      if (t.analysis) console.log(t.analysis);
      console.log("");
    }
    return;
  }

  // Default: pretty markdown
  console.log(`# Analysis dump — session ${sessionId}`);
  console.log(``);
  console.log(`${turns.length} turns observed.`);
  console.log(``);

  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i];
    console.log(`## Turn ${i + 1} — ${t.firstAt || "?"}`);
    console.log(`requestId: \`${t.requestId}\` · model: ${t.model || "?"} · tokens in/out: ${t.tokens.input ?? "?"}/${t.tokens.output ?? "?"} · encrypted-reasoning blocks: ${t.encryptedReasoningCount}`);
    if (t.metadata && Object.keys(t.metadata).length > 0) {
      console.log(`metadata: \`${JSON.stringify(t.metadata)}\``);
    }
    console.log("");
    if (t.analysis) {
      console.log(`### analysis (chain of thought, ${t.analysisLen} chars)`);
      console.log("```");
      console.log(t.analysis);
      console.log("```");
      console.log("");
    }
    if (t.final) {
      console.log(`### final answer (${t.finalLen} chars)`);
      console.log(t.final);
      console.log("");
    }
  }

  if ((data.turns?.[0]?.analysisLen ?? 0) <= 256 && turns.length > 0) {
    console.error("");
    console.error("# NOTE: Analysis chunks may be truncated. The proxy currently runs in 'head' mode");
    console.error("# (default CODEX_PROXY_HARMONY_CONTENT=head, head limit 256 chars per chunk).");
    console.error("# To capture full plaintext CoT, restart proxy with CODEX_PROXY_HARMONY_CONTENT=full.");
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
