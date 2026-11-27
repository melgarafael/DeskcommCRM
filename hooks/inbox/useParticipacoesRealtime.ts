"use client";
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { agendarRecargaDasConversas } from "@/hooks/inbox/recargaDasConversas";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";

/** O próprio vínculo continua legível depois de left_at: a saída também chega. */
export function useParticipacoesRealtime(
  userId: string | null,
  orgId: string | null,
  revalidar?: (afetada: string | null) => string | null,
) {
  const qc = useQueryClient();
  const onChange = useCallback((payload: unknown) => {
    const evento = payload as { new?: { conversation_id?: string }; old?: { conversation_id?: string } } | null;
    const afetada = evento?.new?.conversation_id ?? evento?.old?.conversation_id ?? null;
    const aberta = revalidar?.(afetada);
    agendarRecargaDasConversas(qc);
    void qc.invalidateQueries({ queryKey: ["conversation-counts"] });
    for (const tipo of ["conversation", "messages", "notes", "passagens"]) {
      const queryKey = afetada ? [tipo, afetada] : [tipo];
      // A tela revalida a conversa aberta. Outra consulta do cache não pode
      // disputar a mesma leitura nem continuar exibindo o snapshot antigo.
      if (aberta && (!afetada || afetada === aberta)) {
        void qc.cancelQueries({ queryKey: [tipo, aberta], exact: false });
      }
      void qc.resetQueries({ queryKey, predicate: ({ queryKey: chave }) => !aberta || chave[1] !== aberta });
    }
  }, [qc, revalidar]);
  useRealtimeChannel({
    name: `participacoes-${orgId ?? "sem-org"}-${userId ?? "sem-usuario"}`,
    postgresChanges: userId ? {
      event: "*", schema: "public", table: "conversation_participants", filter: `user_id=eq.${userId}`,
    } : undefined,
    onChange,
    enabled: !!userId && !!orgId,
  });
}
