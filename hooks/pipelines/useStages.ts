"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

import { chaveDoQuadro } from "@/hooks/kanban/useBoard";

import { chaveDoFunil, type EstadoDoMapeamento, type EtapaDoFunil } from "./useAgentMapping";

/**
 * Criar, editar e arquivar etapa do funil — a escrita da tela de etapas.
 *
 * ⚠️ NÃO HÁ QUERY AQUI, E É DELIBERADO. A leitura é a MESMA de
 * `useAgentMapping`: o GET de `agent-mapping` já devolve as etapas ativas na
 * ordem do funil COM o passo do assistente de cada uma (`agent_stage_hint`
 * invertido em `mapeamento`), que é justamente o que esta tela precisa para
 * explicar por que uma marcação não sai. O corpo das rotas de etapa devolve o
 * funil sem o passo do assistente — montar a lista com ele daria duas réguas
 * para o mesmo quadro, e a segunda não saberia dizer que «Pago» representa
 * «Ganho». Uma leitura só, uma chave de cache só.
 *
 * ⚠️ DEPOIS DE QUALQUER RESPOSTA — sucesso OU erro —, RELÊ. Não há concorrência
 * otimista nestas rotas: duas abas editando o mesmo funil terminam em "o último
 * ganha", e o 409 diz literalmente "recarregue a página". Reaproveitar o corpo
 * da resposta como cache economizaria um GET e traria o problema de volta pela
 * porta dos fundos (o corpo não tem o passo do assistente); reler é o preço
 * honesto numa tela de configuração ocasional.
 */

const rota = (pipelineId: string) =>
  `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/stages`;

const daEtapa = (pipelineId: string, stageId: string) =>
  `${rota(pipelineId)}/${encodeURIComponent(stageId)}`;

/** O que o PATCH aceita. `depois_de` é o vizinho da ESQUERDA (`null` = primeira coluna). */
export interface PatchDeEtapa {
  name?: string;
  is_won?: boolean;
  is_lost?: boolean;
  depois_de?: string | null;
  /**
   * Probabilidade de ganho da etapa, 0–100. `null` limpa a calibração — e a
   * previsão volta a reportar a etapa no balde "sem probabilidade".
   */
  win_probability?: number | null;
  /** Negócio que entra nesta etapa abre um aviso na Central (migration 0440). */
  avisar_na_central?: boolean;
  /**
   * Janela de "esfriando" da etapa, em HORAS (issue #1532). `null` limpa a
   * configuração e a etapa volta ao padrão de 24 h/72 h. Fora de 1 a 8760
   * inteiro a rota responde 422 — a coluna é `numeric` sem CHECK.
   */
  expected_duration_hours?: number | null;
  /**
   * A cor da etapa, `#rrggbb` (`crm_stages.color`). `null` volta ao padrão de
   * hoje. Item 2 da #4802.
   */
  color?: string | null;
  /**
   * O critério da etapa (#4836): quando um negócio entra nela, em texto livre.
   * `null` limpa (e texto vazio também vira `null` no servidor). Acima de 500
   * caracteres, depois do `trim`, a rota responde 422 — a MESMA constante que a
   * tela usa para limitar o campo.
   */
  description?: string | null;
}

/**
 * A lista com a etapa `etapaId` logo depois de `depoisDe` (`null` = primeira) — a
 * ordem que o PATCH de `depois_de` vai gravar, desenhada antes de ele voltar.
 *
 * Vizinha que não está na lista devolve a MESMA lista: a API recusa esse pedido
 * com 422 ("não está mais no funil"), e inventar um lugar aqui mostraria uma
 * ordem que o servidor nunca gravou.
 */
export function etapasComAMovida(
  etapas: EtapaDoFunil[],
  etapaId: string,
  depoisDe: string | null,
): EtapaDoFunil[] {
  const movida = etapas.find((e) => e.id === etapaId);
  if (!movida || depoisDe === etapaId) return etapas;
  const resto = etapas.filter((e) => e.id !== etapaId);
  const i = depoisDe === null ? -1 : resto.findIndex((e) => e.id === depoisDe);
  if (depoisDe !== null && i < 0) return etapas;
  return [...resto.slice(0, i + 1), movida, ...resto.slice(i + 1)];
}

function useReler(pipelineId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: chaveDoFunil(pipelineId) });
    /**
     * ⚠️ E O QUADRO TAMBÉM (#3874). Renomear, reordenar ou desativar etapa aqui
     * é uma escrita em `crm_stages` — a MESMA tabela que desenha o Kanban. Até
     * esta linha, o quadro só relia quando ele mesmo escrevia (`useRenameStage`,
     * do cabeçalho da coluna, invalida `chaveDoQuadro`); vindo de
     * Configurações, o cache ficava com a ordem e o nome antigos até um F5.
     * O sintoma era o pior tipo: a tela de etapas mostrava a coluna nova, o
     * quadro mostrava a velha, e ninguém sabia em qual acreditar.
     */
    void qc.invalidateQueries({ queryKey: chaveDoQuadro(pipelineId) });
  };
}

export function useCriarEtapa(pipelineId: string) {
  const reler = useReler(pipelineId);
  return useMutation({
    mutationFn: (name: string) => apiClient.post<unknown>(rota(pipelineId), { name }),
    onSettled: reler,
  });
}

export function useEditarEtapa(pipelineId: string) {
  const qc = useQueryClient();
  const reler = useReler(pipelineId);
  return useMutation({
    mutationFn: ({ stageId, patch }: { stageId: string; patch: PatchDeEtapa }) =>
      apiClient.patch<unknown>(daEtapa(pipelineId, stageId), patch),
    /**
     * ⚠️ REORDENAR MOSTRA A ORDEM NOVA NA HORA (#4802). Quem solta uma coluna
     * arrastada vê a linha voltar ao lugar antigo e só depois pular para o novo
     * se a lista esperar o PATCH e a releitura — parece que o arrasto falhou. A
     * ordem desenhada aqui é só a do pedido em voo: a releitura do `onSettled`
     * continua sendo a verdade, e a recusa devolve a lista de antes.
     */
    onMutate: async ({ stageId, patch }) => {
      if (patch.depois_de === undefined) return { anterior: undefined };
      const chave = chaveDoFunil(pipelineId);
      await qc.cancelQueries({ queryKey: chave });
      const anterior = qc.getQueryData<EstadoDoMapeamento>(chave);
      if (anterior) {
        qc.setQueryData<EstadoDoMapeamento>(chave, {
          ...anterior,
          etapas: etapasComAMovida(anterior.etapas, stageId, patch.depois_de),
        });
      }
      return { anterior };
    },
    onError: (_erro, _pedido, contexto) => {
      if (contexto?.anterior) qc.setQueryData(chaveDoFunil(pipelineId), contexto.anterior);
    },
    onSettled: reler,
  });
}

export function useArquivarEtapa(pipelineId: string) {
  const reler = useReler(pipelineId);
  return useMutation({
    // Sem destino é uma pergunta legítima, não um pedido pela metade: a rota
    // responde 422 com a CONTAGEM de negócios da etapa, que é o número que a
    // tela precisa para perguntar "para onde eles vão?". Etapa vazia arquiva
    // direto — não há nada para onde mandar.
    mutationFn: ({ stageId, destinoId }: { stageId: string; destinoId: string | null }) =>
      apiClient.delete<unknown>(
        destinoId
          ? `${daEtapa(pipelineId, stageId)}?destino=${encodeURIComponent(destinoId)}`
          : daEtapa(pipelineId, stageId),
      ),
    onSettled: reler,
  });
}
