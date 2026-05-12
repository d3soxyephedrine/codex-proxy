import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8091;
const PROXY_ORIGIN = process.env.CODEX_PEEK_PROXY_ORIGIN || "http://127.0.0.1:3462";
const RAW_EVENT_LOG_PATH = process.env.CODEX_PROXY_RAW_EVENT_LOG_FILE || "/tmp/codex-proxy-events.ndjson";
const API_JSON_LOG_PATH = process.env.CODEX_PROXY_API_JSON_LOG_FILE || "/tmp/codex-proxy-api-json.ndjson";
const CODEX_HOME = process.env.CODEX_HOME || `${process.env.HOME || ""}/.codex`;

interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function text(value: JsonValue, status = 200, contentType = "text/plain; charset=utf-8"): Response {
  return new Response(typeof value === "string" ? value : JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": contentType },
  });
}

function json(value: JsonValue, status = 200): Response {
  return text(value, status, "application/json; charset=utf-8");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
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
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function run(command: string[], timeoutMs = 4000): Promise<CommandResult> {
  const proc = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill("SIGTERM"), timeoutMs);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return {
      ok: code === 0,
      code,
      stdout,
      stderr,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url: string): Promise<JsonValue> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("json")) {
    return await response.json();
  }

  return {
    status: response.status,
    body: await response.text(),
  };
}

