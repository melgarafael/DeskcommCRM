"use client";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { useRefetchDeSeguranca } from "@/hooks/realtime/useRefetchDeSeguranca";
import { apiClient } from "@/lib/api/client";
import { HEADER_ORG_DA_ABA } from "@/lib/auth/org-da-aba";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import {
  aplicarEventoNoFio,
  eventoDeMensagem,
  type AutorDoFio,
  type PaginaDeMensagens,
} from "@/lib/inbox/mensagem-do-realtime";
import type { Message } from "@/lib/types/messaging";

export interface MessagesResponse {
  data: Message[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

export function lerPaginaDeMensagens(id: string, cursor: string | undefined, signal: AbortSignal, orgId?: string) {
  const qs = new URLSearchParams({ limit: "50" });
  if (cursor) qs.set("cursor", cursor);
  return apiClient.get<MessagesResponse>(`/api/v1/conversations/${id}/messages?${qs}`, {
    signal,
    headers: orgId ? { [HEADER_ORG_DA_ABA]: orgId } : undefined,
  });
}

export function useMessagesRealtime(
  conversationId: string | null,
  /**
   * Quem está com a conversa aberta — o autor dos próprios envios.
   *
   * O evento do canal é a linha CRUA de `messages`: ele não diz quem enviou
   * (`sent_by_user_name` é derivado na rota, #4031) nem carrega o id do balão
   * otimista. Com o autor aqui, o fio nomeia o primeiro envio de cada pessoa e
   * reconhece o `temp-…` do próprio envio quando a linha real chega — ver
   * `lib/inbox/mensagem-do-realtime.ts`. Sem ele, a mescla continua
   * funcionando; só não faz essas duas coisas.
   */
  autor: AutorDoFio | null = null,
  orgId?: string,
) {
  const qc = useQueryClient();
  const queryKey = useMemo(() => ["messages", conversationId] as const, [conversationId]);

  const query = useInfiniteQuery({
    queryKey,
    enabled: !!conversationId,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      if (!conversationId) return { data: [], meta: { has_more: false, cursor: null } };
      try {
        return await lerPaginaDeMensagens(conversationId, pageParam, signal, orgId);
      } catch (err) {
        if (!signal.aborted) showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (last) =>
      last.meta?.has_more && last.meta.cursor ? last.meta.cursor : undefined,
    /**
     * Voltar para a aba RESSINCRONIZA — aqui, e não no padrão global.
     *
     * O padrão do repo é `refetchOnWindowFocus: false`, e está certo para o
     * resto: recarregar tudo a cada troca de aba é gasto sem retorno numa tela
     * que muda devagar. O inbox é o oposto — é a tela em que a informação chega
     * de fora enquanto ninguém olha, e voltar para ela é exatamente o momento
     * em que a defasagem aparece.
     *
     * É a segunda rede, não a primeira: quem entrega é o Realtime. Esta existe
     * para o intervalo em que ele esteve caído — e foi o sintoma relatado,
     * "às vezes preciso atualizar para a mensagem aparecer".
     */
    refetchOnWindowFocus: true,
  });

  /**
   * O EVENTO DE `messages` NÃO DECLARA O FIO VELHO (#4325 item 5).
   *
   * Antes: cada evento — inclusive os `UPDATE` de confirmação (enviada,
   * entregue, lida), que chegam vários por mensagem enviada — invalidava
   * `["messages", id]` e pedia a recarga da lista. Numa `useInfiniteQuery`
   * invalidar refaz TODAS as páginas do histórico: a conversa aberta era a tela
   * mais cara do inbox, e cada mensagem enviada pagava três GET de mensagens
   * mais um da lista.
   *
   * Agora: o evento traz a linha inteira e ela entra no cache (FIM de
   * `pages[0]` para `INSERT` — a ordem do fio é cronológica —, mescla por `id`
   * para confirmação), sem rede — ver
   * `lib/inbox/mensagem-do-realtime.ts` para por que isso é seguro no fio e não
   * seria na lista de conversas.
   *
   * A recarga da lista SAI daqui de propósito: o canal de `conversations` já
   * recebe o mesmo fato (o `UPDATE` em `conversations` que acompanha a
   * mensagem), e pedir a mesma recarga por dois canais era metade da carga que
   * a issue mediu.
   */
  // Campos primitivos nas dependências: o objeto `autor` é recriado a cada
  // render do `ChatThread`, e o `onChange` do canal não precisa ser.
  const autorId = autor?.id ?? null;
  const autorNome = autor?.nome ?? null;
  const onChange = useCallback(
    (payload: unknown) => {
      if (!conversationId) return;
      const evento = eventoDeMensagem(payload);
      if (!evento) {
        // Payload fora do formato esperado (canal trocado, versão do servidor
        // diferente): o conservador é a recarga de antes.
        void qc.invalidateQueries({ queryKey: ["messages", conversationId] });
        return;
      }
      const autorAtual = autorId ? { id: autorId, nome: autorNome } : null;
      const dados = qc.setQueryData<InfiniteData<PaginaDeMensagens>>(
        ["messages", conversationId],
        (atual) => aplicarEventoNoFio(atual, evento, { autorAtual }) ?? atual,
      );
      // A rota deriva dois campos que a linha crua do canal não traz, e só
      // ela os resolve — nesses dois casos o evento pede UMA recarga:
      //  - `sent_by_user_name` de um colega que o fio ainda não conhece: sem a
      //    recarga o balão diria "Atendente" até a próxima. Só no INSERT —
      //    depois dela o nome está no fio, e as confirmações o preservam;
      //  - `texto_retido` da mensagem que o CONTATO apagou: é a rota
      //    (`mascararTextoRetido`) que liga o botão "Ver texto retido".
      const linha = evento.tipo === "remocao" ? null : evento.linha;
      const semNome =
        evento.tipo === "insercao" &&
        typeof linha?.sent_by_user_id === "string" &&
        !dados?.pages[0]?.data.find((m) => m.id === linha.id)?.sent_by_user_name;
      const apagadaPeloContato =
        evento.tipo === "atualizacao" && linha?.revoked_at != null && linha.direction === "inbound";
      if (semNome || apagadaPeloContato) {
        void qc.invalidateQueries({ queryKey: ["messages", conversationId] });
      }
    },
    [qc, conversationId, autorId, autorNome],
  );

  const { status: realtimeStatus, ultimaEntrega } = useRealtimeChannel({
    name: conversationId ? `messages-${conversationId}` : "messages-disabled",
    postgresChanges: conversationId
      ? {
          event: "*",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        }
      : undefined,
    onChange,
    enabled: !!conversationId,
  });

  /**
   * A REDE DE SEGURANÇA da conversa aberta.
   *
   * A mesma razão da lista, e aqui o custo de ficar velho é maior: a pessoa
   * está OLHANDO a conversa enquanto responde. Com o canal morto e a aba em
   * foco, a resposta do cliente não aparecia até o F5.
   *
   * A assinatura é a contagem de mensagens mais o id da mais recente — a
   * contagem sozinha não flagraria uma mensagem que chega e outra que sai da
   * primeira página no mesmo intervalo. "A mais recente" é a ÚLTIMA do fio: a
   * ordem das páginas é cronológica (crescente), então `msgs[0]` é a mais
   * ANTIGA da página 0 — e a assinatura nunca mudaria quando só o fim muda.
   */
  const seguranca = useRefetchDeSeguranca<{ pages: MessagesResponse[] }>({
    queryKey,
    assinatura: (d) => {
      const msgs = d?.pages.flatMap((p) => p.data) ?? [];
      return `${msgs.length}:${msgs[msgs.length - 1]?.id ?? ""}`;
    },
    ultimaEntrega,
    enabled: !!conversationId,
  });

  return { ...query, realtimeStatus, seguranca };
}
