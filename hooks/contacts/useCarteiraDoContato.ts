"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { CarteiraDaTela } from "@/lib/carteira/tela";

/** Corpo de `GET /api/v1/contacts/[id]/carteira`. */
export interface CarteiraDoContatoNaTela extends CarteiraDaTela {
  contact_id: string;
}

/**
 * Lê a carteira do contato para a TELA (#2591 — cartão da ficha e faixa do chat).
 *
 * Read-only e enxuto: usa a mesma porta que já existe (`/contacts/[id]/carteira`)
 * e devolve só o id do dono e se o vínculo conta. O NOME do dono não vem daqui —
 * quem o tem é a lista de membros (`useAssignableMembers`), que a tela já carrega
 * para trocar o dono; resolver o nome na rota criaria uma segunda fonte de nomes.
 *
 * `enabled` existe para a faixa do chat não pedir nada quando não há contato
 * (conversa sem contato vinculado), e para o cartão só pedir quando é desenhado.
 */
export function useCarteiraDoContato(contactId: string, enabled = true) {
  return useQuery({
    queryKey: ["carteira-do-contato", contactId],
    enabled: enabled && !!contactId,
    staleTime: 30_000,
    queryFn: async () =>
      (await apiClient.get<{ data: CarteiraDoContatoNaTela }>(
        `/api/v1/contacts/${contactId}/carteira`,
      )).data,
  });
}

/**
 * Põe/tira o cliente na carteira de um vendedor (`PATCH /contacts/[id]/carteira`).
 *
 * `null` tira da carteira (o contato volta ao fluxo normal). A rota exige
 * `manager`+; quem não pode nem vê o seletor — o gate de papel é do cartão, não
 * daqui, para a mensagem de recusa vir do servidor e não duplicar a régua.
 *
 * Invalida a própria carteira E `["contact", id]`, porque o PATCH mexe no contato
 * que a ficha já tem em cache; sem a segunda chave a tela mostraria o dono velho
 * até um refetch manual — o mesmo cuidado de `usePersonalContact`.
 */
export function useDefinirCarteira(contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (donoUserId: string | null) =>
      apiClient.patch<{ data: { carteira_user_id: string | null } }>(
        `/api/v1/contacts/${contactId}/carteira`,
        { dono_user_id: donoUserId, origem: "manual" },
      ),
    onError: showApiError,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["carteira-do-contato", contactId] });
      void qc.invalidateQueries({ queryKey: ["contact", contactId] });
    },
  });
}
