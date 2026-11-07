"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * A FILA DE UMA CONVERSA (#3876) — o consumidor que faltava do
 * `PUT /api/v1/conversations/[id]/sector`.
 *
 * A rota existe desde a 9062 e nenhum componente a chamava: o vínculo
 * conversa → setor só nascia por IA ou automação, nunca pelo gesto humano que o
 * texto dela descreve. Aqui está o gesto.
 *
 * Invalida a LISTA e a conversa aberta porque a mudança de fila não muda só o
 * rótulo: conversa sem dono volta para a distribuição (`redistribuiu`), e o
 * cabeçalho precisa reler o estado depois disso. As contagens por fila
 * (`por_fila`) também entram — o número ao lado da fila de origem cai e o da
 * destino sobe, e um badge que não acompanha é badge que mente.
 */
export function useDefinirFilaDaConversa() {
  const qc = useQueryClient();
  const t = useT();

  return useMutation({
    mutationFn: async ({
      conversationId,
      sectorId,
    }: {
      conversationId: string;
      sectorId: string;
    }) =>
      apiClient.put<{ data: { id: string; sector_id: string | null; redistribuiu: boolean } }>(
        `/api/v1/conversations/${conversationId}/sector`,
        { sector_id: sectorId },
      ),
    onError: (err, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversationId] });
      // O erro NÃO vira toast aqui: quem chamou é o diálogo de "Mover para
      // fila", e ele mostra a mesma frase ao lado do botão — onde o gesto
      // começou. Dois avisos para a mesma falha ensinam a ignorar os dois.
    },
    onSuccess: (_res, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversationId] });
      qc.invalidateQueries({ queryKey: ["conversation-counts"] });
      toast.success(t("Conversa movida para a fila."));
    },
  });
}
