"use client";

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import type { BoardData } from "@/lib/kanban/types";
import { motivoDeGanhoExigido, motivosDeGanhoDoFunil } from "@/lib/leads/motivo-do-ganho-do-funil";

/** O que a tela do ganho precisa saber do funil antes de perguntar qualquer coisa. */
export interface RegraDoMotivoDeGanho {
  /** A lista cadastrada; vazia é TEXTO LIVRE — o comportamento de sempre. */
  motivos: string[];
  /** `settings.won_reason_required`: só com ele a caixa não aceita ficar vazia. */
  exigido: boolean;
  /**
   * Vale a pena abrir a caixa? Sim quando o funil tem lista (a pessoa escolhe
   * da lista em vez de digitar às cegas) ou quando exige o motivo. Funil sem
   * lista e sem obrigatoriedade fecha em UM clique, como antes da #5181.
   */
  pergunta: boolean;
}

/**
 * A REGRA DO MOTIVO DE GANHO DESTE FUNIL, lida do cache do quadro.
 *
 * Mesma decisão de `useMotivosDePerdaDoFunil`: o quadro já carregou
 * `pipeline.settings` inteiro em `["board", pipelineId]`, e a caixa só existe a
 * partir de um card desse quadro — pedir de novo custaria rede e um estado de
 * carregamento para um dado que já está na mão. Cache frio (card isolado,
 * teste) devolve "não pergunta nada", que é o comportamento de antes da issue:
 * degrada para o antigo, nunca para um diálogo inventado.
 *
 * Nada aqui força a caixa: quem não tem lista nem obrigatoriedade continua
 * fechando em um clique, e quem quer a caixa liga a chave de verdade
 * (`won_reason_required`) ou cadastra a lista do funil.
 */
export function useRegraDoMotivoDeGanho(pipelineId: string): RegraDoMotivoDeGanho {
  const qc = useQueryClient();
  const settings = qc.getQueryData<BoardData>(chaveDoQuadro(pipelineId))?.pipeline?.settings ?? null;
  return useMemo(() => {
    const motivos = motivosDeGanhoDoFunil(settings);
    const exigido = motivoDeGanhoExigido(settings);
    return { motivos, exigido, pergunta: exigido || motivos.length > 0 };
  }, [settings]);
}
