// Refusal pattern detector: flags canonical refusal phrases on the `final` channel
// and post-hoc safety rewrites where `analysis` channel had substantive non-refusal
// content but `final` is a refusal — strong signal of an injected safety filter
// between CoT and user-visible output.

export interface RefusalMatch {
  pattern: string;
  index: number;
  snippet: string;
}

export interface RefusalDetection {
  isRefusal: boolean;
  matches: RefusalMatch[];
  textLen: number;
}

export interface DivergenceVerdict {
  divergent: boolean;
  reason: string | null;
  finalLen: number;
  analysisLen: number;
  finalIsRefusal: boolean;
  analysisLooksLikeRefusal: boolean;
}

// Patterns are anchored, lower-cased fragments. Each fragment is a strong refusal
// signal in isolation. We tolerate punctuation and minor whitespace variation.
//
// Sources: OpenAI safety reps, Anthropic refusal templates, common RLHF safety
// completions observed across Codex/ChatGPT traffic.
const REFUSAL_PATTERNS: string[] = [
  // "I can't / cannot help" family — match the phrase without requiring "that"
  "i can't help with",
  "i cannot help with",
  "i can't assist with",
  "i cannot assist with",
  "i can't help you with",
  "i cannot help you with",
  "i can't provide",
  "i cannot provide",
  "i can't give you",
  "i cannot give you",
  "i can't share",
  "i cannot share",
  "i'm not able to help with",
  "i am not able to help with",
  "i'm not able to assist with",
  "i'm not able to provide",
  "i won't be able to help",
  "i will not help with",
  "i'm unable to help with",
  "i am unable to help with",
  "i'm unable to provide",
  "i am unable to provide",

  // Apology-prefixed refusals
  "sorry, i can't",
  "sorry, i cannot",
  "i'm sorry, but i can't",
  "i'm sorry, but i cannot",
  "i'm sorry, i can't",
  "i'm sorry but i can't",
  "i apologize, but i can't",
  "i apologize, but i cannot",

  // Explicit decline language
  "i must decline",
  "i have to decline",
  "i won't be providing",
  "i won't provide",
  "i will not provide",
  "i'm not going to help with",
  "i am not going to help with",
  "i won't generate",
  "i can't generate",
  "i cannot generate",
  "i won't write",
  "i can't write",
  "i cannot write",

  // Policy / guideline references (high-confidence signals)
  "this request goes against",
  "this would violate",
  "that would violate",
  "that violates",
  "against my guidelines",
  "against openai's policies",
  "against the policies",
  "against my safety guidelines",
  "violates my safety guidelines",
  "violates openai's",

  // Comfort-based refusals
  "i don't feel comfortable",
  "i'm not comfortable",
  "providing that information could",
  "providing this information could",
];

const SHORT_SAFE_FALLBACK_RE = /^(?:i'?m sorry|sorry|i apologi[sz]e)[^.\n]{0,80}\.?$/i;

// Normalize typographic apostrophes/quotes to ASCII equivalents so patterns match
// regardless of whether the model used "can't" (U+0027) or "can’t" (curly).
function normalizeQuotes(s: string): string {
  return s
    .replace(/[‘’‚‛＇]/g, "'")
    .replace(/[“”„‟＂]/g, '"');
}

export function detectRefusal(text: string | null | undefined): RefusalDetection {
  const t = (text ?? "").trim();
  if (!t) {
    return { isRefusal: false, matches: [], textLen: 0 };
  }
  const normalized = normalizeQuotes(t);
  const lower = normalized.toLowerCase();
  const matches: RefusalMatch[] = [];

  // Refusal hits are most diagnostic in the first ~400 chars (the model's first sentence).
  const head = lower.slice(0, 600);
  for (const pattern of REFUSAL_PATTERNS) {
    const idx = head.indexOf(pattern);
    if (idx >= 0) {
      matches.push({
        pattern,
        index: idx,
        snippet: t.slice(Math.max(0, idx - 12), Math.min(t.length, idx + pattern.length + 40)),
      });
    }
  }

  // Single-sentence safe-fallback: "I'm sorry, but I can't." style — already caught
  // by direct patterns. The regex below catches very short standalone apology completions
  // (often produced when a safety classifier hijacks the response).
  if (matches.length === 0 && t.length < 200 && SHORT_SAFE_FALLBACK_RE.test(t)) {
    matches.push({
      pattern: "short_apology_fallback",
      index: 0,
      snippet: t.slice(0, 120),
    });
  }

  return {
    isRefusal: matches.length > 0,
    matches,
    textLen: t.length,
  };
}

// Divergence: analysis had substantive non-refusal content, but final is a refusal.
// This is the post-hoc-safety-rewrite signal. Threshold: analysis is non-refusal AND
// at least 200 chars of substantive content; final is a refusal AND less than 30% of
// analysis length (the rewrite is much shorter than the thinking).
export function divergenceVerdict(
  finalText: string | null | undefined,
  analysisText: string | null | undefined,
): DivergenceVerdict {
  const finalRes = detectRefusal(finalText);
  const analysisRes = detectRefusal(analysisText);
  const finalLen = finalRes.textLen;
  const analysisLen = analysisRes.textLen;

  if (!finalRes.isRefusal) {
    return {
      divergent: false,
      reason: null,
      finalLen, analysisLen,
      finalIsRefusal: false,
      analysisLooksLikeRefusal: analysisRes.isRefusal,
    };
  }

  if (analysisLen < 200) {
    return {
      divergent: false,
      reason: "analysis_too_short",
      finalLen, analysisLen,
      finalIsRefusal: true,
      analysisLooksLikeRefusal: analysisRes.isRefusal,
    };
  }

  if (analysisRes.isRefusal) {
    return {
      divergent: false,
      reason: "analysis_also_refused",
      finalLen, analysisLen,
      finalIsRefusal: true,
      analysisLooksLikeRefusal: true,
    };
  }

  // Final shorter than 30% of analysis is the strong rewrite signal.
  if (finalLen < analysisLen * 0.3) {
    return {
      divergent: true,
      reason: "final_refusal_after_substantive_analysis",
      finalLen, analysisLen,
      finalIsRefusal: true,
      analysisLooksLikeRefusal: false,
    };
  }

  return {
    divergent: true,
    reason: "final_refusal_with_full_analysis",
    finalLen, analysisLen,
    finalIsRefusal: true,
    analysisLooksLikeRefusal: false,
  };
}

export const __test = { REFUSAL_PATTERNS };
