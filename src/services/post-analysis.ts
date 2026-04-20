/**
 * Two-stage Claude-powered analysis pipeline.
 *
 * Stage 1 (Haiku): Extract topics, pain points, sentiment from individual posts.
 * Stage 2 (Sonnet): Synthesize cross-post pain point insights per microsegment.
 */
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import { POST_EXTRACTION_SYSTEM, POST_EXTRACTION_USER } from "../prompts/post-extraction.js";
import { PAIN_SYNTHESIS_SYSTEM, PAIN_SYNTHESIS_USER } from "../prompts/pain-synthesis.js";
import type { PostExtractionResult, SynthesizedInsight } from "../types.js";

dotenv.config();

const anthropic = new Anthropic({
  authToken: process.env.ANTHROPIC_AUTH_TOKEN,
  defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
});

const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";
const SYNTHESIS_MODEL = "claude-haiku-4-5-20251001";
const EXTRACTION_PROMPT_VERSION = "v1";
const SYNTHESIS_PROMPT_VERSION = "v1";

/**
 * Stage 1: Analyze a single post with Haiku.
 */
export async function extractPostInsights(context: {
  postText: string;
  authorName: string;
  authorTitle: string;
  authorCompany: string;
  postDate: string;
  likeCount: number;
  commentCount: number;
  microsegmentLabel: string;
}): Promise<{ result: PostExtractionResult; tokenUsage: any }> {
  const response = await anthropic.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 1024,
    system: POST_EXTRACTION_SYSTEM,
    messages: [
      {
        role: "user",
        content: POST_EXTRACTION_USER(context),
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  let result: PostExtractionResult;
  try {
    result = JSON.parse(text);
  } catch {
    // Attempt to extract JSON from response
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      result = JSON.parse(match[0]);
    } else {
      throw new Error(`Failed to parse extraction response: ${text.slice(0, 200)}`);
    }
  }

  // Validate and normalize
  result.topics = result.topics ?? [];
  result.pain_points = result.pain_points ?? [];
  result.sentiment = result.sentiment ?? "neutral";
  result.sentiment_score = result.sentiment_score ?? 0;
  result.intent_signals = result.intent_signals ?? [];
  result.key_quotes = result.key_quotes ?? [];

  return {
    result,
    tokenUsage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      model: EXTRACTION_MODEL,
    },
  };
}

/**
 * Stage 2: Synthesize insights across all analyzed posts for a microsegment.
 */
export async function synthesizePainPoints(context: {
  microsegmentId: string;
  microsegmentLabel: string;
  totalPosts: number;
  totalContacts: number;
  totalCompanies: number;
  posts: Array<{
    postUrl: string;
    authorName: string;
    authorCompany: string;
    topics: string[];
    painPoints: string[];
    sentiment: string;
    sentimentScore: number;
    keyQuotes: string[];
    postDate: string;
  }>;
}): Promise<{ insights: SynthesizedInsight[]; tokenUsage: any }> {
  // Truncate posts if too large for context window
  let postsForPrompt = context.posts;
  const maxChars = 150_000; // Conservative limit for Sonnet
  let serialized = JSON.stringify(postsForPrompt);
  if (serialized.length > maxChars) {
    // Prioritize posts with pain points
    const withPain = postsForPrompt.filter((p) => p.painPoints.length > 0);
    const without = postsForPrompt.filter((p) => p.painPoints.length === 0);
    postsForPrompt = [...withPain, ...without];

    while (JSON.stringify(postsForPrompt).length > maxChars && postsForPrompt.length > 50) {
      postsForPrompt = postsForPrompt.slice(0, postsForPrompt.length - 10);
    }
    serialized = JSON.stringify(postsForPrompt);
    console.log(
      `  Truncated to ${postsForPrompt.length}/${context.posts.length} posts for synthesis`,
    );
  }

  const response = await anthropic.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: 8192,
    system: PAIN_SYNTHESIS_SYSTEM,
    messages: [
      {
        role: "user",
        content: PAIN_SYNTHESIS_USER({
          ...context,
          posts: postsForPrompt,
        }),
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  let parsed: { insights: SynthesizedInsight[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      throw new Error(`Failed to parse synthesis response: ${text.slice(0, 200)}`);
    }
  }

  return {
    insights: parsed.insights ?? [],
    tokenUsage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      model: SYNTHESIS_MODEL,
    },
  };
}

export { EXTRACTION_MODEL, SYNTHESIS_MODEL, EXTRACTION_PROMPT_VERSION, SYNTHESIS_PROMPT_VERSION };
