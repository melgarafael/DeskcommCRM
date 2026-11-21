"use client";
import { useQuery } from "@tanstack/react-query";

import type { CustomFieldDef } from "@/components/contacts/CustomFieldsEditor";
import { apiClient } from "@/lib/api/client";

/**
 * As definições de campo do CONTATO da organização inteira (issue #4929), para a
 * lista de contatos abrir o `EditContactDialog` com a MESMA seção que a ficha
 * mostra.
 *
 * Uma chamada só: a rota faz a união dos campos de contato de todos os funis no
 * servidor, com a mesma leitura que o PATCH usa para julgar o `custom_fields`.
 * Juntar os funis aqui seria a segunda régua — e N chamadas de definição.
 *
 * Sem organização não há o que perguntar (`enabled`); falha de leitura devolve
 * lista vazia, e o diálogo abre sem a seção, como abria antes.
 */
export function useCamposDeContatoDaOrg(habilitado: boolean) {
  return useQuery({
    queryKey: ["campos-de-contato-da-org"],
    enabled: habilitado,
    staleTime: 60_000,
    queryFn: async (): Promise<CustomFieldDef[]> => {
      const corpo = await apiClient.get<{ data: { definicoes: CustomFieldDef[] } }>(
        "/api/v1/contacts/campos-de-contato",
      );
      return corpo.data?.definicoes ?? [];
    },
  });
}
