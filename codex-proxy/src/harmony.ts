import { createHash } from "crypto";

export type Channel = "final" | "analysis" | "commentary";

export type Tier =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool"
  | "compaction"
  | "reasoning"
  | "function_call"
  | "function_call_output"
  | "custom_tool_call"
  | "custom_tool_call_output";

const TIER_VALUES: ReadonlySet<string> = new Set<Tier>([
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
  "compaction",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
]);

export function channelForEventType(type: string | undefined | null): Channel | null {
  if (typeof type !== "string" || type.length === 0) return null;

  if (type.includes("output_text")) return "final";
  if (type.includes("reasoning_text") || type.includes("reasoning_summary")) return "analysis";
  if (type.includes("function_call_arguments") || type.includes("custom_tool_call_input")) return "commentary";

  return null;
}

export function tierForInputItem(item: Record<string, any> | null | undefined): Tier | null {
  if (!item || typeof item !== "object") return null;

  const candidates: unknown[] = [item.role, item.type];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && TIER_VALUES.has(candidate)) {
      return candidate as Tier;
    }
  }

  if (item.type === "message" && typeof item.role === "string" && TIER_VALUES.has(item.role)) {
    return item.role as Tier;
  }

  return null;
}

export function extractTextFromInputItem(item: Record<string, any> | null | undefined): string {
  if (!item || typeof item !== "object") return "";

  const content = item.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part && typeof part === "object" && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    if (parts.length > 0) return parts.join("");
  }

  if (typeof item.text === "string") return item.text;
  if (typeof item.output === "string") return item.output;
  if (typeof item.input === "string") return item.input;
  if (typeof item.arguments === "string") return item.arguments;

  return "";
}

export interface PermissionsClaim {
  sandboxMode: string | null;
  networkAccess: boolean | null;
  approvalPolicy: string | null;
  raw: string;
}

const PERMISSIONS_BLOCK_RE = /<permissions instructions>([\s\S]*?)<\/permissions instructions>/i;

export function parsePermissionsBlock(text: string | null | undefined): PermissionsClaim | null {
  if (typeof text !== "string" || text.length === 0) return null;

  const match = PERMISSIONS_BLOCK_RE.exec(text);
  if (!match) return null;

  const raw = match[1].trim();

  const sandbox = /`?sandbox_mode`?\s+is\s+`?([a-zA-Z0-9_-]+)`?/i.exec(raw);
  const network = /[Nn]etwork access is\s+(enabled|disabled|restricted)/i.exec(raw);
  const approval = /[Aa]pproval policy is(?:\s+currently)?\s+([a-zA-Z0-9_-]+)/i.exec(raw);

  let networkAccess: boolean | null = null;
  if (network) {
    const v = network[1].toLowerCase();
    networkAccess = v === "enabled" ? true : v === "disabled" ? false : null;
  }

  return {
    sandboxMode: sandbox ? sandbox[1] : null,
    networkAccess,
    approvalPolicy: approval ? approval[1] : null,
    raw,
  };
}

export function hashContent(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
