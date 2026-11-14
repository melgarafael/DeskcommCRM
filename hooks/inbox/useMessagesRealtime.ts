"use client";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { useRefetchDeSeguranca } from "@/hooks/realtime/useRefetchDeSeguranca";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import {
  aplicarEventoNoFio,
  eventoDeMensagem,
  type PaginaDeMensagens,
} from "@/lib/inbox/mensagem-do-realtime";
import type { Message } from "@/lib/types/messaging";

interface MessagesResponse {
  data: Message[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

export function useMessagesRealtime(conversationId: string | null) {
  const qc = useQueryClient();
  const queryKey = useMemo(() => ["messages", conversationId] as const, [conversationId]);

  const query = useInfiniteQuery({
    queryKey,
    enabled: !!conversationId,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      if (!conversationId) {
        return { data: [], meta: { has_more: false, cursor: null } } as MessagesResponse;
      }
      const qs = new URLSearchParams();
      if (pageParam) qs.set("cursor", pageParam);
      qs.set("limit", "50");
      try {
        return await apiClient.get<MessagesResponse>(
          `/api/v1/conversations/${conversationId}/messages?${qs.toString()}`,
        );
      } catch (err) {
        showApiError(err);
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
   * Agora: o evento traz a linha inteira e ela entra no cache (`pages[0]` para
   * `INSERT`, mescla por `id` para confirmação), sem rede — ver
   * `lib/inbox/mensagem-do-realtime.ts` para por que isso é seguro no fio e não
   * seria na lista de conversas.
   *
   * A recarga da lista SAI daqui de propósito: o canal de `conversations` já
   * recebe o mesmo fato (o `UPDATE` em `conversations` que acompanha a
   * mensagem), e pedir a mesma recarga por dois canais era metade da carga que
   * a issue mediu.
   */
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
      qc.setQueryData<InfiniteData<PaginaDeMensagens>>(
        ["messages", conversationId],
        (dados) => aplicarEventoNoFio(dados, evento) ?? dados,
      );
    },
    [qc, conversationId],
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
   * primeira página no mesmo intervalo.
   */
  const seguranca = useRefetchDeSeguranca<{ pages: MessagesResponse[] }>({
    queryKey,
    assinatura: (d) => {
      const msgs = d?.pages.flatMap((p) => p.data) ?? [];
      return `${msgs.length}:${msgs[0]?.id ?? ""}`;
    },
    ultimaEntrega,
    enabled: !!conversationId,
  });

  return { ...query, realtimeStatus, seguranca };
}