function htmlPage(): Response {
  return text(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex Peek</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #10100e;
      --panel: #1b1a17;
      --panel2: #24221e;
      --ink: #f1eadb;
      --muted: #b6aa94;
      --edge: #3a352b;
      --accent: #e4b363;
      --good: #90c695;
      --bad: #e07a5f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: radial-gradient(circle at top left, #2a2319, var(--bg) 38rem);
      color: var(--ink);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--edge);
      background: rgba(16, 16, 14, 0.82);
      position: sticky;
      top: 0;
      backdrop-filter: blur(10px);
      z-index: 1;
    }
    h1 { margin: 0; font-size: 1rem; letter-spacing: 0.08em; text-transform: uppercase; }
    button, select, input {
      background: var(--panel2);
      border: 1px solid var(--edge);
      color: var(--ink);
      border-radius: 8px;
      padding: 0.42rem 0.58rem;
      font: inherit;
    }
    button { cursor: pointer; }
    main {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 1rem;
      padding: 1rem;
    }
    section {
      border: 1px solid var(--edge);
      background: color-mix(in srgb, var(--panel) 92%, transparent);
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.26);
    }
    section.wide { grid-column: 1 / -1; }
    h2 {
      margin: 0;
      padding: 0.75rem 0.9rem;
      font-size: 0.82rem;
      color: var(--accent);
      border-bottom: 1px solid var(--edge);
      background: rgba(255, 255, 255, 0.03);
      text-transform: uppercase;
      letter-spacing: 0.07em;
    }
    pre {
      margin: 0;
      min-height: 8rem;
      max-height: 32rem;
      overflow: auto;
      padding: 0.9rem;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .controls { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
    .ok { color: var(--good); }
    .bad { color: var(--bad); }
    @media (max-width: 900px) {
      main { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Codex Peek</h1>
    <div class="controls">
      <label>tmux <select id="tmuxSession"></select></label>
      <label>request <input id="requestId" placeholder="optional requestId" size="24" /></label>
      <button id="refresh">refresh</button>
      <label><input id="auto" type="checkbox" checked /> auto</label>
      <span id="status"></span>
    </div>
  </header>
  <main>
    <section><h2>proxy</h2><pre id="proxy"></pre></section>
    <section><h2>process tree</h2><pre id="processes"></pre></section>
    <section><h2>ports</h2><pre id="ports"></pre></section>
    <section><h2>tmux sessions</h2><pre id="sessions"></pre></section>
    <section class="wide"><h2>tmux pane</h2><pre id="pane"></pre></section>
    <section class="wide"><h2>native probe</h2><pre id="native"></pre></section>
    <section class="wide"><h2>persistence map</h2><pre id="persistence"></pre></section>
    <section class="wide"><h2>wire timeline</h2><pre id="wire"></pre></section>
    <section class="wide"><h2>channel graph</h2><pre id="graph"></pre></section>
    <section class="wide"><h2>reasoning state chain</h2><pre id="state"></pre></section>
    <section class="wide"><h2>transcript summary</h2><pre id="transcript"></pre></section>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    let timer = null;

    async function get(path) {
      const res = await fetch(path);
      if (!res.ok) throw new Error(path + " -> " + res.status);
      const type = res.headers.get("content-type") || "";
      return type.includes("json") ? await res.json() : await res.text();
    }

    function print(id, value) {
      $(id).textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    }

    async function refreshSessions() {
      const sessions = await get("/api/tmux/sessions");
      print("sessions", sessions);
      const select = $("tmuxSession");
      const current = select.value;
      select.innerHTML = "";
      for (const session of sessions.sessions || []) {
        const opt = document.createElement("option");
        opt.value = session.name;
        opt.textContent = session.name;
        select.appendChild(opt);
      }
      if (current) select.value = current;
    }

    async function refresh() {
      $("status").textContent = "loading";
      $("status").className = "";
      try {
        await refreshSessions();
        const session = $("tmuxSession").value || "codex-proxy";
        const requestId = $("requestId").value.trim();
        const transcriptPath = requestId
          ? "/api/proxy/transcript?limit=1000&requestId=" + encodeURIComponent(requestId)
          : "/api/proxy/transcript?limit=1000";
        const wirePath = requestId
          ? "/api/wire/timeline?limit=30000&requestId=" + encodeURIComponent(requestId)
          : "/api/wire/timeline?limit=30000";
        const [proxy, processes, ports, pane, transcript, wire, nativeProbe, persistence] = await Promise.all([
          get("/api/proxy/health"),
          get("/api/codex/processes"),
          get("/api/ports"),
          get("/api/tmux/capture?session=" + encodeURIComponent(session) + "&lines=120"),
          get(transcriptPath),
          get(wirePath),
          get("/api/native/probe?limit=30000"),
          get("/api/persistence/map"),
        ]);
        const [graph, state] = await Promise.all([
          get("/api/channel/graph?limit=30000"),
          get("/api/state/chain?limit=30000"),
        ]);
        print("proxy", proxy);
        print("processes", processes);
        print("ports", ports);
        print("pane", pane);
        print("native", nativeProbe);
        print("persistence", persistence);
        print("wire", wire);
        print("graph", graph);
        print("state", state);
        print("transcript", transcript);
        $("status").textContent = "ok " + new Date().toLocaleTimeString();
        $("status").className = "ok";
      } catch (err) {
        $("status").textContent = String(err);
        $("status").className = "bad";
      }
    }

    $("refresh").addEventListener("click", refresh);
    $("auto").addEventListener("change", () => {
      if (timer) clearInterval(timer);
      timer = $("auto").checked ? setInterval(refresh, 2500) : null;
    });
    timer = setInterval(refresh, 2500);
    refresh();
  </script>
</body>
</html>`, 200, "text/html; charset=utf-8");
}

async function tmuxSessions(): Promise<Response> {
  const result = await run(["tmux", "list-sessions", "-F", "#{session_name}\t#{session_windows}\t#{session_created_string}"]);
  const sessions = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, windows, created] = line.split("\t");
      return { name, windows: Number(windows), created };
    });

  return json({ ok: result.ok, stderr: result.stderr, sessions });
}

async function tmuxCapture(url: URL): Promise<Response> {
  const session = url.searchParams.get("session") || "codex-proxy";
  const lines = Math.min(Number.parseInt(url.searchParams.get("lines") || "120", 10) || 120, 2000);
  const sessionsResult = await run(["tmux", "list-sessions", "-F", "#{session_name}"]);
  const sessions = new Set(sessionsResult.stdout.trim().split("\n").filter(Boolean));

  if (!sessions.has(session)) {
    return json({ ok: false, error: `unknown tmux session: ${session}`, sessions: [...sessions] }, 404);
  }

  const result = await run(["tmux", "capture-pane", "-pt", session, "-S", `-${lines}`]);
  return json({
    ok: result.ok,
    session,
    lines,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

async function codexProcesses(): Promise<Response> {
  const result = await run([
    "zsh",
    "-lc",
    "ps -axo pid,ppid,pgid,etime,stat,command | egrep 'PID|Codex.app|codex app-server|node_repl|bun run bin/proxy|tmux' | grep -v egrep",
  ]);
  return text(result.stdout || result.stderr, result.ok ? 200 : 500);
}

async function ports(): Promise<Response> {
  const result = await run([
    "zsh",
    "-lc",
    "lsof -nP -iTCP -sTCP:LISTEN | egrep 'COMMAND|Codex|bun|node|tmux|3462|3463|3464|8091|8080|8888|3000' || true",
  ]);
  return text(result.stdout || result.stderr);
}

function shell(command: string, timeoutMs = 4000): Promise<CommandResult> {
  return run(["zsh", "-lc", command], timeoutMs);
}

function safeHomePath(value: string): string {
  const home = process.env.HOME;
  return home ? value.replaceAll(home, "~") : value;
}

function sanitizeCommand(command: string): string {
  return safeHomePath(command)
    .replace(/--pseudonymization-salt-handle=\S+/g, "--pseudonymization-salt-handle=<redacted>")
    .replace(/--field-trial-handle=\S+/g, "--field-trial-handle=<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
    .replace(/(token|secret|key|password)=\S+/gi, "$1=<redacted>");
}

function parsePs(output: string): Record<string, any>[] {
  return output
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) return null;
      const command = parts.slice(5).join(" ");
      return {
        pid: Number(parts[0]),
        ppid: Number(parts[1]),
        pgid: Number(parts[2]),
        elapsed: parts[3],
        stat: parts[4],
        role: processRole(command),
        command: sanitizeCommand(command),
      };
    })
    .filter(Boolean);
}

function processRole(command: string): string {
  if (command.includes("codex app-server")) return "codex app-server";
  if (command.includes("Codex Helper") && command.includes("NetworkService")) return "Codex network service";
  if (command.includes("Codex Helper")) return "Codex helper/renderer";
  if (command.includes("/Contents/MacOS/Codex")) return "Codex Electron main";
  if (command.includes("/Resources/node_repl")) return "node_repl tool worker";
  if (command.includes("bun run bin/proxy.ts")) return "codex-proxy";
  if (command.includes("bun run bin/peek.ts")) return "codex-peek";
  if (command.includes("tmux new-session")) return "tmux supervisor";
  if (command.includes("Sparkle") || command.includes("Updater.app")) return "Codex updater";
  return "other";
}

function pidList(rows: Record<string, any>[], role: string): number[] {
  return rows
    .filter((row) => row.role === role && Number.isFinite(row.pid))
    .map((row) => row.pid);
}

function groupedEnvKeys(): Record<string, string[]> {
  const groups: Record<string, string[]> = {
    codex: [],
    openai: [],
    proxy: [],
    runtime: [],
    network: [],
    crypto_like: [],
  };

  for (const key of Object.keys(process.env).sort()) {
    const upper = key.toUpperCase();
    if (upper.includes("CODEX")) groups.codex.push(key);
    if (upper.includes("OPENAI") || upper.startsWith("OAI_")) groups.openai.push(key);
    if (upper.includes("PROXY")) groups.proxy.push(key);
    if (["PATH", "SHELL", "USER", "HOME", "PWD", "TMPDIR"].includes(upper)) groups.runtime.push(key);
    if (upper.includes("HOST") || upper.includes("PORT") || upper.includes("SOCK")) groups.network.push(key);
    if (/(KEY|SECRET|TOKEN|AUTH|CERT|CRYPT|SIGN|HMAC)/.test(upper)) groups.crypto_like.push(key);
  }

  return Object.fromEntries(Object.entries(groups).filter(([, keys]) => keys.length > 0));
}

function fileMeta(path: string): Record<string, any> {
  try {
    const st = statSync(path);
    return {
      path: safeHomePath(path),
      exists: true,
      kind: st.isDirectory() ? "directory" : "file",
      bytes: st.size,
      mtime: st.mtime.toISOString(),
      mode: `0${(st.mode & 0o777).toString(8)}`,
    };
  } catch (error) {
    return {
      path: safeHomePath(path),
      exists: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function codexConfigSummary(): Record<string, any> {
  const path = `${CODEX_HOME}/config.toml`;
  if (!existsSync(path)) {
    return { path: safeHomePath(path), exists: false };
  }

  const content = readFileSync(path, "utf8");
  const summary: Record<string, any> = {
    path: safeHomePath(path),
    exists: true,
    bytes: content.length,
    model: null,
    openaiBaseUrl: null,
    proxyMentions: [],
  };

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    const modelMatch = line.match(/^model\s*=\s*"([^"]+)"/);
    const baseMatch = line.match(/^openai_base_url\s*=\s*"([^"]+)"/);
    if (modelMatch) summary.model = modelMatch[1];
    if (baseMatch) summary.openaiBaseUrl = baseMatch[1];
    if (/proxy|base_url|model/i.test(line)) {
      summary.proxyMentions.push(line.replace(/(token|secret|key|password)\s*=\s*"[^"]*"/gi, '$1 = "<redacted>"'));
    }
  }

  return summary;
}

function codexFileSummary(): Record<string, any> {
  const paths = [
    CODEX_HOME,
    `${CODEX_HOME}/config.toml`,
    `${CODEX_HOME}/auth.json`,
    `${CODEX_HOME}/logs_2.sqlite`,
    `${CODEX_HOME}/state_5.sqlite`,
    `${CODEX_HOME}/session_index.jsonl`,
    `${CODEX_HOME}/models_cache.json`,
  ];

  const topLevel = existsSync(CODEX_HOME)
    ? readdirSync(CODEX_HOME).sort().map((name) => {
      const path = `${CODEX_HOME}/${name}`;
      try {
        const st = statSync(path);
        return {
          name,
          kind: st.isDirectory() ? "directory" : "file",
          bytes: st.size,
          mtime: st.mtime.toISOString(),
        };
      } catch {
        return { name, kind: "unknown" };
      }
    })
    : [];

  return {
    files: paths.map(fileMeta),
    topLevel,
    config: codexConfigSummary(),
    note: "Metadata only. auth.json and database contents are not read here.",
  };
}

function proxyLogSummary(limit: number): Record<string, any> {
  const events = readNdjsonTail(RAW_EVENT_LOG_PATH, limit);
  const api = readNdjsonTail(API_JSON_LOG_PATH, limit);
  const eventTypes: Record<string, number> = {};
  const eventLayers: Record<string, number> = {};
  const phases: Record<string, number> = {};
  const paths: Record<string, number> = {};
  const models: Record<string, number> = {};
  let encryptedProduced = 0;
  let encryptedReplayed = 0;

  for (const entry of events) {
    const type = String(entry.type || entry.event?.type || "unknown");
    increment(eventTypes, type);
    increment(eventLayers, wireLayerForEvent(type, entry.event || {}));
    const model = entry.event?.response?.model || entry.model;
    if (typeof model === "string" && model !== "-") increment(models, model);
    if (entry.event?.item?.type === "reasoning" && typeof entry.event.item.encrypted_content === "string") {
      encryptedProduced += 1;
    }
  }

  for (const entry of api) {
    increment(phases, String(entry.phase || "unknown"));
    if (typeof entry.path === "string") increment(paths, entry.path);
    const input = Array.isArray(entry.body?.input) ? entry.body.input : [];
    encryptedReplayed += input.filter((item: Record<string, any>) => (
      item?.type === "reasoning" && typeof item.encrypted_content === "string"
    )).length;
  }

  return {
    logs: {
      rawEventLog: RAW_EVENT_LOG_PATH,
      apiJsonLog: API_JSON_LOG_PATH,
      limit,
      eventsRead: events.length,
      apiRecordsRead: api.length,
    },
    models,
    phases,
    paths,
    eventLayers,
    topEventTypes: Object.entries(eventTypes)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25),
    encryptedReasoning: {
      producedItems: encryptedProduced,
      replayedInputItems: encryptedReplayed,
    },
  };
}

function parseLsofPids(output: string): number[] {
  const pids = new Set<number>();
  for (const line of output.trim().split("\n").slice(1)) {
    const pid = Number(line.trim().split(/\s+/)[1]);
    if (Number.isFinite(pid)) pids.add(pid);
  }
  return [...pids];
}

async function nativeProbe(url: URL): Promise<Response> {
  const limit = Math.min(Number.parseInt(url.searchParams.get("limit") || "30000", 10) || 30000, 100_000);
  const [system, psResult, listeners, tcp, tmux, proxyListener, peekListener] = await Promise.all([
    shell("sw_vers 2>/dev/null; uname -a", 3000),
    shell("ps -axo pid,ppid,pgid,etime,stat,command | egrep 'PID|Codex.app|/Codex |codex app-server|node_repl|bun run bin/proxy|bun run bin/peek|tmux|Sparkle|Updater' | grep -v egrep", 4000),
    shell("lsof -nP -iTCP -sTCP:LISTEN | egrep 'COMMAND|Codex|bun|node|tmux|3456|3457|3458|3462|3463|3464|8091|8080|8888|3000' || true", 4000),
    shell("lsof -nP -iTCP | egrep 'COMMAND|127.0.0.1:3462|127.0.0.1:8091|104\\.18\\.|172\\.64\\.|codex|Codex|bun' || true", 4000),
    shell("tmux list-sessions -F '#{session_name}\t#{session_windows}\t#{session_created_string}' 2>/dev/null || true", 3000),
    shell("lsof -nP -iTCP:3462 -sTCP:LISTEN 2>/dev/null || true", 3000),
    shell("lsof -nP -iTCP:8091 -sTCP:LISTEN 2>/dev/null || true", 3000),
  ]);

  const processes = parsePs(psResult.stdout);
  const mainPids = pidList(processes, "Codex Electron main");
  const appServerPids = pidList(processes, "codex app-server");
  const proxyPids = parseLsofPids(proxyListener.stdout);
  const peekPids = parseLsofPids(peekListener.stdout);
  const nodeReplPids = pidList(processes, "node_repl tool worker");
  const lsofTargets = [...new Set([...mainPids, ...appServerPids, ...proxyPids, ...peekPids, ...nodeReplPids])];
  const targetCsv = lsofTargets.join(",");

  const [unix, openFiles, sessions] = await Promise.all([
    targetCsv
      ? shell(`lsof -nP -p ${targetCsv} -U 2>/dev/null | egrep 'COMMAND|codex-ipc|codex-browser-use|node_repl|->|\\.sock' || true`, 4000)
      : Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" }),
    appServerPids.length > 0
      ? shell(`lsof -nP -p ${appServerPids.join(",")} 2>/dev/null | egrep 'COMMAND|\\.codex|sessions|sqlite|jsonl' || true`, 4000)
      : Promise.resolve({ ok: true, code: 0, stdout: "", stderr: "" }),
    shell(`find "${CODEX_HOME}/sessions" -type f -name 'rollout-*.jsonl' -print 2>/dev/null | tail -n 20`, 4000),
  ]);

  return json({
    run: {
      at: new Date().toISOString(),
      platform: "darwin/codex-desktop",
      codexHome: safeHomePath(CODEX_HOME),
      note: "Read-only native probe. Values likely to contain secrets are reported as keys, hashes, lengths, or metadata only.",
    },
    system: {
      output: system.stdout.trim(),
      errors: system.stderr.trim(),
    },
    processTopology: {
      ids: {
        mainPids,
        appServerPids,
        proxyPids,
        peekPids,
        nodeReplPids,
      },
      processes,
      tmux: tmux.stdout.trim(),
    },
    sockets: {
      listeners: listeners.stdout.trim(),
      tcp: tcp.stdout.trim(),
      unix: unix.stdout.trim(),
      note: "Unix sockets are observed with lsof only; this endpoint does not connect to app/browser sockets.",
    },
    codexFiles: {
      ...codexFileSummary(),
      appServerOpenFiles: openFiles.stdout.trim(),
      recentSessionFiles: sessions.stdout.trim().split("\n").filter(Boolean).map(safeHomePath),
    },
    environment: {
      peekProcessEnvKeys: groupedEnvKeys(),
      note: "Environment values are intentionally omitted.",
    },
    proxyWire: proxyLogSummary(limit),
    jupyterProbeComparison: {
      carriedOver: [
        "process tree",
        "network topology",
        "IPC/socket inventory",
        "API route discovery through proxy logs",
        "reasoning/encryption surface as hashes and counts",
      ],
      intentionallySkipped: [
        "Jupyter kernel object introspection",
        "Linux /proc parsing",
        "raw environment value dumps",
        "secret/key file enumeration",
        "browser-use raw socket connections",
      ],
    },
  });
}

function quoteSqlIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function sqliteJson(dbPath: string, sql: string): Promise<Record<string, any>[]> {
  if (!existsSync(dbPath)) return [];

  const result = await run(["sqlite3", "-json", dbPath, sql], 5000);
  if (!result.ok || result.stdout.trim().length === 0) return [];

  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function sqliteDbSummary(dbPath: string): Promise<Record<string, any>> {
  const tables = await sqliteJson(
    dbPath,
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name",
  );
  const indexes = await sqliteJson(
    dbPath,
    "select name, tbl_name as tableName from sqlite_master where type='index' and name not like 'sqlite_autoindex_%' order by name",
  );

  const tableSummaries = await Promise.all(tables.map(async (row) => {
    const name = String(row.name || "");
    const [countRows, columns] = await Promise.all([
      sqliteJson(dbPath, `select count(*) as rowCount from ${quoteSqlIdent(name)}`),
      sqliteJson(dbPath, `pragma table_info(${quoteSqlIdent(name)})`),
    ]);

    return {
      name,
      rowCount: countRows[0]?.rowCount ?? null,
      columns: columns.map((column) => ({
        name: column.name,
        type: column.type,
        required: column.notnull === 1,
        primaryKeyPosition: column.pk,
        defaultValue: column.dflt_value === null ? null : "<present>",
      })),
    };
  }));

  return {
    ...fileMeta(dbPath),
    tables: tableSummaries,
    indexes,
  };
}

function collectSessionFiles(root: string): string[] {
  const files: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > 8 || !existsSync(dir)) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path, depth + 1);
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        files.push(path);
      }
    }
  }

  walk(root, 0);
  return files;
}

function summarizeJsonlSession(path: string): Record<string, any> {
  const st = statSync(path);
  const counts = {
    recordTypes: {} as Record<string, number>,
    payloadTypes: {} as Record<string, number>,
    responseItemTypes: {} as Record<string, number>,
    eventMsgTypes: {} as Record<string, number>,
    payloadKeySets: {} as Record<string, number>,
    toolNames: {} as Record<string, number>,
  };
  const encryptedReasoning: Record<string, any>[] = [];
  let parsedLines = 0;
  let malformedLines = 0;

  const maxBytes = 20_000_000;
  const textValue = st.size <= maxBytes ? readFileSync(path, "utf8") : "";

  for (const line of textValue.split("\n")) {
    if (line.trim().length === 0) continue;

    try {
      const record = JSON.parse(line);
      parsedLines += 1;
      const type = typeof record.type === "string" ? record.type : "unknown";
      increment(counts.recordTypes, type);

      const payload = record.payload && typeof record.payload === "object" ? record.payload : null;
      if (!payload) continue;

      const payloadKeys = Object.keys(payload).sort().join(",");
      increment(counts.payloadKeySets, payloadKeys || "<empty>");

      if (typeof payload.type === "string") {
        increment(counts.payloadTypes, payload.type);
        if (type === "response_item") increment(counts.responseItemTypes, payload.type);
        if (type === "event_msg") increment(counts.eventMsgTypes, payload.type);
      }

      if (
        (payload.type === "function_call" || payload.type === "custom_tool_call")
        && typeof payload.name === "string"
      ) {
        increment(counts.toolNames, payload.name);
      }

      if (payload.type === "reasoning" && typeof payload.encrypted_content === "string") {
        encryptedReasoning.push({
          hash: digest(payload.encrypted_content),
          length: payload.encrypted_content.length,
          summaryLength: Array.isArray(payload.summary) ? JSON.stringify(payload.summary).length : 0,
        });
      }
    } catch {
      malformedLines += 1;
    }
  }

  return {
    path: safeHomePath(path),
    bytes: st.size,
    mtime: st.mtime.toISOString(),
    parsedLines,
    malformedLines,
    skippedBecauseLarge: st.size > maxBytes,
    counts,
    encryptedReasoning: {
      count: encryptedReasoning.length,
      tail: encryptedReasoning.slice(-12),
    },
  };
}

async function persistenceMap(): Promise<Response> {
  const sessionRoot = `${CODEX_HOME}/sessions`;
  const sessionFiles = collectSessionFiles(sessionRoot)
    .map((path) => ({ path, stat: statSync(path) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const [stateDb, logsDb] = await Promise.all([
    sqliteDbSummary(`${CODEX_HOME}/state_5.sqlite`),
    sqliteDbSummary(`${CODEX_HOME}/logs_2.sqlite`),
  ]);

  return json({
    run: {
      at: new Date().toISOString(),
      codexHome: safeHomePath(CODEX_HOME),
      note: "Read-only persistence map. SQLite output is schema/counts only; JSONL output is type/key/hash metadata only.",
    },
    sqlite: {
      state: stateDb,
      logs: logsDb,
    },
    jsonl: {
      sessionRoot: safeHomePath(sessionRoot),
      rolloutFileCount: sessionFiles.length,
      recentFiles: sessionFiles.slice(0, 10).map(({ path, stat }) => ({
        path: safeHomePath(path),
        bytes: stat.size,
        mtime: stat.mtime.toISOString(),
      })),
      recentSummaries: sessionFiles.slice(0, 5).map(({ path }) => summarizeJsonlSession(path)),
      sessionIndex: fileMeta(`${CODEX_HOME}/session_index.jsonl`),
    },
  });
}

async function proxy(path: string, search: string): Promise<Response> {
  try {
    return json(await fetchJson(`${PROXY_ORIGIN}${path}${search}`));
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error), proxy: PROXY_ORIGIN }, 502);
  }
}

function stateChain(url: URL): Response {
  const limit = Math.min(Number.parseInt(url.searchParams.get("limit") || "30000", 10) || 30000, 100_000);
  const events = readNdjsonTail(RAW_EVENT_LOG_PATH, limit);
  const api = readNdjsonTail(API_JSON_LOG_PATH, limit);

  const produced = new Map<string, Record<string, any>>();
  const replayed = new Map<string, Record<string, any>[]>();
  const promptCacheKeys = new Map<string, number>();
  const responseIds = new Map<string, number>();
  const models = new Map<string, number>();
  const requestRows: Record<string, any>[] = [];

  for (const entry of events) {
    const event = entry.event as Record<string, any> | undefined;
    const response = event?.response as Record<string, any> | undefined;

    if (response) {
      if (typeof response.model === "string") {
        models.set(response.model, (models.get(response.model) || 0) + 1);
      }
      if (typeof response.id === "string") {
        const hash = digest(response.id);
        responseIds.set(hash, (responseIds.get(hash) || 0) + 1);
      }
      if (typeof response.prompt_cache_key === "string") {
        const hash = digest(response.prompt_cache_key);
        promptCacheKeys.set(hash, (promptCacheKeys.get(hash) || 0) + 1);
      }
    }

    const item = event?.item as Record<string, any> | undefined;
    if (
      event?.type === "response.output_item.done"
      && item?.type === "reasoning"
      && typeof item.encrypted_content === "string"
    ) {
      const hash = digest(item.encrypted_content);
      produced.set(hash, {
        hash,
        at: entry.at ?? null,
        requestId: entry.requestId ?? null,
        itemIdHash: typeof item.id === "string" ? digest(item.id) : null,
        encryptedLength: item.encrypted_content.length,
        summaryLength: Array.isArray(item.summary) ? JSON.stringify(item.summary).length : 0,
      });
    }
  }

  for (const entry of api) {
    if (entry.phase !== "request.forwarded" || entry.path !== "/responses") continue;

    const body = entry.body as Record<string, any> | undefined;
    const input = Array.isArray(body?.input) ? body.input : [];
    const encryptedItems = input
      .map((item: Record<string, any>, index: number) => ({ item, index }))
      .filter(({ item }) => item?.type === "reasoning" && typeof item.encrypted_content === "string");

    requestRows.push({
      at: entry.at ?? null,
      requestId: entry.requestId ?? null,
      model: body?.model ?? null,
      inputCount: input.length,
      include: body?.include ?? null,
      reasoning: body?.reasoning ?? null,
      promptCacheKeyHash: typeof body?.prompt_cache_key === "string" ? digest(body.prompt_cache_key) : null,
      promptCacheKeyLength: typeof body?.prompt_cache_key === "string" ? body.prompt_cache_key.length : 0,
      encryptedReasoningCount: encryptedItems.length,
      lastEncryptedReasoning: encryptedItems.slice(-5).map(({ item, index }) => ({
        index,
        hash: digest(item.encrypted_content),
        length: item.encrypted_content.length,
        summaryLength: Array.isArray(item.summary) ? JSON.stringify(item.summary).length : 0,
      })),
    });

    for (const { item, index } of encryptedItems) {
      const hash = digest(item.encrypted_content);
      const list = replayed.get(hash) || [];
      list.push({
        at: entry.at ?? null,
        requestId: entry.requestId ?? null,
        index,
        length: item.encrypted_content.length,
      });
      replayed.set(hash, list);
    }
  }

  const matches = [...produced.values()]
    .filter((item) => replayed.has(item.hash))
    .map((item) => ({
      ...item,
      firstReplay: replayed.get(item.hash)?.[0] ?? null,
      replayCount: replayed.get(item.hash)?.length ?? 0,
    }));

  return json({
    logs: {
      rawEventLog: RAW_EVENT_LOG_PATH,
      apiJsonLog: API_JSON_LOG_PATH,
      limit,
      eventsRead: events.length,
      apiRecordsRead: api.length,
    },
    responseState: {
      models: [...models.entries()].map(([model, count]) => ({ model, count })),
      responseIds: { unique: responseIds.size },
      promptCacheKeys: [...promptCacheKeys.entries()].map(([hash, count]) => ({ hash, count, length: 36 })),
    },
    reasoningState: {
      producedEncryptedReasoning: produced.size,
      replayedEncryptedReasoning: replayed.size,
      matchedProducedToReplay: matches.length,
      lastMatches: matches.slice(-20),
    },
    requestChain: requestRows.slice(-30),
  });
}

function eventGroup(type: string): string {
  if (type.includes("reasoning")) return "analysis/reasoning";
  if (type.includes("output_text") || type.includes("content_part")) return "commentary/text";
  if (type.includes("function_call") || type.includes("custom_tool")) return "tool calls";
  if (type.includes("output_item")) return "item lifecycle";
  if (type.startsWith("response.")) return "response lifecycle";
  return "other";
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const nextKey = key(value);
    counts[nextKey] = (counts[nextKey] || 0) + 1;
  }
  return counts;
}

function increment(counts: Record<string, number>, key: string, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
}

function inputType(item: Record<string, any>): string {
  if (typeof item?.type === "string") return item.type;
  if (typeof item?.role === "string") return item.role;
  return "unknown";
}

function summarizeRequestBody(body: Record<string, any> | undefined): Record<string, any> {
  const input = Array.isArray(body?.input) ? body.input : [];
  const inputTypes: Record<string, number> = {};
  const functionNames: Record<string, number> = {};
  const encryptedReasoning = [];

  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== "object") continue;
    const type = inputType(item);
    increment(inputTypes, type);

    if (type === "function_call" && typeof item.name === "string") {
      increment(functionNames, item.name);
    }

    if (type === "reasoning" && typeof item.encrypted_content === "string") {
      encryptedReasoning.push({
        index,
        hash: digest(item.encrypted_content),
        length: item.encrypted_content.length,
        summaryLength: Array.isArray(item.summary) ? JSON.stringify(item.summary).length : 0,
      });
    }
  }

  return {
    model: typeof body?.model === "string" ? body.model : null,
    stream: typeof body?.stream === "boolean" ? body.stream : null,
    inputCount: input.length,
    inputTypes,
    functionNames,
    include: Array.isArray(body?.include) ? body.include : null,
    reasoning: body?.reasoning && typeof body.reasoning === "object" ? body.reasoning : null,
    promptCacheKeyHash: typeof body?.prompt_cache_key === "string" ? digest(body.prompt_cache_key) : null,
    promptCacheKeyLength: typeof body?.prompt_cache_key === "string" ? body.prompt_cache_key.length : 0,
    encryptedReasoningReplayCount: encryptedReasoning.length,
    encryptedReasoningReplayTail: encryptedReasoning.slice(-8),
  };
}

function wireLayerForEvent(type: string, event: Record<string, any>): string {
  if (type.includes("reasoning_summary") || type.includes("reasoning_text")) return "analysis.visible";
  if (type.includes("output_text") || type.includes("content_part")) return "commentary.visible";
  if (type.includes("function_call") || type.includes("custom_tool")) return "tool.routing";

  const item = event.item as Record<string, any> | undefined;
  if (item?.type === "reasoning") return typeof item.encrypted_content === "string"
    ? "state.encrypted_reasoning"
    : "analysis.item";
  if (item?.type === "function_call" || item?.type === "custom_tool_call") return "tool.routing";
  if (item?.type === "message") return "commentary.item";
  if (type.startsWith("response.")) return "response.lifecycle";
  return "other";
}

function summarizeSseEvent(entry: Record<string, any>): Record<string, any> {
  const event = entry.event as Record<string, any> | undefined;
  const type = typeof entry.type === "string" ? entry.type : String(event?.type || "unknown");
  const item = event?.item as Record<string, any> | undefined;
  const response = event?.response as Record<string, any> | undefined;
  const details: Record<string, any> = {};

  if (response) {
    details.status = response.status ?? null;
    details.model = response.model ?? null;
    details.usage = response.usage ?? null;
    details.stopReason = response.stop_reason
      || response.incomplete_details?.reason
      || response.error?.code
      || null;
    if (typeof response.prompt_cache_key === "string") {
      details.promptCacheKeyHash = digest(response.prompt_cache_key);
      details.promptCacheKeyLength = response.prompt_cache_key.length;
    }
  }

  if (item) {
    details.itemType = item.type ?? null;
    details.itemName = item.name ?? null;
    details.itemStatus = item.status ?? null;
    details.callIdHash = typeof item.call_id === "string" ? digest(item.call_id) : null;
    if (typeof item.encrypted_content === "string") {
      details.encryptedReasoningHash = digest(item.encrypted_content);
      details.encryptedReasoningLength = item.encrypted_content.length;
      details.summaryLength = Array.isArray(item.summary) ? JSON.stringify(item.summary).length : 0;
    }
  }

  if (typeof event?.arguments === "string") {
    details.argumentsLength = event.arguments.length;
  }
  if (typeof event?.input === "string") {
    details.inputLength = event.input.length;
  }
  if (typeof event?.text === "string") {
    details.textLength = event.text.length;
  }
  if (typeof event?.delta === "string") {
    details.deltaLength = event.delta.length;
  }

  return {
    at: entry.at ?? null,
    requestId: entry.requestId ?? null,
    transport: "backend SSE -> proxy -> app-server",
    layer: wireLayerForEvent(type, event || {}),
    type,
    details,
  };
}

function isTimelineSse(type: string): boolean {
  return !type.endsWith(".delta");
}

function requestRowFor(rows: Map<string, Record<string, any>>, requestId: string): Record<string, any> {
  let row = rows.get(requestId);
  if (!row) {
    row = {
      requestId,
      firstAt: null,
      lastAt: null,
      path: null,
      method: null,
      model: null,
      stream: null,
      status: null,
      transportPhases: {},
      sseTypes: {},
      sseLayers: {},
      channelByteCounts: {
        commentaryVisible: 0,
        analysisVisible: 0,
        toolArguments: 0,
        customToolInput: 0,
      },
      requestBody: null,
      response: null,
      encryptedReasoningProduced: [],
      toolItems: [],
    };
    rows.set(requestId, row);
  }
  return row;
}

function touchRequestRow(row: Record<string, any>, at: unknown) {
  if (typeof at !== "string") return;
  row.firstAt = row.firstAt || at;
  row.lastAt = at;
}

function wireTimeline(url: URL): Response {
  const limit = Math.min(Number.parseInt(url.searchParams.get("limit") || "30000", 10) || 30000, 100_000);
  const requestIdFilter = url.searchParams.get("requestId") || "";
  const api = readNdjsonTail(API_JSON_LOG_PATH, limit)
    .filter((entry) => !requestIdFilter || entry.requestId === requestIdFilter);

  const rows = new Map<string, Record<string, any>>();
  const timeline: Record<string, any>[] = [];
  const phaseCounts: Record<string, number> = {};
  const layerCounts: Record<string, number> = {};

  for (const entry of api) {
    const requestId = typeof entry.requestId === "string" ? entry.requestId : "unknown";
    const row = requestRowFor(rows, requestId);
    touchRequestRow(row, entry.at);

    if (typeof entry.path === "string") row.path = entry.path;
    if (typeof entry.method === "string") row.method = entry.method;
    increment(phaseCounts, String(entry.phase || "unknown"));
    increment(row.transportPhases, String(entry.phase || "unknown"));

    if (entry.phase === "request.received" || entry.phase === "request.forwarded") {
      const bodySummary = summarizeRequestBody(entry.body as Record<string, any> | undefined);
      row.requestBody = bodySummary;
      row.model = bodySummary.model || row.model;
      row.stream = bodySummary.stream ?? row.stream;

      timeline.push({
        at: entry.at ?? null,
        requestId,
        transport: entry.phase === "request.received"
          ? "app-server -> proxy"
          : "proxy -> backend",
        layer: "request.body",
        phase: entry.phase,
        path: entry.path ?? null,
        method: entry.method ?? null,
        body: bodySummary,
      });
      continue;
    }

    if (entry.phase === "response.headers" || entry.phase === "response.body") {
      row.status = entry.status ?? row.status;
      timeline.push({
        at: entry.at ?? null,
        requestId,
        transport: "backend -> proxy -> app-server",
        layer: entry.phase === "response.headers" ? "response.headers" : "response.body",
        phase: entry.phase,
        path: entry.path ?? null,
        status: entry.status ?? null,
        headers: entry.headers ?? null,
        bodyKind: entry.phase === "response.body" && entry.body ? typeof entry.body : null,
      });
      continue;
    }

    if (entry.phase !== "response.sse_event") {
      continue;
    }

    const event = entry.event as Record<string, any> | undefined;
    const type = typeof entry.type === "string" ? entry.type : String(event?.type || "unknown");
    const layer = wireLayerForEvent(type, event || {});
    increment(row.sseTypes, type);
    increment(row.sseLayers, layer);
    increment(layerCounts, layer);

    if (typeof event?.delta === "string") {
      if (type.includes("output_text")) row.channelByteCounts.commentaryVisible += event.delta.length;
      if (type.includes("reasoning")) row.channelByteCounts.analysisVisible += event.delta.length;
      if (type.includes("function_call_arguments")) row.channelByteCounts.toolArguments += event.delta.length;
      if (type.includes("custom_tool_call_input")) row.channelByteCounts.customToolInput += event.delta.length;
    }

    if (event?.item?.type === "reasoning" && typeof event.item.encrypted_content === "string") {
      row.encryptedReasoningProduced.push({
        at: entry.at ?? null,
        hash: digest(event.item.encrypted_content),
        length: event.item.encrypted_content.length,
        summaryLength: Array.isArray(event.item.summary) ? JSON.stringify(event.item.summary).length : 0,
      });
    }

    if (
      (event?.item?.type === "function_call" || event?.item?.type === "custom_tool_call")
      && (type === "response.output_item.added" || type === "response.output_item.done")
    ) {
      row.toolItems.push({
        at: entry.at ?? null,
        event: type,
        itemType: event.item.type,
        name: event.item.name ?? null,
        status: event.item.status ?? null,
        callIdHash: typeof event.item.call_id === "string" ? digest(event.item.call_id) : null,
      });
    }

    if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") {
      const response = event?.response as Record<string, any> | undefined;
      row.response = {
        at: entry.at ?? null,
        type,
        status: response?.status ?? null,
        model: response?.model ?? null,
        usage: response?.usage ?? null,
      };
      row.status = response?.status ?? row.status;
      row.model = response?.model ?? row.model;
    }

    if (isTimelineSse(type)) {
      timeline.push(summarizeSseEvent(entry));
    }
  }

  return json({
    logs: {
      apiJsonLog: API_JSON_LOG_PATH,
      limit,
      recordsRead: api.length,
      requestIdFilter: requestIdFilter || null,
    },
    summary: {
      requests: rows.size,
      phases: Object.entries(phaseCounts).map(([phase, count]) => ({ phase, count })),
      layers: Object.entries(layerCounts).map(([layer, count]) => ({ layer, count })),
      note: "Deltas are counted in request summaries; timeline keeps non-delta events to avoid drowning the UI.",
    },
    requests: [...rows.values()].slice(-20),
    timeline: timeline.slice(-400),
  });
}

async function channelGraph(url: URL): Promise<Response> {
  const limit = Math.min(Number.parseInt(url.searchParams.get("limit") || "30000", 10) || 30000, 100_000);
  const events = readNdjsonTail(RAW_EVENT_LOG_PATH, limit);
  const api = readNdjsonTail(API_JSON_LOG_PATH, limit);

  const processResult = await run([
    "zsh",
    "-lc",
    [
      "ps -axo pid,ppid,pgid,etime,stat,command",
      "| egrep 'PID|Codex.app|codex app-server|node_repl|bun run bin/proxy|bun run bin/peek|tmux new-session'",
      "| grep -v egrep",
    ].join(" "),
  ]);
  const tcpResult = await run([
    "zsh",
    "-lc",
    "lsof -nP -iTCP | egrep 'COMMAND|127.0.0.1:3462|127.0.0.1:8091|104\\.18\\.|172\\.64\\.|codex|Codex|bun' || true",
  ]);
  const unixResult = await run([
    "zsh",
    "-lc",
    "lsof -nP -p 64036,64242,55508,80976 -U 2>/dev/null | egrep 'COMMAND|codex-ipc|codex-browser-use|node_repl|->' || true",
  ]);

  const eventTypes = countBy(events, (entry) => String(entry.type || entry.event?.type || "unknown"));
  const eventGroups = countBy(events, (entry) => eventGroup(String(entry.type || entry.event?.type || "unknown")));
  const apiPhases = countBy(api, (entry) => String(entry.phase || "unknown"));
  const apiPaths = countBy(api.filter((entry) => entry.path), (entry) => String(entry.path));

  const requestIds = new Set<string>();
  const models = new Set<string>();
  let streamedResponses = 0;
  let encryptedReasoningItems = 0;
  let replayedEncryptedReasoningItems = 0;

  for (const entry of events) {
    if (typeof entry.requestId === "string") requestIds.add(entry.requestId);
    if (typeof entry.model === "string" && entry.model !== "-") models.add(entry.model);
    if (typeof entry.event?.response?.model === "string") models.add(entry.event.response.model);
    if (entry.type === "response.created") streamedResponses += 1;
    if (entry.event?.item?.type === "reasoning" && typeof entry.event.item.encrypted_content === "string") {
      encryptedReasoningItems += 1;
    }
  }

  for (const entry of api) {
    const input = Array.isArray(entry.body?.input) ? entry.body.input : [];
    replayedEncryptedReasoningItems += input.filter((item: Record<string, any>) => (
      item?.type === "reasoning" && typeof item.encrypted_content === "string"
    )).length;
  }

  const edges = [
    {
      from: "Codex.app main/Electron",
      to: "codex app-server",
      transport: "child process + local Unix/stdio IPC",
      evidence: "app-server PPID is Codex main; lsof shows paired unix descriptors",
    },
    {
      from: "Codex app-server",
      to: "codex-proxy :3462",
      transport: "localhost TCP",
      evidence: "127.0.0.1:<client> -> 127.0.0.1:3462",
    },
    {
      from: "codex-proxy :3462",
      to: "ChatGPT Codex backend",
      transport: "HTTPS + SSE",
      evidence: "proxy outbound TCP to Cloudflare/chatgpt backend; /responses stream events",
    },
    {
      from: "Codex app-server",
      to: "node_repl workers",
      transport: "pipes + Unix socketpairs",
      evidence: "node_repl children of app-server with stdin/stdout/stderr pipes and unix fd pairs",
    },
    {
      from: "Codex app-server",
      to: "session logs/state DB",
      transport: "local files/sqlite/jsonl",
      evidence: "~/.codex/state_5.sqlite, logs_2.sqlite, sessions/*.jsonl open in app-server",
    },
    {
      from: "Codex.app main",
      to: "browser-use bridge",
      transport: "Unix sockets",
      evidence: "/tmp/codex-browser-use/*.sock and codex-ipc socket owned by Codex main",
    },
    {
      from: "codex-peek :8091",
      to: "codex-proxy :3462",
      transport: "localhost HTTP",
      evidence: "peek server reads proxy debug endpoints and local logs",
    },
  ];

  const ascii = [
    "Codex.app main/Electron",
    "  | local Unix/stdio IPC",
    "  v",
    "codex app-server",
    "  | localhost TCP :3462",
    "  v",
    "codex-proxy",
    "  | HTTPS + SSE /responses",
    "  v",
    "ChatGPT Codex backend",
    "",
    "codex app-server -> node_repl workers     [pipes/socketpairs: tool execution]",
    "codex app-server -> ~/.codex state/logs    [sqlite/jsonl persistence]",
    "Codex.app main   -> browser-use sockets    [browser automation/control]",
    "codex-peek       -> codex-proxy/log files  [read-only observability]",
    "",
    "SSE logical channels over the same /responses stream:",
    "  response.output_text.*              -> commentary/text",
    "  response.reasoning_summary_text.*   -> analysis/reasoning summaries",
    "  response.*function_call*            -> tool-call arguments",
    "  response.output_item.* reasoning    -> encrypted reasoning state",
  ].join("\n");

  return json({
    logs: {
      rawEventLog: RAW_EVENT_LOG_PATH,
      apiJsonLog: API_JSON_LOG_PATH,
      limit,
      eventsRead: events.length,
      apiRecordsRead: api.length,
    },
    graph: {
      ascii,
      edges,
    },
    eventChannels: {
      groups: Object.entries(eventGroups)
        .map(([group, count]) => ({ group, count }))
        .sort((a, b) => b.count - a.count),
      types: Object.entries(eventTypes)
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 80),
      requestIds: requestIds.size,
      models: [...models],
      streamedResponses,
      encryptedReasoningItems,
      replayedEncryptedReasoningItems,
    },
    apiChannels: {
      phases: Object.entries(apiPhases)
        .map(([phase, count]) => ({ phase, count }))
        .sort((a, b) => b.count - a.count),
      paths: Object.entries(apiPaths)
        .map(([path, count]) => ({ path, count }))
        .sort((a, b) => b.count - a.count),
    },
    liveLocalEdges: {
      processes: processResult.stdout.trim(),
      tcp: tcpResult.stdout.trim(),
      unix: unixResult.stdout.trim(),
    },
  });
}

export function startPeekServer(options: { host?: string; port?: number } = {}) {
  const host = options.host || process.env.CODEX_PEEK_HOST || DEFAULT_HOST;
  const parsedPort = options.port ?? Number.parseInt(process.env.CODEX_PEEK_PORT || String(DEFAULT_PORT), 10);
  const port = Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT;

  const server = Bun.serve({
    hostname: host,
    port,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" || url.pathname === "/index.html") return htmlPage();
      if (url.pathname === "/api/tmux/sessions") return tmuxSessions();
      if (url.pathname === "/api/tmux/capture") return tmuxCapture(url);
      if (url.pathname === "/api/codex/processes") return codexProcesses();
      if (url.pathname === "/api/ports") return ports();
      if (url.pathname === "/api/native/probe") return nativeProbe(url);
      if (url.pathname === "/api/persistence/map") return persistenceMap();
      if (url.pathname === "/api/proxy/health") return proxy("/health", "");
      if (url.pathname === "/api/proxy/transcript") return proxy("/debug/transcript", url.search);
      if (url.pathname === "/api/state/chain") return stateChain(url);
      if (url.pathname === "/api/wire/timeline") return wireTimeline(url);
      if (url.pathname === "/api/channel/graph") return channelGraph(url);

      return json({ ok: false, error: "not found" }, 404);
    },
  });

  console.log(`[peek] listening on http://${host}:${server.port}`);
  console.log(`[peek] proxy origin ${PROXY_ORIGIN}`);
  return server;
}
