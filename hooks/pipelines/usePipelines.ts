"use client";
import { useEffect, useState } from "react";
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
  /**
   * SÓ `false` — tirar o funil do arquivo (#979), e só sozinho no pedido. A rota
   * recusa `true` (arquivar é do DELETE, que confere as dependências antes) e
   * recusa com 409 o pedido que mistura desarquivar com outra mudança.
   */
  is_archived?: false;
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

/**
 * `arquivados` vem SEPARADO dos vivos, e quem consome precisa manter assim: é
 * `pipelines` que alimenta os seletores de funil do produto, e funil arquivado
 * ali seria destino que não existe mais.
 */
type Resposta = { data: { pipelines: FunilDaResposta[]; arquivados: FunilDaResposta[] } };

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

/** O que amarra o funil ao resto do sistema, como a rota de arquivar conta. */
export interface VinculosDoFunil {
  negocios: number;
  /** Os em andamento — os únicos que a transferência leva (doc 400, opção B). */
  abertos: number;
  fontes_de_webhook: number;
  automacoes: number;
}

/**
 * QUANTOS negócios estão vinculados ao funil (#4802, item 3).
 *
 * ⚠️ É A CONTAGEM DO SERVIDOR, e não uma conta feita na tela: sai da rota que usa
 * a MESMA leitura do `DELETE` (recusa do arquivamento e contagem da confirmação
 * não podem discordar). Enquanto ela não chega, `negocios` é `null` — a tela não
 * afirma "0" antes de saber, porque uma decisão sobre o número errado é pior que
 * uma frase de espera.
 *
 * `useEffect` e não `useQuery`: um número por funil aberto, com `ativo` mandando
 * buscar só quando o painel abre. Sem cache para invalidar, e o painel é efêmero.
 */
export function useNegociosDoFunil(funilId: string, ativo: boolean, rodada = 0) {
  const [estado, setEstado] = useState<{
    negocios: number | null;
    abertos: number | null;
    carregando: boolean;
    erro: string | null;
  }>({ negocios: null, abertos: null, carregando: ativo, erro: null });

  useEffect(() => {
    if (!ativo) return;
    let vivo = true;
    setEstado({ negocios: null, abertos: null, carregando: true, erro: null });
    apiClient
      .get<{ data: VinculosDoFunil }>(`${doFunil(funilId)}/negocios`)
      .then((r) => {
        if (vivo) {
          setEstado({ negocios: r.data.negocios, abertos: r.data.abertos, carregando: false, erro: null });
        }
      })
      .catch((e: unknown) => {
        if (vivo) {
          setEstado({
            negocios: null,
            abertos: null,
            carregando: false,
            erro: e instanceof Error ? e.message : "erro",
          });
        }
      });
    return () => {
      vivo = false;
    };
  }, [funilId, ativo, rodada]);

  return estado;
}

/** Uma etapa do funil, como o seletor de destino precisa dela. */
export interface EtapaParaDestino {
  id: string;
  name: string;
  is_won: boolean;
  is_lost: boolean;
}

/**
 * As etapas vivas de um funil (#4802, item 3) — o seletor de "etapa específica"
 * do destino.
 *
 * `funilId` nulo = nada a buscar (o seletor não está aberto). A lista vem da rota
 * que já serve a tela de etapas, e não de uma consulta nova: duas réguas para
 * "quais etapas este funil tem" divergiriam no primeiro arquivamento.
 */
export function useEtapasDoFunil(funilId: string | null) {
  const [estado, setEstado] = useState<{
    etapas: EtapaParaDestino[];
    carregando: boolean;
  }>({ etapas: [], carregando: false });

  useEffect(() => {
    if (!funilId) {
      setEstado({ etapas: [], carregando: false });
      return;
    }
    let vivo = true;
    setEstado({ etapas: [], carregando: true });
    apiClient
      .get<{ data: EtapaParaDestino[] }>(`${doFunil(funilId)}/stages`)
      .then((r) => {
        if (vivo) setEstado({ etapas: r.data ?? [], carregando: false });
      })
      .catch(() => {
        // Sem lista, o seletor fica vazio e o botão não habilita — a tela não
        // inventa etapa nenhuma para "resolver" a falha.
        if (vivo) setEstado({ etapas: [], carregando: false });
      });
    return () => {
      vivo = false;
    };
  }, [funilId]);

  return estado;
}

/** O pedido de transferência/remoção — o corpo que a rota aceita. */
export type EscolhaSobreOsNegocios =
  | { escolha: "transferir"; funil_id: string; etapa_id?: string | null }
  | { escolha: "remover" };

export interface RespostaDaEscolha {
  escolha: "transferir" | "remover";
  movidos: number;
  restantes: number;
  mensagem: string | null;
}

/**
 * Executa a escolha sobre os negócios do funil (#4802, item 3).
 *
 * ⚠️ NÃO arquiva e não exclui — quem faz isso é o `DELETE` de sempre, DEPOIS
 * desta escrita. Misturar as duas coisas aqui daria duas operações destrutivas
 * numa chamada só, e a tela precisa poder dizer quantos negócios saíram antes de
 * o funil sumir da lista.
 */
export function useMoverNegociosDoFunil() {
  return useMutation({
    mutationFn: ({ id, corpo }: { id: string; corpo: EscolhaSobreOsNegocios }) =>
      apiClient.post<{ data: RespostaDaEscolha }>(`${doFunil(id)}/negocios`, corpo),
  });
}
