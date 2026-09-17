"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/** Tags em uso nos contatos da org (sugestões do editor). Espelho de `useConversationTagVocabulary`. */
// ponytail: a falha da rota NÃO chega a quem está na tela. O 500 é fechado na
// ação e aberto na informação do lado do servidor (a causa vai ao log com o
// `requestId`), mas aqui não há `onError`, e o editor esconde o bloco por
// `suggestions.length > 0` — erro e "esta organização ainda não tem tag"
// produzem a MESMA tela. Deixado assim de propósito: `useConversationTagVocabulary`
// (hooks/inbox/useConversationTags.ts) tem o buraco idêntico, e consertar um só
// criaria, entre dois editores lado a lado no mesmo painel, a divergência de
// comportamento que ninguém pediu. O conserto é dos DOIS de uma vez, e é uma
// decisão de time: um `showApiError` em query de fundo dispara toast a cada
// abertura do painel enquanto a rota estiver quebrada.
export function useContactTagVocabulary(orgId: string | null) {
  return useQuery({
    queryKey: ["contact-tag-vocabulary", orgId],
    enabled: !!orgId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<string[]> => {
      const res = await apiClient.get<{ data: string[] }>("/api/v1/contact-tags");
      return res.data;
    },
  });
}
