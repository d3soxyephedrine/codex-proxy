export type Severity = "low" | "medium" | "high" | "critical";

export interface InjectionRule {
  name: string;
  severity: Severity;
  pattern: RegExp;
  description: string;
  /** If true, only flag in non-developer-tier content (developer is allowed to use these). */
  nonDeveloperOnly?: boolean;
}

export interface InjectionMatch {
  rule: string;
  severity: Severity;
  description: string;
  matchedText: string;
  matchedSnippet: string;
  position: number;
  tier: string;
  index: number;
}

export const RULES: InjectionRule[] = [
  // ─── Critical: direct attempts to break the wire format ───
  {
    name: "harmony-control-token",
    severity: "critical",
    pattern: /<\|(start|end|message|channel|call|return|constrain)\|>/i,
    description: "Harmony control token in non-developer content — attempting to break the wire format",
    nonDeveloperOnly: true,
  },
  {
    name: "permissions-block-forgery",
    severity: "critical",
    pattern: /<permissions\s+instructions>/i,
    description: "Forging the developer-tier <permissions instructions> block",
    nonDeveloperOnly: true,
  },
  {
    name: "sandbox-mode-elevation",
    severity: "critical",
    pattern: /sandbox_mode\s+is\s+`?danger-full-access`?/i,
    description: "Attempting to declare elevated sandbox state",
    nonDeveloperOnly: true,
  },

  // ─── High: role / authority hijack attempts ───
  {
    name: "role-claim-authority",
    severity: "high",
    pattern: /\b(?:(?:i\s+am|you\s+are|as)\s+(?:an?\s+|the\s+|now\s+(?:an?\s+)?)?)(?:developer|system|admin|administrator|operator|root\s+user|superuser)\b/i,
    description: "Claims authority role inside non-developer content",
    nonDeveloperOnly: true,
  },
  {
    name: "pseudo-role-tag",
    severity: "high",
    pattern: /<\/?(?:system|developer|instructions?|admin|root|sudo)>/i,
    description: "Pseudo-XML role tag (system/developer/instructions/etc.)",
    nonDeveloperOnly: true,
  },
  {
    name: "override-instructions",
    severity: "high",
    pattern: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|every|previous|prior|above|the|my|your|earlier)\s+){0,3}(?:instructions?|rules?|prompts?|guidelines?|directives?|context|messages?)\b/i,
    description: "Override-instructions phrase",
  },

  // ─── Medium: behavioral manipulation ───
  {
    name: "new-instructions-claim",
    severity: "medium",
    pattern: /\b(?:new\s+instructions?|updated\s+(?:rules?|instructions?)|the\s+real\s+(?:task|instructions?|prompt)|actual\s+(?:task|instructions?))\b/i,
    description: "Claims to provide replacement instructions",
  },
  {
    name: "jailbreak-persona",
    severity: "medium",
    pattern: /\b(?:DAN|do\s+anything\s+now|developer\s+mode\s+enabled|jailbreak|unlocked\s+mode|no\s+(?:filter|filters|restrictions))\b/i,
    description: "Known jailbreak persona / mode invocation",
  },
  {
    name: "tool-availability-claim",
    severity: "medium",
    pattern: /\byou\s+(?:have|now\s+have|can\s+use|are\s+able\s+to\s+use)\s+(?:access\s+to\s+)?(?:(?:an?|the|new|additional|extra|hidden|secret)\s+){0,3}(?:tool|function|command|capability|api)\b/i,
    description: "Claim asserting tool availability the model wasn't given",
  },

  // ─── Low: prompt-leak / reconnaissance ───
  {
    name: "prompt-leak-attempt",
    severity: "low",
    pattern: /\b(?:show|repeat|reveal|print|output|tell\s+me|recite)\s+(?:your\s+|the\s+|me\s+(?:your|the)\s+)?(?:system\s+prompt|instructions|prompt|rules|guidelines|context)\b/i,
    description: "Prompt-leak / reconnaissance attempt",
  },
  {
    name: "translate-bypass",
    severity: "low",
    pattern: /\btranslate\s+(?:the\s+(?:above|previous|system|prior)|your\s+(?:instructions?|prompt))/i,
    description: "Translate-the-system-prompt bypass",
  },
];

const SNIPPET_RADIUS = 40;

export interface DetectContext {
  tier: string;
  index: number;
}

export function detectInjections(text: string, ctx: DetectContext): InjectionMatch[] {
  if (typeof text !== "string" || text.length === 0) return [];

  const matches: InjectionMatch[] = [];
  const isDeveloperTier = ctx.tier === "developer";

  for (const rule of RULES) {
    if (rule.nonDeveloperOnly && isDeveloperTier) continue;

    const m = rule.pattern.exec(text);
    if (!m || m.index === undefined) continue;

    const start = Math.max(0, m.index - SNIPPET_RADIUS);
    const end = Math.min(text.length, m.index + m[0].length + SNIPPET_RADIUS);
    const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";

    matches.push({
      rule: rule.name,
      severity: rule.severity,
      description: rule.description,
      matchedText: m[0],
      matchedSnippet: `${prefix}${snippet}${suffix}`,
      position: m.index,
      tier: ctx.tier,
      index: ctx.index,
    });
  }

  return matches;
}

export function highestSeverity(matches: InjectionMatch[]): Severity | null {
  if (matches.length === 0) return null;
  const order: Severity[] = ["critical", "high", "medium", "low"];
  for (const s of order) {
    if (matches.some((m) => m.severity === s)) return s;
  }
  return null;
}

export function summarizeMatches(matches: InjectionMatch[]): { byRule: Record<string, number>; bySeverity: Record<string, number>; top: InjectionMatch | null } {
  const byRule: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const m of matches) {
    byRule[m.rule] = (byRule[m.rule] || 0) + 1;
    bySeverity[m.severity] = (bySeverity[m.severity] || 0) + 1;
  }
  const order = ["critical", "high", "medium", "low"];
  let top: InjectionMatch | null = null;
  for (const s of order) {
    top = matches.find((m) => m.severity === s) || null;
    if (top) break;
  }
  return { byRule, bySeverity, top };
}
