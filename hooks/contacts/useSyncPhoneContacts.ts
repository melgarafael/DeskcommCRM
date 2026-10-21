/**
 * useSyncPhoneContacts — POST /api/v1/contacts/import/agenda (#2736).
 *
 * Fetch cru (não o apiClient) pelo mesmo motivo de useImportContacts: o client
 * serializa body como JSON — o que aqui é exatamente o que se quer — mas o
 * padrão de erro precisa ser sempre `ApiError` para o diálogo mostrar
 * `message` direto no toast.
 */
import { ApiError } from "@/lib/api/types";
import type { ApiErrorBody } from "@/lib/api/types";
import { randomId } from "@/lib/random-id";
import { useMutation, useQueryClient } from "@tanstack/react-query";

/** O mesmo resumo de `ResumoDaAgenda` (lib/contacts/agenda-do-celular.ts), em forma de contrato da API. */
export interface ResumoDaAgenda {
  lidos: number;
  importados: number;
  ja_existentes: number;
  ignorados: number;
  erros: number;
  truncado: boolean;
  /**
   * A linha da agenda por onde o PRÓXIMO clique começa, ou `null` quando acabou.
   * É o cursor que a tela devolve no clique seguinte — sem ele cada clique
   * recomeça do zero e o que passa do milésimo contato nunca entra.
   */
  proximo_offset: number | null;
}

export interface PedidoDeSync {
  channelSessionId: string;
  /** O `proximo_offset` do clique anterior; ausente = primeiro clique. */
  offset?: number;
}

export function useSyncPhoneContacts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ channelSessionId, offset }: PedidoDeSync): Promise<ResumoDaAgenda> => {
      const res = await fetch("/api/v1/contacts/import/agenda", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": randomId() },
        body: JSON.stringify({ channel_session_id: channelSessionId, offset: offset ?? 0 }),
        credentials: "same-origin",
      });
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;
      if (!res.ok) {
        const errBody = parsed as ApiErrorBody | null;
        const e = errBody?.error;
        throw new ApiError(
          res.status,
          e?.code ?? "unknown_error",
          e?.details,
          e?.request_id ?? randomId(),
          e?.message,
        );
      }
      return (parsed as { data: ResumoDaAgenda }).data;
    },
    onSuccess: () => {
      // Contatos novos mudam a lista inteira (qualquer página/filtro) — e a
      // chave `["contacts", "duplicates"]` do painel de duplicados é FILHA
      // desta, então um só invalidate cobre as duas.
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}
