"use server";

import "server-only";

import {
  type ForYouRecommendation,
  getForYouRecommendationsForUser,
  getRefinedForYouForUser,
  getTasteProfileSummaryForUser,
  type RefinedForYouResult,
  type TasteProfileSummary,
} from "./recommendations-core";
import { getMe, getViewerUserId, isUserAdmin } from "./users";

/**
 * Session-guarded server action for the web UI.
 * Non-admins always get their own recommendations, whatever userId they pass.
 * The trusted engine lives in `recommendations-core.ts`.
 */
export async function getForYouRecommendations({
  serverId,
  userId: requestedUserId,
  mediaType,
  limit = 20,
  offset = 0,
  viewerUserId,
}: {
  serverId: number;
  userId?: string;
  mediaType: "Movie" | "Series";
  limit?: number;
  offset?: number;
  viewerUserId?: string;
}): Promise<ForYouRecommendation[]> {
  const me = await getMe();
  if (!me || me.serverId !== serverId) return [];
  const canActForOthers = requestedUserId === me.id || (await isUserAdmin());
  const userId = requestedUserId && canActForOthers ? requestedUserId : me.id;

  return getForYouRecommendationsForUser({
    serverId,
    userId,
    mediaType,
    limit,
    offset,
    viewerUserId,
  });
}

/**
 * Session-guarded taste profile summary for the current user.
 */
export async function getTasteProfileSummary({
  serverId,
}: {
  serverId: number;
}): Promise<TasteProfileSummary | null> {
  const me = await getMe();
  if (!me || me.serverId !== serverId) return null;
  return getTasteProfileSummaryForUser({ serverId, userId: me.id });
}

/**
 * Session-guarded LLM refinement of the current user's For You row.
 * Returns refined=false when no chat model is configured or the model
 * fails; the client then keeps the engine ordering.
 */
export async function refineForYouRecommendations({
  serverId,
  mediaType,
  limit = 20,
}: {
  serverId: number;
  mediaType: "Movie" | "Series";
  limit?: number;
}): Promise<RefinedForYouResult> {
  const me = await getMe();
  if (!me || me.serverId !== serverId) {
    return { refined: false, items: [] };
  }
  const viewerUserId = await getViewerUserId();
  return getRefinedForYouForUser({
    serverId,
    userId: me.id,
    mediaType,
    limit,
    viewerUserId,
  });
}
