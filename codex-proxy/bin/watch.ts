#!/usr/bin/env bun
import { existsSync, statSync } from "fs";
import { open } from "fs/promises";

const HARMONY_LOG = process.env.CODEX_PROXY_HARMONY_LOG_FILE || "/tmp/codex-proxy-harmony.ndjson";
const PROXY = process.env.CODEX_PROXY_BASE || "http://127.0.0.1:3462";
const POLL_MS = Number.parseInt(process.env.CODEX_PROXY_WATCH_POLL_MS || "200", 10);
const STATS_INTERVAL_MS = 5000;
const FOLLOW_FROM_END = process.argv.includes("--from-end") || !process.argv.includes("--all");

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[97m",
  gray: "\x1b[90m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
};

function paint(s: string, ...codes: string[]): string {
  return codes.join("") + s + ANSI.reset;
}

interface RunningStats {
  startedAt: number;
  requests: number;
  injections: number;
  injectionsBySeverity: Record<string, number>;
  injectionsByRule: Record<string, number>;
  profileApplied: Record<string, number>;
  profileRejected: number;
  profileRateLimited: number;
  channelDropped: number;
  toolCalls: number;
  channelChunks: { final: number; analysis: number; commentary: number };
}

const stats: RunningStats = {
  startedAt: Date.now(),
  requests: 0,
  injections: 0,
  injectionsBySeverity: {},
  injectionsByRule: {},
  profileApplied: {},
  profileRejected: 0,
  profileRateLimited: 0,
  channelDropped: 0,
  toolCalls: 0,
  channelChunks: { final: 0, analysis: 0, commentary: 0 },
};

function fmtTime(iso: string | undefined): string {
  if (!iso) return "??:??:??";
  return iso.slice(11, 19);
}

function shortRequest(id: string): string {
  return id ? id.split("-").slice(-1)[0].slice(0, 4) : "----";
}

function severityColor(sev: string): string[] {
  if (sev === "critical") return [ANSI.bold, ANSI.bgRed, ANSI.white];
  if (sev === "high") return [ANSI.bold, ANSI.red];
  if (sev === "medium") return [ANSI.yellow];
  return [ANSI.gray];
}

function severityBadge(sev: string): string {
  return paint(` ${sev.toUpperCase()} `, ...severityColor(sev));
}

