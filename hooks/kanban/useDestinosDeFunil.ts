"use client";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/** Uma etapa do funil de destino, como `GET /clone` devolve. */
export interface EtapaDeDestino {
  id: string;
  name: string;
  /** `numeric` no Postgres chega como string pelo PostgREST. */
  position: number | string | null;
  is_won: boolean;
  is_lost: boolean;
}

export interface DestinoDeFunil {
  id: string;
  name: string;
  /** As etapas NÃO arquivadas do funil, na ordem do quadro (issue #3643). */
  stages: EtapaDeDestino[];
}

/**
 * As etapas que podem RECEBER o negócio — nem ganho, nem perda.
 *
 * É a MESMA régua de `escolheEtapaDeDestino` (`lib/leads/clonar-para-funil`), que
 * continua sendo quem decide no POST: aqui ela existe para o seletor não
 * oferecer uma escolha que o servidor vai recusar com 422
 * (`stage_destino_terminal`). Arquivo e ordem vêm resolvidos do servidor (o
 * `GET` já filtra `is_archived` e ordena por `position`); a ordenação numérica
 * fica porque a primeira aberta é o PADRÃO — o que o servidor escolhe quando
 * ninguém mexe no campo — e `position` pode chegar como string.
 */
export function etapasAbertasDoDestino(
  destino: DestinoDeFunil | null | undefined,
): EtapaDeDestino[] {
  if (!destino) return [];
  return (destino.stages ?? [])
    .filter((etapa) => !etapa.is_won && !etapa.is_lost)
    .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
}

/**
 * Para onde este lead pode ir — `GET /api/v1/leads/[id]/clone`
 * (`pipeline.move_card`, agent+). Só busca quando o diálogo está aberto
 * (`enabled`): não há razão para carregar a lista de funis a cada render do
 * menu do card.
 *
 * O corpo traz funil e ETAPAS na mesma resposta porque a rota de etapas
 * (`/api/v1/pipelines/:id/stages`) é `manager`+ e quem leva o card é `agent` —
 * buscar por lá daria seletor de etapa vazio para o vendedor.
 */
export function useDestinosDeFunil(leadId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["lead", leadId, "clone-destinos"],
    queryFn: async () =>
      apiClient.get<{ data: { pipelines: DestinoDeFunil[] } }>(
        `/api/v1/leads/${leadId}/clone`,
      ),
    enabled,
    staleTime: 30_000,
    select: (res) => res.data.pipelines,
  });
}
