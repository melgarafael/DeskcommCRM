"use client";
import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { apiClient } from "@/lib/api/client";

/**
 * Criar, editar e arquivar FUNIL — a escrita da tela do Kanban.
 *
 * ⚠️ A TELA USA O CORPO DA RESPOSTA, NÃO O `router.refresh()`, E ISSO FOI MEDIDO.
 * As três rotas releem os funis do banco antes de responder, então o corpo JÁ é
 * "o que o banco tem". Depender do refresh para exibir o resultado da própria
 * ação é uma corrida: com os prefetches RSC da barra lateral em voo, o refresh
 * é atropelado e a tela fica no estado anterior. Observado em duas rodadas do
 * mesmo build — numa o rename apareceu em 0,6s, na outra não apareceu em 7s, com
 * `GET /app/kanban?_rsc=…` respondendo 200 e `no-store` nas duas. Aplicar o corpo
 * é determinístico por construção; não há janela em que a tela minta.
 *
 * ⚠️ O `router.refresh()` CONTINUA, e não é cinto e suspensório: ele mantém o
 * servidor coerente para a PRÓXIMA navegação (voltar ao Kanban depois de sair
 * dele). O que mudou é que a tela não depende mais dele para mostrar o que
 * acabou de acontecer.
 *
 * ⚠️ NÃO HÁ QUERY AQUI. A leitura inicial é do Server Component, porque
 * `GET /api/v1/pipelines` exige `manager` e a tela do Kanban é aberta a QUALQUER
 * papel: um `agent` relendo por ali levaria 403 e ficaria sem quadro.
 */

const ROTA = "/api/v1/pipelines";
const doFunil = (id: string) => `${ROTA}/${encodeURIComponent(id)}`;

/** O que o PATCH aceita. `depois_de` é o vizinho DE CIMA (`null` = primeiro da lista). */
export interface PatchDeFunil {
  name?: string;
  description?: string | null;
  is_default?: boolean;
  /** Onde nasce o lead de quem já é cliente. `false` desliga, e é aceito. */
  is_client_pipeline?: boolean;
  depois_de?: string | null;
}

/** O funil como as rotas o devolvem — a mesma forma que a página entrega por props. */
export interface FunilDaResposta {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  position: number;
  is_default: boolean;
  is_client_pipeline: boolean;
}

type Resposta = { data: { pipelines: FunilDaResposta[] } };

function useReler() {
  const router = useRouter();
  return () => router.refresh();
}

export function useCriarFunil() {
  const reler = useReler();
  return useMutation({
    mutationFn: (name: string) => apiClient.post<Resposta>(ROTA, { name }),
    onSettled: reler,
  });
}

export function useEditarFunil() {
  const reler = useReler();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PatchDeFunil }) =>
      apiClient.patch<Resposta>(doFunil(id), patch),
    onSettled: reler,
  });
}

export function useArquivarFunil() {
  const reler = useReler();
  return useMutation({
    // `definitivo` só é aceito pelo caso limpo (funil que nunca recebeu negócio,
    // sem formulário e sem automação apontando para ele); no resto a rota recusa
    // com a explicação, e a tela a mostra.
    mutationFn: ({ id, definitivo }: { id: string; definitivo?: boolean }) =>
      apiClient.delete<Resposta>(definitivo ? `${doFunil(id)}?definitivo=1` : doFunil(id)),
    onSettled: reler,
  });
}
