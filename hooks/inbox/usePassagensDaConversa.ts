"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { apiClient } from "@/lib/api/client";
import type { PassagemDaConversa } from "@/lib/escalacao/cartao-da-passagem";

/**
 * AS PASSAGENS DAQUELA CONVERSA — poucas por conversa, query simples.
 *
 * ═══ Por que o canal escuta `conversations`, e não a tabela das passagens ═══
 *
 * Porque `passagens_de_atendimento` **não** está na publicação
 * `supabase_realtime`, e assinar `postgres_changes` numa tabela de fora é uma
 * falha MUDA: o canal conecta, responde `SUBSCRIBED` e nunca recebe nada. Esse
 * defeito está vivo neste repositório — `useConversationNotes` faz exatamente
 * isso com `conversation_notes` — e repeti-lo aqui seria plantar um bug já
 * conhecido num caminho novo.
 *
 * `conversations` ESTÁ na publicação (o laço do baseline a inclui junto de
 * `messages` e `crm_leads`), e ela muda no MESMO instante em que a passagem
 * acontece: o motor grava `bot_silenced_until`/`last_handoff_reason`, e quem
 * assume muda `assigned_to_user_id`. É a carona certa — o cartão aparece e sai
 * do estado "esperando alguém assumir" sem que ninguém recarregue a página.
 *
 * ⚠️ O que essa escolha NÃO dá: reatividade a uma mudança que toque SÓ a
 * passagem. Hoje não existe uma — todo escritor da tabela mexe na conversa no
 * mesmo caminho —, e no dia em que existir, o conserto é pôr a tabela na
 * publicação, não abrir um canal que não recebe.
 */
export function usePassagensDaConversa(conversationId: string | null): PassagemDaConversa[] {
  const podeConsultar = usePermission("inbox.passagens.view");
  const qc = useQueryClient();
  const queryKey = ["passagens", conversationId] as const;

  const query = useQuery({
    queryKey,
    enabled: !!conversationId && podeConsultar,
    queryFn: async ({ signal }) => {
      try {
        return await apiClient.get<{ data: PassagemDaConversa[] }>(
          `/api/v1/conversations/${conversationId}/passagens`, { signal },
        );
      } catch (err) {
        if (!signal.aborted) showApiError(err);
        throw err;
      }
    },
    select: (res) => res.data,
  });

  const onChange = useCallback(() => {
    if (conversationId) qc.invalidateQueries({ queryKey: ["passagens", conversationId] });
  }, [qc, conversationId]);

  useRealtimeChannel({
    name: conversationId ? `conversation-passagens-${conversationId}` : "conversation-passagens-disabled",
    postgresChanges: conversationId
      ? {
          event: "UPDATE",
          schema: "public",
          table: "conversations",
          filter: `id=eq.${conversationId}`,
        }
      : undefined,
    onChange,
    enabled: !!conversationId && podeConsultar,
  });

  return query.data ?? [];
}
