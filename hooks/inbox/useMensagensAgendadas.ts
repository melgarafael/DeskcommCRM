"use client";
/**
 * Mensagem agendada na conversa (#3118) — a lista e os dois gestos da tela.
 *
 * ─── Por que hooks, e não fetch dentro do compositor ────────────────────────
 *
 * A faixa de agendamentos e o diálogo são dois pedaços da MESMA decisão: quem
 * agendou precisa ver na hora o pacote que acabou de criar. Uma chave de query
 * compartilhada faz o `invalidateQueries` do POST atualizar a faixa sem que as
 * duas telas conversem — o mesmo desenho de `useCreateNote`/`useSendMessage`.
 *
 * ─── O `refetchInterval` da lista ───────────────────────────────────────────
 *
 * O pacote some da faixa quando o worker o dispara, e quem dispara é o servidor:
 * sem consulta periódica, um pacote de 9h00 continuaria desenhado às 9h05 até
 * alguém recarregar a página. Um minuto é mais fino que a granularidade do
 * horário marcado e não custa nada — a rota é um SELECT por conversa.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import { randomId } from "@/lib/random-id";
import type { PacoteAgendado } from "@/lib/inbox/agendamento-na-conversa";

/** A chave da lista de uma conversa. Exportada para quem for invalidar. */
export function chaveDasAgendadas(conversationId: string) {
  return ["mensagens-agendadas", conversationId] as const;
}

interface ListaDeAgendadas {
  data: PacoteAgendado[];
}

export function useMensagensAgendadas(conversationId: string) {
  return useQuery({
    queryKey: chaveDasAgendadas(conversationId),
    queryFn: () =>
      apiClient.get<ListaDeAgendadas>(
        `/api/v1/scheduled-messages?conversation_id=${encodeURIComponent(conversationId)}&limite=20`,
      ),
    refetchInterval: 60_000,
    // A faixa aparece e some sozinha; manter o último resultado durante a
    // troca de conversa evita o pisca-pisca de "carregando" a cada clique.
    placeholderData: (anterior) => anterior,
  });
}

export interface AgendarArgs {
  conversation_id: string;
  /** Instante ISO absoluto — o diálogo converte da hora de parede do campo. */
  scheduled_for: string;
  tz: string;
  body: string;
  cancel_if_contact_replies: boolean;
}

export function useAgendarMensagem(conversationId: string) {
  const qc = useQueryClient();

  return useMutation({
    /**
     * Chave de idempotência por clique, como o envio (`useSendMessage`): se a
     * resposta se perder na rede e a pessoa tocar "Agendar" de novo, a rota
     * devolve o MESMO pacote em vez de criar dois — e dois pacotes iguais são
     * duas mensagens iguais para o cliente.
     */
    mutationFn: (args: AgendarArgs) =>
      apiClient.post<{ data: PacoteAgendado }>(
        "/api/v1/scheduled-messages",
        {
          conversation_id: args.conversation_id,
          scheduled_for: args.scheduled_for,
          tz: args.tz,
          cancel_if_contact_replies: args.cancel_if_contact_replies,
          parts: [{ body: args.body }],
        },
        { idempotencyKey: randomId() },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: chaveDasAgendadas(conversationId) });
    },
    onError: showApiError,
  });
}

export function useCancelarAgendada(conversationId: string) {
  const qc = useQueryClient();

  return useMutation({
    /**
     * O motivo vai na query string porque a rota o lê de lá (`?motivo=`). Sem
     * ele, a rota grava "Cancelada pelo operador" — o mesmo texto que a tela
     * escreveria, então não há segundo vocabulário.
     */
    mutationFn: (id: string) =>
      apiClient.delete<{ data: PacoteAgendado }>(
        `/api/v1/scheduled-messages/${encodeURIComponent(id)}`,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: chaveDasAgendadas(conversationId) });
    },
    onError: showApiError,
  });
}
