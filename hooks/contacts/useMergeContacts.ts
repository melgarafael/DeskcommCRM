"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import type { ContactsMergeInput } from "@/lib/schemas/contacts";

export interface ResultadoDaFusao {
  contato_id: string;
  contatos_mesclados: string[];
  /** `tabela.coluna` → quantas linhas passaram a apontar para o vencedor. */
  repontado: Record<string, number>;
  /** O que ficou na lápide por colisão de índice único de runtime. */
  nao_repontado: Record<string, number>;
  atividades_emitidas: number;
}

export function useMergeContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ContactsMergeInput) =>
      apiClient.post<{ data: ResultadoDaFusao }>("/api/v1/contacts/merge", input),
    onError: showApiError,
    onSuccess: (_data, vars) => {
      // A fusão mexe em conversa, negócio e timeline, não só no cadastro — por
      // isso a invalidação é ampla. Invalidar só `contacts` deixaria o Inbox
      // aberto ao lado mostrando uma conversa pendurada no perdedor.
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contact", vars.primary_contact_id] });
      for (const id of vars.secondary_contact_ids) {
        qc.invalidateQueries({ queryKey: ["contact", id] });
      }
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
  });
}
