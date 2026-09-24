"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";

interface Args {
  contact_id: string;
  channel_session_id: string;
}

/**
 * Continua o atendimento do MESMO contato por outro número da organização.
 *
 * A conversa é o fio com aquele contato naquele número (índice único por
 * org, contato e sessão), então trocar de número não é mover a conversa: é abrir
 * — ou reabrir — a do outro número. `open-with-contact` já faz exatamente isso;
 * esta tela só dá a porta que faltava quando o telefone da conversa cai.
 *
 * Depois de abrir, quem pediu assume: `claim` grava o dono e o silêncio do bot
 * numa transação só. Abrir e assumir são DOIS pedidos, então há três desfechos:
 *
 *  - assumiu: a conversa é sua;
 *  - 409: a conversa já tinha dono. O caso comum é a conversa FECHADA daquele
 *    número, que reabre com o dono antigo (fechar não solta o dono) — e o dono
 *    antigo pode ser você mesmo. Relê a conversa para dizer a verdade: se é
 *    sua, silêncio; se é de outra pessoa, nomeia quem;
 *  - outro erro: a conversa JÁ foi aberta, sem dono. Ela é selecionada mesmo
 *    assim, e o erro aparece — esconder a conversa aberta seria pior que mostrar
 *    que não deu para assumi-la.
 *
 * Ninguém rouba atendimento: com dono alheio, trocar de dono é o Transferir.
 */
export function useContinuarPorOutroNumero() {
  const qc = useQueryClient();
  const t = useT();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (args: Args): Promise<string> => {
      const aberta = await apiClient.post<{ data: { conversation_id: string } }>(
        "/api/v1/conversations/open-with-contact",
        args,
      );
      const id = aberta.data.conversation_id;
      try {
        await apiClient.post(`/api/v1/conversations/${id}/claim`, { expected_assignee: null });
        toast.success(t("Atendimento continua pelo outro número."));
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 409)) {
          showApiError(err);
          return id;
        }
        const conversa = await apiClient
          .get<{ data: ConversationWithContact }>(`/api/v1/conversations/${id}`)
          .then((r) => r.data)
          .catch(() => null);
        if (conversa?.assigned_to_user_id === user.id) {
          toast.success(t("Atendimento continua pelo outro número."));
        } else {
          toast.info(
            `${t("A conversa neste número está com")} ${
              conversa?.assigned_to_user_name ?? t("outro atendente")
            }.`,
          );
        }
      }
      return id;
    },
    onError: showApiError,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
