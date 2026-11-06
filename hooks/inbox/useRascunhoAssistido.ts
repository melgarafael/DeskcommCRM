"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { sugestaoParaMostrar } from "@/lib/agent-engine/agent/sugestao-de-resposta";

/** O rascunho assistido como ele chega de `/conversations/:id/draft-reply`. */
export interface RascunhoDeResposta {
  id: string;
  revision: string;
  status: string;
  original_body: string | null;
  edited_body: string | null;
  error_code: string | null;
  proposals: Array<{ tool: string; arguments: unknown }>;
}

/**
 * A chave da consulta dos rascunhos da conversa — UMA, para os dois lugares que
 * precisam do mesmo dado (issue #3027).
 *
 * O `Composer` decide com ela se monta o bloco ou o botão de ícone, e o
 * `ReplyReviewPanel` lê os rascunhos por ela. Duas chaves escritas à mão em dois
 * arquivos divergem na primeira mudança — e a divergência aqui é silenciosa: a
 * tela mostraria o botão de ícone E o bloco ao mesmo tempo (ou nenhum dos dois),
 * porque cada um estaria olhando um cache diferente.
 */
export function chaveDosRascunhos(conversationId: string) {
  return ["reply-drafts", conversationId] as const;
}

/**
 * Os rascunhos assistidos de uma conversa, com o poll de 4s de sempre.
 *
 * O que este hook responde é a ÚNICA pergunta que a faixa faz: "há sugestão para
 * mostrar nesta conversa?". A resposta vem de `sugestaoParaMostrar`, a mesma
 * função que o painel já usava para escolher o texto — os estados sem nada a
 * oferecer (`dismissed`, `stale`, `sent`) e a conversa sem rascunho nenhum dão
 * `undefined` e significam a MESMA coisa aqui: não há bloco.
 *
 * `ativo` existe para o modo NOTA: lá o compositor não oferece sugestão de
 * resposta, e a consulta nem sai.
 */
export function useRascunhoAssistido(conversationId: string, ativo = true) {
  const qc = useQueryClient();
  const chave = chaveDosRascunhos(conversationId);
  const query = useQuery({
    queryKey: chave,
    queryFn: () =>
      apiClient.get<{ data: { drafts: RascunhoDeResposta[] } }>(
        `/api/v1/conversations/${conversationId}/draft-reply`,
      ),
    enabled: ativo,
    refetchInterval: ativo ? 4000 : false,
    retry: false,
  });
  return {
    /** A sugestão que merece a faixa — `undefined` = não há bloco a montar. */
    sugestao: sugestaoParaMostrar(query.data?.data.drafts),
    /**
     * Relê os rascunhos agora. Quem gera uma sugestão (o botão de ícone, pelo
     * `POST` do mesmo caminho) chama isto em vez de mexer na chave por fora: a
     * chave e o cliente moram aqui, e quem chama não precisa nem saber que
     * existe cache.
     */
    invalidar: () => qc.invalidateQueries({ queryKey: chave }),
  };
}
