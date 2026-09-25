"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { AjusteDeEstilo } from "@/lib/agent-engine/guardrails/ajustes-de-estilo-da-org";

export interface AjusteDeEstiloDaTela {
  ajuste: AjusteDeEstilo;
  enabled: boolean;
}

interface Resposta {
  data: { ajustes: AjusteDeEstiloDaTela[]; podeEditar: boolean };
}

const CHAVE = ["ai", "style-adjustments"] as const;

export function useStyleAdjustments() {
  return useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<Resposta>("/api/v1/ai/style-adjustments")).data,
  });
}

export function useSetStyleAdjustment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { ajuste: AjusteDeEstilo; enabled: boolean }) =>
      apiClient.put("/api/v1/ai/style-adjustments", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: CHAVE }),
  });
}
