/**
 * Menu-style classifier: "given a post and this list of 1..N pain-point insights,
 * which (if any) apply?"
 *
 * Used for LinkedIn Ads audience-building tagging on the residual posts that
 * neither the evidence bootstrap nor the fuzzy pg_trgm pass could tag.
 *
 * Output contract is strict JSON so the caller can parse without fallback handling
 * beyond the same recovery pattern used for post-extraction.
 */

export interface InsightMenuEntry {
  id: number;
  name: string;
  summary: string | null;
}

export const POST_INSIGHT_CLASSIFY_SYSTEM = `You classify LinkedIn posts against a fixed menu of pain-point insights.

Rules:
- Return only insights that the post clearly evidences (theme, pain, or solution discussed).
- Prefer precision over recall: if no insight clearly matches, return an empty list.
- Never invent insight IDs not present in the menu.
- Do not output prose; respond with strict JSON only.`;

export function POST_INSIGHT_CLASSIFY_USER(context: {
  postText: string;
  companyName: string;
  industry: string | null;
  menu: InsightMenuEntry[];
}): string {
  const menuLines = context.menu
    .map((m) => `  ${m.id}. ${m.name}${m.summary ? ` — ${m.summary}` : ""}`)
    .join("\n");
  return `POST by ${context.companyName}${context.industry ? ` (${context.industry})` : ""}:
"""
${context.postText.slice(0, 2000)}
"""

INSIGHT MENU (pick 0..${context.menu.length}; use exact ids from this list):
${menuLines}

Return JSON with this shape exactly:
{
  "matches": [
    { "insight_id": <number from menu>, "confidence": <0..1 number> }
  ]
}

Only include insights the post clearly evidences. Empty list is a valid answer.`;
}

export const POST_INSIGHT_CLASSIFY_PROMPT_VERSION = "v1";