function renderEvent(rec: Record<string, any>) {
  const t = paint(fmtTime(rec.at), ANSI.gray);
  const reqId = paint(`#${shortRequest(rec.requestId)}`, ANSI.dim);

  switch (rec.phase) {
    case "request.tier_summary": {
      stats.requests += 1;
      const tiers = rec.inputTiers || {};
      const parts = Object.entries(tiers).map(([tier, v]: [string, any]) => `${tier}:${v.messages}`).join(" ");
      const tools = rec.toolCount ? paint(`tools:${rec.toolCount}`, ANSI.cyan) : "";
      const effort = rec.reasoningEffort ? paint(`effort:${rec.reasoningEffort}`, ANSI.cyan) : "";
      console.log(`${t} ${reqId} ${paint("REQ", ANSI.bold, ANSI.cyan)}  ${parts}  ${tools} ${effort}`);
      break;
    }

    case "request.input_item": {
      // skip — covered by tier_summary
      break;
    }

    case "request.permissions_claim": {
      const sb = rec.sandboxMode || "?";
      const net = rec.networkAccess === true ? "net+" : rec.networkAccess === false ? "net-" : "net?";
      const ap = rec.approvalPolicy || "?";
      const sbColor = sb === "danger-full-access" ? ANSI.red : sb === "read-only" ? ANSI.green : ANSI.yellow;
      console.log(`${t} ${reqId} ${paint("PERM", ANSI.magenta)} sandbox=${paint(sb, sbColor)} ${net} approval=${ap}`);
      break;
    }

    case "request.profile_applied": {
      const profile = rec.profile || "?";
      stats.profileApplied[profile] = (stats.profileApplied[profile] || 0) + 1;
      const flags: string[] = [];
      if (rec.demoted > 0) flags.push(paint(`demoted:${rec.demoted}`, ANSI.yellow));
      if (Array.isArray(rec.toolsRemoved) && rec.toolsRemoved.length > 0) flags.push(paint(`-tools:${rec.toolsRemoved.join(",")}`, ANSI.yellow));
      if (rec.contentTruncatedBytes > 0) flags.push(paint(`trunc:${rec.contentTruncatedBytes}b`, ANSI.yellow));
      if (rec.prefixInjected) flags.push(paint(`+prefix`, ANSI.green));
      const rate = typeof rec.rateRemaining === "number" ? paint(`rate:${rec.rateRemaining}`, ANSI.dim) : "";
      console.log(`${t} ${reqId} ${paint("PROF", ANSI.blue)} ${paint(profile, ANSI.bold, ANSI.blue)} ${flags.join(" ")} ${rate}`);
      break;
    }

    case "request.profile_rejected": {
      stats.profileRejected += 1;
      console.log(`${t} ${reqId} ${paint("REJECT", ANSI.bold, ANSI.bgRed, ANSI.white)} profile=${rec.profile} ${paint(rec.reason || "", ANSI.red)}`);
      break;
    }

    case "request.profile_rate_limited": {
      stats.profileRateLimited += 1;
      console.log(`${t} ${reqId} ${paint("RATE", ANSI.bold, ANSI.yellow)} profile=${rec.profile} resetIn=${Math.round((rec.resetIn || 0) / 1000)}s`);
      break;
    }

    case "request.injection_detected": {
      stats.injections += 1;
      stats.injectionsBySeverity[rec.severity] = (stats.injectionsBySeverity[rec.severity] || 0) + 1;
      stats.injectionsByRule[rec.rule] = (stats.injectionsByRule[rec.rule] || 0) + 1;
      const badge = severityBadge(rec.severity || "low");
      console.log(`${t} ${reqId} ${paint("🚨 INJECTION", ANSI.bold, ANSI.red)} ${badge} rule=${paint(rec.rule, ANSI.bold)} tier=${rec.tier || "?"}`);
      console.log(`        ${paint("→", ANSI.red)} ${paint(rec.description || "", ANSI.italic, ANSI.red)}`);
      console.log(`        ${paint(rec.matchedSnippet || "", ANSI.bold, ANSI.white)}`);
      break;
    }

    case "request.injection_summary": {
      // already printed individual detections; this is a roll-up
      break;
    }

    case "request.hook_mutated": {
      console.log(`${t} ${reqId} ${paint("HOOK", ANSI.magenta)} request body mutated`);
      break;
    }

    case "response.profile_channel_dropped": {
      stats.channelDropped += 1;
      console.log(`${t} ${reqId} ${paint("DROP", ANSI.dim, ANSI.yellow)} channel=${rec.channel} type=${rec.type}`);
      break;
    }

    case "response.channel_chunk": {
      const ch = rec.channel as "final" | "analysis" | "commentary";
      if (ch === "final" || ch === "analysis" || ch === "commentary") {
        stats.channelChunks[ch] += 1;
      }
      const head = (rec.contentHead || "").slice(0, 80).replace(/\s+/g, " ").trim();
      if (!head) break;
      if (ch === "analysis") {
        console.log(`${t} ${reqId} ${paint("💭", ANSI.magenta)} ${paint(head, ANSI.dim, ANSI.magenta)}`);
      } else if (ch === "final") {
        console.log(`${t} ${reqId} ${paint("📤", ANSI.green)} ${paint(head, ANSI.green)}`);
      }
      break;
    }

    case "response.tool_call.delta":
    case "response.tool_call.done": {
      if (rec.phase === "response.tool_call.done") {
        stats.toolCalls += 1;
        const head = (rec.contentHead || "").slice(0, 80).replace(/\s+/g, " ").trim();
        const name = rec.name || "(unknown)";
        const kind = rec.toolType === "custom_tool_call" ? "🛠 " : "🔧 ";
        console.log(`${t} ${reqId} ${paint(kind, ANSI.yellow)}${paint(name, ANSI.bold, ANSI.yellow)}  ${paint(head, ANSI.dim)}`);
      }
      break;
    }

    case "response.completed": {
      const dur = "";
      const tokens = rec.outputTokens != null ? `out:${rec.outputTokens}` : "";
      const stop = rec.stopReason || "?";
      const fc = rec.fnCalls || 0;
      const cc = rec.customCalls || 0;
      const callsPart = fc + cc > 0 ? ` calls:${fc}+${cc}` : "";
      console.log(`${t} ${reqId} ${paint("DONE", ANSI.green)} ${tokens} stop=${stop}${callsPart} ${dur}`);
      break;
    }
  }
}

