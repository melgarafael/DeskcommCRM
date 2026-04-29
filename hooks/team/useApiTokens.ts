"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { CreateApiTokenInput } from "@/lib/schemas/team";

export interface ApiTokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface CreatedApiToken extends ApiTokenRow {
  plaintext: string;
  _warning: string;
}

export function useApiTokens() {
  return useQuery({
    queryKey: ["api-tokens"],
    queryFn: async () =>
      apiClient.get<{ data: ApiTokenRow[] }>("/api/v1/settings/api-tokens"),
    staleTime: 30_000,
  });
}

export function useCreateApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateApiTokenInput) =>
      apiClient.post<{ data: CreatedApiToken }>("/api/v1/settings/api-tokens", input),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });
}

export function useRevokeApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      apiClient.post<{ data: { id: string; revoked_at?: string; already_revoked?: boolean } }>(
        `/api/v1/settings/api-tokens/${id}/revoke`,
        {},
      ),
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });
}
