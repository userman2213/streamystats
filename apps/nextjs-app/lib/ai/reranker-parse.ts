/**
 * Pure response-parsing for the LLM re-ranker. Kept free of server-only
 * imports so it can be unit tested directly.
 */

export interface RerankedPick {
  id: string;
  reason: string;
}

const MAX_REASON_LENGTH = 140;

/**
 * Extract the ordered picks from a model response.
 * Accepts any text that contains a JSON array of {id, reason} objects;
 * unknown ids, duplicates, and malformed entries are dropped.
 */
export function parseRerankResponse(
  text: string,
  validIds: ReadonlySet<string>,
  keep: number,
): RerankedPick[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const picks: RerankedPick[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = "id" in entry && typeof entry.id === "string" ? entry.id : null;
    const reason =
      "reason" in entry && typeof entry.reason === "string"
        ? entry.reason.trim()
        : "";
    if (!id || !validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    picks.push({ id, reason: reason.slice(0, MAX_REASON_LENGTH) });
    if (picks.length >= keep) break;
  }
  return picks;
}
