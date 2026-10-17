"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";

interface MarcarArgs {
  conversation_id: string;
  enabled: boolean;
}

/**
 * MARCA A CONVERSA COMO EXEMPLO PARA O AGENTE APRENDER (#3006).
 *
 * A rota `POST /api/v1/conversations/{id}/usable-for-rag` existia desde a
 * entrega do opt-in de LGPD (L-08) e NENHUMA tela a chamava: quem não usava a
 * API não tinha como marcar um atendimento exemplar. Este hook é a porta da
 * tela — a lógica dela (o que vai para o banco, os campos de auditoria, a
 * limpeza de `rag_review_status`) continua INTEIRA na rota. Aqui só se monta o
 * corpo `{ enabled }` e se diz o que a rota respondeu.
 *
 * ─── Por que invalida as duas chaves ───────────────────────────────────────
 *
 * `["conversations"]` é a lista do Inbox — é ela que desenha o selo da conversa
 * marcada. `["conversation", id]` é a conversa ABERTA, que pode não estar na aba
 * atual (outro filtro, fechada) e cujo cabeçalho também mostra o estado. Sem a
 * segunda, marcar pela lista deixaria a conversa aberta contando outra coisa —
 * a mesma razão que `agendarRecargaDasConversas` documenta para o realtime.
 *
 * `alternar(id, enabled)` e não o `mutate` cru: as duas pontas do fio têm de
 * concordar no formato. O `mutate` recebe o objeto de variáveis, e o controle da
 * linha tem em mãos um id e um booleano — entregar o `mutate` direto faz o
 * `conversation_id` virar `undefined` e a chamada sair para
 * `/conversations/undefined/usable-for-rag`, sem erro de tipo nenhum até o
 * typecheck rodar. A conversão mora aqui, junto de quem conhece o corpo da rota.
 */
export function useMarcarComoExemplo() {
  const qc = useQueryClient();
  const t = useT();

  const marcar = useMutation({
    mutationFn: (args: MarcarArgs) =>
      apiClient.post<{ data: { id: string; usable_for_rag: boolean } }>(
        `/api/v1/conversations/${args.conversation_id}/usable-for-rag`,
        { enabled: args.enabled },
      ),
    onError: showApiError,
    onSuccess: (_data, args) => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
      // O selo só aparece depois do refetch. Sem esta frase, o clique parece
      // não ter feito nada no instante em que mais importa.
      toast.success(
        args.enabled
          ? t("Conversa marcada como exemplo para a IA.")
          : t("A conversa deixou de ser exemplo para a IA."),
      );
    },
  });

  const alternar = (conversation_id: string, enabled: boolean): void => {
    marcar.mutate({ conversation_id, enabled });
  };

  return { alternar, salvando: marcar.isPending };
}
