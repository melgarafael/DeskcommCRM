"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { ApiError, type ApiErrorBody } from "@/lib/api/types";
import { randomId } from "@/lib/random-id";

export interface InstalledSkill {
  name: string;
  description: string;
  version_id: string;
  source: "manual" | "catalog";
  updated_at: string;
}
export interface CatalogSkill {
  name: string;
  description: string;
}
export interface SkillsState {
  installed: InstalledSkill[];
  catalog: CatalogSkill[];
}

export interface SkillMatcher {
  any_keywords: string[];
  probe_keywords?: string[];
}

/** Corpo completo de uma skill instalada, para o editor. */
export interface SkillComCorpo {
  name: string;
  description: string;
  body: string;
  matcher: SkillMatcher;
  version_id: string;
  updated_at?: string;
}

export interface SalvarSkillBody {
  description: string;
  body: string;
  matcher: SkillMatcher;
}

const KEY = ["skills"];

export function useSkills(initial?: SkillsState) {
  return useQuery({
    queryKey: KEY,
    ...(initial !== undefined ? { initialData: initial } : {}),
    queryFn: () => apiClient.get<{ data: SkillsState }>("/api/v1/ai/skills").then((r) => r.data),
  });
}

/** GET do corpo/matcher de UMA skill instalada (abre o editor). */
export function useSkill(name: string | null) {
  return useQuery({
    queryKey: ["skills", "detail", name],
    enabled: name !== null,
    queryFn: () =>
      apiClient
        .get<{ data: SkillComCorpo }>(`/api/v1/ai/skills/${encodeURIComponent(name ?? "")}`)
        .then((r) => r.data),
  });
}

/** PUT — salva uma versão NOVA do corpo e move o ponteiro da organização. */
export function useSalvarSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body: SalvarSkillBody }) =>
      apiClient.put<{ data: { name: string; version_id: string } }>(
        `/api/v1/ai/skills/${encodeURIComponent(name)}`,
        body,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useInstallSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiClient.post<{ data: { version_id: string } }>(`/api/v1/ai/skills/${encodeURIComponent(name)}/install`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUninstallSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiClient.delete<{ data: { name: string } }>(`/api/v1/ai/skills/${encodeURIComponent(name)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

/**
 * Upload multipart — `apiClient` sempre serializa o body como JSON, então este
 * mutation faz o fetch direto (mesmo tratamento de erro do apiClient: parseia
 * `{error}` e lança ApiError, pra `showApiError` funcionar igual nos outros hooks).
 */
export function useImportSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/v1/ai/skills/import", {
        method: "POST",
        headers: { "Idempotency-Key": randomId() },
        body: form,
        credentials: "same-origin",
      });
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const errBody = parsed as ApiErrorBody | null;
        const e = errBody?.error;
        throw new ApiError(
          res.status,
          e?.code ?? "unknown_error",
          e?.details,
          e?.request_id ?? randomId(),
          e?.message,
        );
      }
      return parsed as { data: { name: string; version_id: string } };
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}
