import { describe, expect, test } from "bun:test";
import { parseRerankResponse } from "./reranker-parse";

const validIds = new Set(["a", "b", "c"]);

describe("parseRerankResponse", () => {
  test("parses a clean JSON array", () => {
    const picks = parseRerankResponse(
      '[{"id":"b","reason":"Because you loved X"},{"id":"a","reason":"Y"}]',
      validIds,
      10,
    );
    expect(picks.map((p) => p.id)).toEqual(["b", "a"]);
    expect(picks[0].reason).toBe("Because you loved X");
  });

  test("extracts the array from surrounding prose and code fences", () => {
    const text =
      'Sure! Here are my picks:\n```json\n[{"id":"c","reason":"fits"}]\n```\nEnjoy!';
    expect(parseRerankResponse(text, validIds, 10)).toEqual([
      { id: "c", reason: "fits" },
    ]);
  });

  test("drops unknown ids, duplicates, and malformed entries", () => {
    const picks = parseRerankResponse(
      '[{"id":"zz","reason":"nope"},{"id":"a","reason":"ok"},{"id":"a","reason":"dupe"},{"reason":"no id"},"junk"]',
      validIds,
      10,
    );
    expect(picks).toEqual([{ id: "a", reason: "ok" }]);
  });

  test("respects the keep limit and truncates long reasons", () => {
    const picks = parseRerankResponse(
      `[{"id":"a","reason":"${"x".repeat(500)}"},{"id":"b","reason":"y"},{"id":"c","reason":"z"}]`,
      validIds,
      2,
    );
    expect(picks).toHaveLength(2);
    expect(picks[0].reason.length).toBeLessThanOrEqual(140);
  });

  test("returns empty on garbage or missing array", () => {
    expect(parseRerankResponse("no json here", validIds, 5)).toEqual([]);
    expect(parseRerankResponse('{"id":"a"}', validIds, 5)).toEqual([]);
    expect(parseRerankResponse("[not valid json]", validIds, 5)).toEqual([]);
  });
});
