"use client";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { GrupoDeRespostas } from "@/lib/templates/grupos";
import type { MidiaDeTemplate } from "@/lib/templates/midias";

export type { GrupoDeRespostas };

export interface MessageTemplate {
  id: string;
  title: string;
  body: string;
  shortcut: string | null;
  owner_user_id: string | null;
  /**
   * As imagens que o próprio operador carregou no template (#2526).
   * Opcional de propósito: linha anterior à migration 0643 e fixture de teste
   * vêm sem a chave, e as duas são "só texto" — nenhum dos dois casos pode
   * quebrar quem lê.
   */
  midias?: MidiaDeTemplate[] | null;
  /**
   * "Mostrar na barra do Inbox" (#3282) — `message_templates.mostrar_na_barra`.
   * Opcional/lido como ligado por ausência: linha anterior à migration 0742 e
   * fixture sem a chave aparecem na barra, como sempre.
   */
  mostrar_na_barra?: boolean | null;
  /**
   * A POSIÇÃO da resposta rápida na lista (#3244), a que o arrastar e soltar da
   * tela grava. Opcional pelo mesmo motivo das mídias: linha anterior à migration
   * 0729 e fixture de teste vêm sem a chave, e quem só lê não pode quebrar.
   */
  ordem?: number;
  /**
   * O GRUPO da resposta rápida (#3245) — `message_templates.grupo_id`.
   * Opcional/nulo por ausência: linha anterior à migration 0808 e fixture de
   * teste vêm sem a chave, e as duas são "sem grupo" — a lista plana de sempre.
   */
  grupo_id?: string | null;
}

/** A chave da lista — a tela e a mutação de ordem invalidam a MESMA. */
export const CHAVE_DOS_TEMPLATES = ["message-templates"] as const;

/** A chave dos GRUPOS (#3245) — separada porque é outro endpoint e outra linha. */
export const CHAVE_DOS_GRUPOS = ["message-template-groups"] as const;

/** Onda 5: templates de script (pessoais + compartilhados) para o slash-menu do composer. */
export function useMessageTemplates() {
  const podeConsultar = usePermission("message-templates.view");
  return useQuery({
    enabled: podeConsultar,
    queryKey: CHAVE_DOS_TEMPLATES,
    queryFn: async () => apiClient.get<{ data: MessageTemplate[] }>("/api/v1/message-templates"),
    staleTime: 60_000,
    select: (res) => res.data,
  });
}

/**
 * A REORDENAÇÃO (#3244) — arrastar uma resposta rápida e soltar em outro lugar.
 *
 * O que vai no fio é o VIZINHO (`depois_de`), não o índice: a mesma decisão da
 * rota (`app/api/v1/message-templates/[id]/ordem/route.ts`) e da reordenação de
 * etapa do funil. O `null` é a primeira posição.
 *
 * A invalidação é da MESMA chave da listagem: é ela que o slash-menu do Inbox lê
 * (`Composer` → `useMessageTemplates`), então a ordem nova chega lá sem nenhum
 * caminho paralelo — o Inbox RESPEITA a ordem porque lê a mesma lista.
 */
export function useMoverTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, depoisDe }: { id: string; depoisDe: string | null }) =>
      apiClient.put<{ data: MessageTemplate }>(`/api/v1/message-templates/${id}/ordem`, {
        depois_de: depoisDe,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE_DOS_TEMPLATES }),
  });
}

/**
 * OS GRUPOS de respostas rápidas (#3245) — a lista que agrupa e a barra do
 * Inbox usam. Sem grupo nenhum a tela cai na lista plana, e é `grupos.length
 * === 0` (não uma marca de configuração) que decide isso.
 */
export function useGruposDeRespostas() {
  const podeConsultar = usePermission("message-templates.view");
  return useQuery({
    enabled: podeConsultar,
    queryKey: CHAVE_DOS_GRUPOS,
    queryFn: async () =>
      apiClient.get<{ data: GrupoDeRespostas[] }>("/api/v1/message-template-groups"),
    staleTime: 60_000,
    select: (res) => res.data,
  });
}

/**
 * A REORDENAÇÃO do grupo (#3245) — o mesmo contrato da resposta rápida: vai o
 * VIZINHO (`depois_de`), `null` é a primeira posição.
 *
 * A invalidação alcança os DOIS caches: a ordem dos grupos muda a lista da tela
 * e a ordem das seções na barra do Inbox, e a barra lê o mesmo hook.
 */
export function useMoverGrupo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, depoisDe }: { id: string; depoisDe: string | null }) =>
      apiClient.put<{ data: GrupoDeRespostas }>(`/api/v1/message-template-groups/${id}/ordem`, {
        depois_de: depoisDe,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE_DOS_GRUPOS }),
  });
}