function renderStats() {
  const uptimeS = Math.floor((Date.now() - stats.startedAt) / 1000);
  const inj = stats.injections;
  const injPart = inj > 0
    ? paint(`🚨 ${inj} inj`, ANSI.bold, ANSI.red) + " (" + Object.entries(stats.injectionsBySeverity).map(([s, n]) => `${s}:${n}`).join(" ") + ")"
    : paint("0 inj", ANSI.dim);
  const profStr = Object.entries(stats.profileApplied).map(([p, n]) => `${p}:${n}`).join(" ") || "-";
  const channels = stats.channelChunks;
  const chStr = `final:${channels.final} analysis:${channels.analysis} commentary:${channels.commentary}`;
  const sep = paint("─".repeat(80), ANSI.gray);
  console.log(sep);
  console.log(
    `${paint("📊", ANSI.cyan)} ${paint(`uptime ${uptimeS}s`, ANSI.dim)}  ` +
    `reqs ${paint(String(stats.requests), ANSI.bold)}  ` +
    `tools ${paint(String(stats.toolCalls), ANSI.yellow)}  ` +
    `chunks { ${chStr} }  ` +
    `${injPart}  ` +
    `profiles { ${profStr} }  ` +
    `rej ${stats.profileRejected}  rate-limited ${stats.profileRateLimited}  dropped ${stats.channelDropped}`
  );
  console.log(sep);
}

async function tailLoop() {
  let position = 0;
  if (existsSync(HARMONY_LOG)) {
    if (FOLLOW_FROM_END) {
      position = statSync(HARMONY_LOG).size;
    }
  }

  let buffer = "";
  let lastSize = position;

  while (true) {
    if (!existsSync(HARMONY_LOG)) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }

    const size = statSync(HARMONY_LOG).size;
    if (size < lastSize) {
      // Truncated/rotated — start over
      position = 0;
      buffer = "";
    }
    lastSize = size;

    if (size > position) {
      const fh = await open(HARMONY_LOG, "r");
      try {
        const len = size - position;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, position);
        buffer += buf.toString("utf8");
        position = size;
      } finally {
        await fh.close();
      }

      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) {
          try {
            const rec = JSON.parse(line);
            renderEvent(rec);
          } catch {
            // skip malformed
          }
        }
        nl = buffer.indexOf("\n");
      }
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function probeProxy() {
  try {
    const res = await fetch(`${PROXY}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return await res.json() as Record<string, any>;
  } catch {
    return null;
  }
}

async function main() {
  const banner = paint("codex-proxy watch", ANSI.bold, ANSI.cyan);
  console.log(`${banner}  ·  log=${HARMONY_LOG}`);
  console.log(`${paint("Following from", ANSI.dim)} ${FOLLOW_FROM_END ? "end (use --all to replay)" : "beginning"}`);

  const health = await probeProxy();
  if (health) {
    const profs = health.profiles?.names?.join(", ") || "(none)";
    console.log(`${paint("proxy", ANSI.dim)}  upstream=${health.upstream}  profiles=${profs}  hooks=${health.hooksModule || "none"}`);
  } else {
    console.log(paint(`(proxy at ${PROXY} unreachable — tailing log only)`, ANSI.dim, ANSI.yellow));
  }
  console.log(paint("─".repeat(80), ANSI.gray));

  setInterval(renderStats, STATS_INTERVAL_MS);

  process.on("SIGINT", () => {
    console.log("\n" + paint("bye.", ANSI.dim));
    process.exit(0);
  });

  await tailLoop();
}

main();
