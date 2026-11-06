"use client";
/**
 * A PÁGINA DA LISTA DO FUNIL (#3172, fatia 1).
 *
 * ─── Por que uma consulta por página, e não o funil inteiro ─────────────────
 *
 * O quadro já lê o funil todo (`useBoard`) porque precisa de todas as colunas
 * montadas. A lista existe justamente para o funil que NÃO cabe numa leitura
 * só: uma linha por negócio, uma página por vez, paginada no BANCO. Por isso o
 * hook busca `?page=`, e não fatia em memória um array que veio completo — a
 * diferença não é de estilo, é o custo que a issue mede (o quadro levou 19 s
 * num funil migrado, e a lista não tem esse teto).
 *
 * ─── O que ele faz com o envelope ───────────────────────────────────────────
 *
 * `apiClient.get` devolve o corpo como veio (`{ data, meta }`), então quem
 * traduz o envelope é este hook: a tela recebe `leads` e o `has_more` já
 * lidos, e não precisa saber a forma da rota. `meta` ausente NÃO vira `hasMore:
 * true`: prometer próxima página a partir de uma resposta sem `meta` mandaria a
 * tela buscar uma página que ninguém disse que existe. Ausente é `false`, que
 * degrada para "só esta página" — nunca para uma lista infinitamente vazia.
 *
 * ⚠️ NÃO HÁ `total`. A rota deixou de contar (a contagem exata varria o funil
 * inteiro, e só servia para o "página X de Y"): o que a página sabe é o
 * `per_page` que pediu e o `has_more` que voltou. Por isso a tela mostra a
 * página ATUAL — um número verdadeiro — e não um "de Y" aproximado.
 */
import { useQuery } from "@tanstack/react-query";

import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import { apiClient } from "@/lib/api/client";
import { type FiltrosDaLista, paramsDosFiltrosDaLista } from "@/lib/kanban/filtros-da-lista";
import type { Lead } from "@/lib/types/leads";

/** O tamanho de página padrão — o mesmo que a rota usa quando não vem `per_page`. */
export const LEADS_POR_PAGINA = 50;

export interface PaginaDeLeads {
  leads: Lead[];
  page: number;
  perPage: number;
  hasMore: boolean;
}

/** O envelope da rota, com tudo opcional: o hook é quem decide o que fazer sem ele. */
type RespostaDaRota = {
  data?: Lead[];
  meta?: {
    page?: number;
    per_page?: number;
    has_more?: boolean;
  };
};

/**
 * A chave de cache POR PÁGINA — e exportada.
 *
 * A página faz parte da chave de propósito: com a chave pelo funil apenas,
 * voltar para a página 1 mostraria a 2 do cache, e avançar pediria refetch de
 * uma página que já estava na mão.
 *
 * O FILTRO também faz parte dela (`paramsDosFiltrosDaLista`, em ordem fixa): a
 * página 1 de "Responsável: Ana" e a página 1 sem filtro são respostas
 * diferentes, e com a mesma chave a troca de filtro mostraria a anterior.
 *
 * ⚠️ ELA MORA DEBAIXO DA CHAVE DO QUADRO (`["board", pipelineId, "lista", n, filtro]`).
 * Toda escrita no funil — Novo Lead, editar pela ficha, ganhar, perder, mover,
 * etiqueta, proposta, tarefa — invalida `["board", pipelineId]` ou `["board"]`,
 * e o `invalidateQueries` casa por PREFIXO: com a página debaixo do quadro, a
 * Lista se atualiza em toda escrita que já atualiza o quadro, sem cada uma
 * precisar lembrar de uma segunda chave. Com a chave solta
 * (`["leads-paginados", …]`) ninguém a invalidava: o lead criado não aparecia
 * na Lista e a ficha aberta por ela mostrava o valor antigo até o F5.
 *
 * O preço: quem filtra `["board"]` por prefixo alcança também as páginas. Os
 * `setQueryData` do quadro usam a chave EXATA, e nenhum código faz
 * `setQueriesData`/`getQueriesData` sobre `["board"]` — quem passar a fazer
 * tem de excluir o `"lista"`. A Lista se atualizar na escrita é vigiado em
 * `tests/unit/lista-se-atualiza-na-escrita.test.tsx`.
 */
export function chaveDosLeadsPaginados(
  pipelineId: string | null,
  pagina: number,
  filtros: FiltrosDaLista = {},
) {
  return [...chaveDoQuadro(pipelineId), "lista", pagina, paramsDosFiltrosDaLista(filtros)] as const;
}

export function useLeadsPaginados(
  pipelineId: string | null,
  pagina: number,
  filtros: FiltrosDaLista = {},
  porPagina: number = LEADS_POR_PAGINA,
) {
  const doFiltro = paramsDosFiltrosDaLista(filtros);
  return useQuery({
    queryKey: chaveDosLeadsPaginados(pipelineId, pagina, filtros),
    enabled: !!pipelineId,
    queryFn: async (): Promise<PaginaDeLeads> => {
      const res = await apiClient.get<RespostaDaRota>(
        `/api/v1/pipelines/${pipelineId}/leads?page=${pagina}&per_page=${porPagina}` +
          (doFiltro ? `&${doFiltro}` : ""),
      );
      const leads = res?.data ?? [];
      const meta = res?.meta ?? {};
      return {
        leads,
        page: meta.page ?? pagina,
        perPage: meta.per_page ?? porPagina,
        hasMore: meta.has_more ?? false,
      };
    },
  });
}
