"use client";
/**
 * O escritor `definir_cor` na mão de quem CRIA a etiqueta (#2718).
 *
 * É o mesmo POST /api/v1/tags/vocabulario que o painel de Settings usa — mesma
 * rota, mesma dupla validação de `#rrggbb` (schema na borda, função no banco),
 * mesma exigência de `manager` + MFA. Aqui ele roda junto do "+" quando o
 * operador escolheu tom antes de criar: a cor nasce com a tag em vez de virar
 * um desvio de três telas depois.
 *
 * Por que é seguro tratar como passo independente do attach: cor é atributo do
 * VOCABULÁRIO, não da linha (`contacts.tags` continua `text[]`, contrato da
 * fatia S4), e o branch `definir_cor` da função faz APPEND —
 * `v_depois || jsonb_build_object('tag', …, 'cor', …)` grava o verbete mesmo
 * que a tag ainda não exista em `organizations.settings.tags`. Então a ordem
 * das duas chamadas não importa, e falhar aqui não desfaz a tag que entrou.
 */
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { apiClient } from "@/lib/api/client";
import { invalidarCoresDasEtiquetas } from "@/components/tags/CoresDasEtiquetas";
import { useT } from "@/hooks/i18n/useT";

/** Cada recusa do servidor vira uma frase que diz O QUE FAZER (espelho do painel). */
const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Confira a etiqueta e a cor.",
  forbidden: "Só um gerente ou administrador da organização pode mudar as etiquetas.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  mfa_required: "Confirme o segundo fator para mudar as etiquetas.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
};

export function useDefinirCorDaEtiqueta() {
  const t = useT();
  const queryClient = useQueryClient();

  /** Grava a cor no vocabulário. `false` quando o servidor recusou (com toast). */
  async function definirCor(tag: string, cor: string): Promise<boolean> {
    try {
      await apiClient.post("/api/v1/tags/vocabulario", {
        acao: "definir_cor",
        tag,
        destino: null,
        cor,
      });
      // O chip da lista, o ponto e o filtro leem o mapa do provider (staleTime
      // de 5 min): sem invalidar, o operador criaria a tag pintada e veria o
      // chip sem cor até o cache vencer.
      invalidarCoresDasEtiquetas(queryClient);
      return true;
    } catch (erro) {
      const codigo = (erro as { code?: string } | null)?.code ?? "internal_error";
      toast.error(t(ERRO_EM_PORTUGUES[codigo] ?? "Não foi possível concluir agora. Tente de novo."));
      return false;
    }
  }

  return { definirCor };
}
