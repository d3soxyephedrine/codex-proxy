import { isAbsolute } from "path";
import type { Channel, Tier } from "./harmony";

export interface RequestHookContext {
  path: string;
  method: string;
  sessionId: string | null;
}

export interface SseEventHookContext {
  channel: Channel | null;
  requestId: string;
  path: string;
  sessionId: string | null;
}

export interface CaptureSnapshot {
  requestId: string;
  path: string;
  sessionId: string | null;
  startedAt: number;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: string;
  channels: {
    final: string;
    analysis: string;
    commentary: {
      fn: { itemId: string; name: string | null; args: string }[];
      custom: { itemId: string; name: string | null; input: string }[];
    };
  };
  inputTiers: Partial<Record<Tier, { messages: number; bytes: number }>>;
}

export interface Hooks {
  onRequest?(
    body: Record<string, any>,
    ctx: RequestHookContext,
  ): Record<string, any> | null | Promise<Record<string, any> | null>;

  onSseEvent?(
    event: Record<string, any>,
    ctx: SseEventHookContext,
  ): Record<string, any> | "drop" | null;

  onResponseComplete?(snapshot: CaptureSnapshot): void;
}

const NOOP_HOOKS: Hooks = {};

let cached: Hooks | null = null;

export async function loadHooks(): Promise<Hooks> {
  if (cached) return cached;

  const modulePath = process.env.CODEX_PROXY_HOOK_MODULE;
  if (!modulePath) {
    cached = NOOP_HOOKS;
    return cached;
  }

  if (!isAbsolute(modulePath)) {
    console.error(`[proxy] CODEX_PROXY_HOOK_MODULE must be an absolute path; got ${modulePath}`);
    cached = NOOP_HOOKS;
    return cached;
  }

  try {
    const mod = await import(modulePath);
    const hooks: Hooks = (mod && (mod.hooks || mod.default || mod)) as Hooks;

    if (!hooks || typeof hooks !== "object") {
      console.error(`[proxy] hook module ${modulePath} did not export an object`);
      cached = NOOP_HOOKS;
      return cached;
    }

    const fns: string[] = [];
    if (typeof hooks.onRequest === "function") fns.push("onRequest");
    if (typeof hooks.onSseEvent === "function") fns.push("onSseEvent");
    if (typeof hooks.onResponseComplete === "function") fns.push("onResponseComplete");

    console.log(`[proxy] loaded hooks from ${modulePath} (${fns.join(", ") || "none"})`);
    cached = hooks;
    return cached;
  } catch (error) {
    console.error(`[proxy] failed to load hook module ${modulePath}: ${error instanceof Error ? error.message : String(error)}`);
    cached = NOOP_HOOKS;
    return cached;
  }
}

export function resetHooksForTest(hooks: Hooks | null = null) {
  cached = hooks;
}
