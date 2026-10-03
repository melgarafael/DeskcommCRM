"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { toast } from "sonner";
import { traduzir } from "@/lib/i18n/dicionario";
import { idiomaAtual } from "@/lib/i18n/IdiomaProvider";

/**
 * A pré-checagem do handler põe `{ vinculos, por_tabela }` em `error.details`
 * (issue #1925). Com um compromisso na Agenda barrando, a frase diz O QUE barrou
 * e O QUE fazer; qualquer outro caso devolve null e cai no texto genérico.
 * A frase sai de chave fixa do dicionário (a de `vinculos` vem do servidor em
 * pt-BR e não se traduz).
 */
export function mensagemDeBloqueioPorVinculo(
  details: Record<string, unknown> | undefined,
  t: (texto: string) => string,
): string | null {
  const porTabela = details?.por_tabela as Record<string, unknown> | undefined;
  const n = porTabela?.calendar_appointments;
  if (typeof n !== "number" || n < 1) return null;
  return n === 1
    ? t("Este contato tem 1 compromisso na Agenda. Cancele ou apague o compromisso antes de excluir.")
    : t("Este contato tem {n} compromissos na Agenda. Cancele ou apague os compromissos antes de excluir.").replace(
        "{n}",
        String(n),
      );
}

function toastDeBloqueioPorVinculo(err: ApiError): boolean {
  const t = (s: string) => traduzir(s, idiomaAtual());
  const mensagem = mensagemDeBloqueioPorVinculo(err.details, t);
  if (!mensagem) return false;
  toast.error(mensagem, {
    action: {
      label: t("Abrir Agenda"),
      onClick: () => {
        window.location.href = "/app/agenda";
      },
    },
  });
  return true;
}

export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (contactId: string) =>
      apiClient.delete<unknown>(`/api/v1/contacts/${contactId}`),
    onError: (err) => {
      if (err instanceof ApiError && toastDeBloqueioPorVinculo(err)) return;
      showApiError(err);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
    },
  });
}
