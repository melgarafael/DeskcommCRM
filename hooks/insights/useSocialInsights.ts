"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type {
  SaveSocialConnectionInput,
  SocialConnectionInfo,
  SocialInsightsResponse,
  SocialPlatformFilter,
} from "@/lib/social-insights/types";

export function useSocialInsightsConnection() {
  return useQuery({
    queryKey: ["social-insights", "connection"],
    queryFn: async () => {
      const res = await apiClient.get<{ data: SocialConnectionInfo | null }>(
        "/api/v1/insights/social/connection",
      );
      return res.data;
    },
    staleTime: 60_000,
  });
}

export function useSocialInsights(
  platform: SocialPlatformFilter,
  de?: string,
  ate?: string,
) {
  return useQuery({
    queryKey: ["social-insights", "metrics", platform, de, ate],
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (platform) qs.set("platform", platform);
      if (de) qs.set("de", de);
      if (ate) qs.set("ate", ate);
      const res = await apiClient.get<{ data: SocialInsightsResponse }>(
        `/api/v1/insights/social?${qs.toString()}`,
      );
      return res.data;
    },
    staleTime: 30_000,
  });
}

export function useSaveSocialConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveSocialConnectionInput) =>
      apiClient.post<{ data: SocialConnectionInfo }>(
        "/api/v1/insights/social/connection",
        input,
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["social-insights"] });
    },
  });
}

export function useSyncSocialInsights() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiClient.post<{ data: { sincronizado: boolean } }>(
        "/api/v1/insights/social/sync",
        {},
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["social-insights"] });
    },
  });
}

export function useDisconnectSocial() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      apiClient.delete<{ data: { desconectado: boolean } }>(
        "/api/v1/insights/social/connection",
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["social-insights"] });
    },
  });
}
