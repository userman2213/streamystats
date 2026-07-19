"use client";

import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getForYouRecommendations,
  refineForYouRecommendations,
} from "@/lib/db/recommendations";
import type { ForYouRecommendation } from "@/lib/db/recommendations-core";
import { hideRecommendation } from "@/lib/db/similar-statistics";
import type { ServerPublic } from "@/lib/types";
import { RecommendationsSection } from "./RecommendationsSection";

interface Props {
  data: ForYouRecommendation[];
  server: ServerPublic;
}

const formatRuntime = (ticks: number | null) => {
  if (!ticks) {
    return null;
  }
  const minutes = Math.floor(ticks / 600000000);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours > 0) {
    return `${hours}h ${remainingMinutes > 0 ? `${remainingMinutes}m` : ""}`;
  }
  return `${minutes}m`;
};

function ForYouRow({
  data,
  server,
  mediaType,
  title,
  emptyMessage,
  withRuntime,
}: Props & {
  mediaType: "Movie" | "Series";
  title: string;
  emptyMessage: string;
  withRuntime?: boolean;
}) {
  const [recommendations, setRecommendations] = useState(data);

  useEffect(() => {
    setRecommendations(data);
  }, [data]);

  // Best-effort LLM refinement: render the engine order immediately, then
  // swap in the chat model's ordering and explanations when available
  useEffect(() => {
    let active = true;
    refineForYouRecommendations({ serverId: server.id, mediaType })
      .then((result) => {
        if (active && result.refined && result.items.length > 0) {
          setRecommendations(result.items);
        }
      })
      .catch(() => {
        // Keep the engine ordering on any failure
      });
    return () => {
      active = false;
    };
  }, [server.id, mediaType]);

  const fetchNextPage = async (offset: number) => {
    return getForYouRecommendations({
      serverId: server.id,
      mediaType,
      offset,
    });
  };

  return (
    <RecommendationsSection
      title={title}
      description="Personalized picks from your taste profile, viewing patterns, and library connections"
      icon={Sparkles}
      recommendations={recommendations}
      server={server}
      onHideRecommendation={hideRecommendation}
      formatRuntime={withRuntime ? formatRuntime : undefined}
      emptyMessage={emptyMessage}
      fetchNextPage={fetchNextPage}
      requiresEmbeddings={false}
    />
  );
}

export const ForYouMovies = (props: Props) => (
  <ForYouRow
    {...props}
    mediaType="Movie"
    title="Movies For You"
    emptyMessage="Watch a few movies and recommendations will appear here"
    withRuntime
  />
);

export const ForYouSeries = (props: Props) => (
  <ForYouRow
    {...props}
    mediaType="Series"
    title="Series For You"
    emptyMessage="Watch a few series and recommendations will appear here"
  />
);
