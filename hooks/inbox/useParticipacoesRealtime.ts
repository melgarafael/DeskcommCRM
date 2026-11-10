"use client";
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { agendarRecargaDasConversas } from "@/hooks/inbox/recargaDasConversas";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";

/** O próprio vínculo continua legível depois de left_at: a saída também chega. */
export function useParticipacoesRealtime(userId: string | null, orgId: string | null) {
  const qc = useQueryClient();
  const onChange = useCallback((payload: unknown) => {
    agendarRecargaDasConversas(qc);
    void qc.invalidateQueries({ queryKey: ["conversation-counts"] });
    const linha = (payload as { new?: { conversation_id?: string } } | null)?.new;
    if (linha?.conversation_id) {
      // Limpa o snapshot aberto antes de reler: uma remoção não deve continuar
      // desenhando o histórico antigo enquanto a RLS já recusa a conversa.
      void qc.resetQueries({ queryKey: ["conversation", linha.conversation_id] });
      void qc.resetQueries({ queryKey: ["messages", linha.conversation_id] });
    } else {
      // Reconexão: o canal não guarda os eventos que ocorreram enquanto caiu.
      // Um 404 no refetch mantém o dado anterior no react-query. Resetar tira
      // esse snapshot também quando a remoção ocorreu durante a desconexão.
      void qc.resetQueries({ queryKey: ["conversation"] });
      void qc.resetQueries({ queryKey: ["messages"] });
    }
  }, [qc]);
  useRealtimeChannel({
    name: `participacoes-${orgId ?? "sem-org"}-${userId ?? "sem-usuario"}`,
    postgresChanges: userId ? {
      event: "*", schema: "public", table: "conversation_participants", filter: `user_id=eq.${userId}`,
    } : undefined,
    onChange,
    enabled: !!userId && !!orgId,
  });
}
