"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/** As ações em lote da Inbox — o mesmo discriminante da rota (#2484, F1). */
export type AcaoEmLote =
  | "close"
  | "archive"
  | "mark-read"
  | "pause-ai"
  | "reactivate-bot"
  | "transfer";

/** Uma linha do relatório por item, como a rota devolve. */
export interface ResultadoDoItem {
  id: string;
  feito: boolean;
  codigo?: string;
  motivo?: string;
  request_id?: string;
}

/** O relatório inteiro da chamada em lote. */
export interface RelatorioDoLote {
  acao: AcaoEmLote;
  teto: number;
  total: number;
  feitos: number;
  recusados: number;
  resultados: ResultadoDoItem[];
}

interface BulkArgs {
  ids: string[];
  action: AcaoEmLote;
  /** Só na transferência: membro agent+ da org de destino. */
  to_user_id?: string;
  reason?: string;
}

/**
 * A camada de lote da Inbox: UMA chamada para N conversas (#2484, fatia F1).
 *
 * A rota é uma só (`POST /api/v1/conversations/bulk`); o hook espelha o
 * discriminante dela. Nada de permissão, organização ou auditoria aqui — cada
 * item é resolvido pelo handler da própria conversa, e o que volta é o
 * relatório por item.
 *
 * O toast de sucesso CONTA os dois lados: um lote pela metade não é sucesso
 * nem erro, e quem clicou precisa saber quantas conversas sobraram por fazer
 * — com o motivo de cada recusa, que a rota já manda traduzido.
 */
export function useBulkConversations() {
  const qc = useQueryClient();
  const t = useT();

  return useMutation({
    mutationFn: (args: BulkArgs) =>
      apiClient.post<{ data: RelatorioDoLote }>("/api/v1/conversations/bulk", {
        action: args.action,
        ids: args.ids,
        ...(args.to_user_id ? { to_user_id: args.to_user_id } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      }),
    onError: (err) => {
      // 403/422 da CHAMADA (sem permissão, acima do teto): o lote nem começou.
      showApiError(err);
    },
    onSuccess: (res, args) => {
      const r = res.data;
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation-counts"] });

      const recusados = r.resultados.filter((x) => !x.feito);
      const verbo = args.action === "close" ? t("fechadas") : t("atualizadas");
      if (recusados.length === 0) {
        toast.success(`${r.feitos} ${t("conversas")} ${verbo}.`);
        return;
      }
      toast.warning(`${r.feitos} ${verbo}, ${recusados.length} ${t("recusadas")}.`, {
        description: recusados.map((x) => x.motivo ?? x.codigo ?? t("Recusada.")).join(" · "),
      });
    },
  });
}
