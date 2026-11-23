"use client";

/**
 * Os tipos de link que a organização escolheu mostrar (#5128).
 *
 * A escolha é lida UMA vez e compartilhada pelo cache do react-query: a ficha do
 * contato e cada card do funil usam a MESMA chave, então a tela faz uma chamada
 * por sessão (staleTime de 5 min), não uma por card.
 *
 * Enquanto a resposta não chega — ou se ela falhar (403 de sessão antiga, 500 da
 * rota) — devolve o CATÁLOGO INTEIRO. É o comportamento de antes da #5128, e a
 * regra é deliberada: uma tela que falha em carregar a preferência não pode
 * esconder campos que a empresa não pediu para esconder.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { TipoDeLink } from "@/lib/leads/links-de-contato";
import {
  normalizarTiposDeLink,
  TODOS_OS_TIPOS_DE_LINK,
} from "@/lib/leads/tipos-por-organizacao";

/** Chave do cache — a mesma para ficha, card e tela de configuração. */
export const TIPOS_DE_LINK_POR_ORGANIZACAO_KEY = ["settings", "links-de-contato"] as const;

export function useTiposDeLink(): TipoDeLink[] {
  const { data } = useQuery({
    queryKey: TIPOS_DE_LINK_POR_ORGANIZACAO_KEY,
    queryFn: async () =>
      apiClient.get<{ data: { tipos: TipoDeLink[] } }>("/api/v1/settings/links-de-contato"),
    staleTime: 5 * 60_000,
    // Falhou = catálogo inteiro. Insistir três vezes só atrasa a ficha.
    retry: false,
  });

  // `normalizarTiposDeLink` devolve `null` para resposta ausente/vazia/lixo — aí
  // vale o catálogo completo, nunca uma lista sem link.
  const tipos = useMemo(
    () => normalizarTiposDeLink(data?.data?.tipos) ?? [...TODOS_OS_TIPOS_DE_LINK],
    [data],
  );
  return tipos;
}
