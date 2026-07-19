import "server-only";

import { generateText } from "ai";
import { type ChatConfig, createChatModel } from "./providers";
import { parseRerankResponse, type RerankedPick } from "./reranker-parse";

export type { RerankedPick };

/**
 * LLM re-ranking layer for the recommendation engine.
 *
 * The engine retrieves and scores candidates cheaply; this module lets the
 * server's configured chat model pick and order the best of them and write
 * taste-aware one-line explanations. It is strictly best-effort: any
 * failure, timeout, or malformed response leaves the engine order intact.
 */

export interface RerankCandidate {
  id: string;
  title: string;
  year: number | null;
  genres: string[] | null;
  rating: number | null;
  engineReason: string | null;
}

export interface RerankProfileContext {
  topGenres: string[];
  favouritePeople: string[];
  recentTitles: string[];
  noveltyScore: number | null;
}

function buildPrompt({
  candidates,
  profile,
  mediaType,
  keep,
}: {
  candidates: RerankCandidate[];
  profile: RerankProfileContext;
  mediaType: "Movie" | "Series";
  keep: number;
}): string {
  const profileLines = [
    profile.topGenres.length > 0
      ? `Top genres: ${profile.topGenres.join(", ")}`
      : null,
    profile.favouritePeople.length > 0
      ? `Favourite people: ${profile.favouritePeople.join(", ")}`
      : null,
    profile.recentTitles.length > 0
      ? `Recently watching: ${profile.recentTitles.join(", ")}`
      : null,
    profile.noveltyScore !== null
      ? `Taste breadth (0 focused .. 1 eclectic): ${profile.noveltyScore.toFixed(2)}`
      : null,
  ].filter((line): line is string => line !== null);

  const candidateJson = JSON.stringify(
    candidates.map((c) => ({
      id: c.id,
      title: c.title,
      year: c.year,
      genres: c.genres?.slice(0, 4) ?? [],
      rating: c.rating,
      why: c.engineReason,
    })),
  );

  return [
    `You curate the personalized "${mediaType}s For You" row of a media server.`,
    "",
    "User taste profile:",
    ...profileLines.map((line) => `- ${line}`),
    "",
    `Candidates preselected by the recommendation engine (JSON):`,
    candidateJson,
    "",
    `Pick and order the best ${keep} for this user. Prioritize fit to their taste and what they are watching right now, keep some variety, and avoid stacking near-identical picks.`,
    `Respond with ONLY a JSON array, no other text: [{"id":"...","reason":"..."}]`,
    `Each reason: at most 12 words, addressed to the user (e.g. "Because you loved ..."), no spoilers. Use only ids from the candidate list.`,
  ].join("\n");
}

/**
 * Ask the configured chat model to re-rank engine candidates.
 * Returns the ordered picks, or an error result the caller should treat as
 * "keep the engine order".
 */
export async function rerankWithLlm({
  config,
  candidates,
  profile,
  mediaType,
  keep,
  timeoutMs = 20_000,
}: {
  config: ChatConfig;
  candidates: RerankCandidate[];
  profile: RerankProfileContext;
  mediaType: "Movie" | "Series";
  keep: number;
  timeoutMs?: number;
}): Promise<
  { ok: true; picks: RerankedPick[] } | { ok: false; error: string }
> {
  const model = createChatModel(config);
  if (!model) {
    return { ok: false, error: "No chat model configured" };
  }

  try {
    const { text } = await generateText({
      model,
      prompt: buildPrompt({ candidates, profile, mediaType, keep }),
      maxOutputTokens: 2000,
      temperature: 0.3,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });

    const picks = parseRerankResponse(
      text,
      new Set(candidates.map((c) => c.id)),
      keep,
    );
    if (picks.length === 0) {
      return { ok: false, error: "Model response contained no usable picks" };
    }
    return { ok: true, picks };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "LLM re-ranking failed",
    };
  }
}
