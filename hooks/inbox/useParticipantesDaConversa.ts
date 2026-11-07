"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";

import { apiClient } from "@/lib/api/client";
import { usePermission } from "@/hooks/auth/AuthProvider";

/**
 * O ATENDIMENTO CONJUNTO (issue #2542) — a tela lê e escreve pela rota
 * `/api/v1/conversations/[id]/participants`, e SÓ por ela.
 *
 * ─── Por que uma camada, e não `apiClient` direto no componente ────────────
 *
 * A regra que esta feature tem de acertar é uma: convidar NÃO muda o dono, e a
 * lista é a única fonte de "quem está nesta conversa". As duas dependem da
 * MESMA chave de cache — o `invalidateQueries` abaixo é o que faz a lista
 * recarregar depois do convite. Espalhar a URL e a chave por dois componentes
 * faria o segundo copiar o primeiro, e é assim que uma tela passa a mostrar uma
 * lista que não corresponde ao servidor.
 *
 * ─── O que a rota devolve, e o que a tela NÃO inventa ─────────────────────
 *
 * O `GET` devolve o vínculo cru (`id`, `user_id`, `invited_by`, `joined_at`).
 * Nome e avatar NÃO vêm daqui: a rota de participantes não conhece o diretório
 * `auth.users`, e inventá-los no cliente a partir do `user_id` seria um palpite.
 * Quem sabe os nomes é `/api/v1/team/assignable` (`useAssignableMembers`), que a
 * tela cruza pelo `user_id` — o mesmo diretório que o "Transferir" já usa.
 */
export interface ParticipanteDaConversa {
  id: string;
  user_id: string;
  invited_by: string | null;
  joined_at: string;
}

/** A chave da lista. Exportada porque o convite invalida EXATAMENTE esta. */
export function chaveDosParticipantes(conversationId: string) {
  return ["conversation", conversationId, "participants"] as const;
}

/**
 * Quem participa ativamente desta conversa (o `left_at` já vem filtrado na rota).
 *
 * O `enabled` do chamador é ANDADO com `usePermission("inbox.participantes.view")`
 * — o MESMO padrão dos hooks irmãos (`useConversationNotes`,
 * `usePassagensDaConversa`). É decisão de CLIENTE porque é o único lado que
 * conhece o papel: um `viewer` não precisa da lista para ler a conversa, e sem o
 * gate ele pedia `GET /participants` em TODA abertura (a rota recusava e gravava
 * um `authz.denied` a cada uma). Não é `podeConvidar`: o convidado, que não pode
 * convidar, CONTINUA lendo a lista — ele é `agent`+.
 */
export function useParticipantesDaConversa(conversationId: string, enabled = true) {
  const podeConsultar = usePermission("inbox.participantes.view");
  const qc = useQueryClient();
  const onChange = useCallback(() => {
    void qc.invalidateQueries({ queryKey: chaveDosParticipantes(conversationId) });
  }, [qc, conversationId]);
  // A escrita do vínculo toca updated_at da conversa na mesma transação.
  // Dono e gestor recebem esse evento sem ganhar SELECT na participação alheia.
  useRealtimeChannel({
    name: `participantes-da-conversa-${conversationId}`,
    postgresChanges: conversationId ? {
      event: "UPDATE", schema: "public", table: "conversations", filter: `id=eq.${conversationId}`,
    } : undefined,
    onChange,
    enabled: enabled && podeConsultar && !!conversationId,
  });
  return useQuery({
    queryKey: chaveDosParticipantes(conversationId),
    queryFn: async () =>
      apiClient.get<{ data: { participantes: ParticipanteDaConversa[] } }>(
        `/api/v1/conversations/${conversationId}/participants`,
      ),
    enabled: enabled && podeConsultar && conversationId.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    select: (res) => res.data.participantes,
  });
}

/**
 * Convidar um colega. A escrita vai só com `{ user_id }`: organização e conversa
 * são inferidas no servidor (cookie de sessão + `id` do caminho), nunca do corpo
 * — o mesmo contrato de `useTransferConversation`.
 *
 * `onSuccess` invalida a lista. Sem isto, o convite daria 201 e a tela continuaria
 * mostrando a lista antiga — o convidado entrava sem aparecer para quem o convidou.
 * A `[conversations]` entra junto porque a conversa convidada passa a aparecer na
 * lista do convidado (o ramo de participante da policy), e o Inbox dele é essa chave.
 */
export function useConvidarParticipante(conversationId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (userId: string) =>
      apiClient.post<{ data: { participante: ParticipanteDaConversa } }>(
        `/api/v1/conversations/${conversationId}/participants`,
        { user_id: userId },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: chaveDosParticipantes(conversationId) });
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation-counts"] });
    },
  });
}

/** Saída e remoção usam a mesma porta; a autorização é revalidada no servidor. */
export function useRemoverParticipante(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => apiClient.delete<{ data: { removidos: number } }>(
      `/api/v1/conversations/${conversationId}/participants`, { user_id: userId },
    ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: chaveDosParticipantes(conversationId) });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void qc.invalidateQueries({ queryKey: ["conversation-counts"] });
    },
  });
}
