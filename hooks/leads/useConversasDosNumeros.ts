"use client";
import { useInfiniteQuery } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { NumerosDoNegocio } from "@/app/api/v1/leads/[id]/conversas-e-ligacoes/route";

interface Resposta {
  data: NumerosDoNegocio;
  meta?: {
    limite: number;
    tem_mais: boolean;
    proximo_cursor: string | null;
  };
}

/**
 * A CHAVE da leitura agregada, exportada.
 *
 * Mesma razão do `chaveDosContatosRelacionados`: quem escreve (ligar um número
 * ao negócio, mandar mensagem) precisa invalidar a MESMA chave que a tela lê.
 * Com a chave escrita duas vezes, um prefixo a mais em uma das pontas deixa a
 * lista velha na tela sem erro nenhum.
 */
export function chaveDasConversasDosNumeros(leadId: string | null) {
  return ["conversas-dos-numeros", leadId] as const;
}

/**
 * As conversas e as ligações de TODOS os números do negócio (#3669, fatia 1),
 * numa LINHA DO TEMPO paginada por cursor.
 *
 * A primeira página é a mesma chamada de antes; "carregar mais" pede
 * `?cursor=<proximo_cursor>`, e o cursor é de chave — a página seguinte não
 * repete item nem pula quando chega mensagem nova no meio da rolagem.
 *
 * Sem `leadId` não há rota a consultar — o `enabled` segura a chamada, e quem
 * monta o componente sem âncora não faz rede (a régua de
 * `useContatosRelacionados`).
 */
export function useConversasDosNumeros(leadId: string | null) {
  const consulta = useInfiniteQuery({
    queryKey: chaveDasConversasDosNumeros(leadId),
    enabled: !!leadId,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const qs = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : "";
      try {
        return await apiClient.get<Resposta>(`/api/v1/leads/${leadId}/conversas-e-ligacoes${qs}`);
      } catch (err) {
        showApiError(err);
        throw err;
      }
    },
    getNextPageParam: (ultima) => ultima.meta?.proximo_cursor ?? undefined,
  });

  const paginas = consulta.data?.pages ?? [];
  const primeira = paginas[0];

  // Uma página só, no formato que a seção já consumia: as pessoas e as duas
  // listas vêm da primeira resposta; a linha do tempo é o fio de todas as
  // páginas, sem id repetido (defesa para resposta antiga em cache).
  const vistos = new Set<string>();
  const linha = paginas
    .flatMap((pagina) => pagina.data.linha_do_tempo ?? [])
    .filter((item) => (vistos.has(item.id) ? false : vistos.add(item.id) && true));

  return {
    data: primeira
      ? {
          data: {
            numeros: primeira.data.numeros,
            conversas: primeira.data.conversas ?? [],
            ligacoes: primeira.data.ligacoes ?? [],
            linha_do_tempo: linha,
          },
        }
      : undefined,
    isLoading: consulta.isLoading,
    isError: consulta.isError,
    temMais: consulta.hasNextPage,
    carregandoMais: consulta.isFetchingNextPage,
    carregarMais: () => {
      void consulta.fetchNextPage();
    },
  };
}
