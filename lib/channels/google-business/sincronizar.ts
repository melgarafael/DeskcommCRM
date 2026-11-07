/**
 * Sincronização das avaliações do Google — o orquestrador da fatia 1 (LEITURA).
 *
 * ─── A ordem das guardas é a regra ─────────────────────────────────────────
 *
 * 1. O CANAL, e antes de tudo: existe, é desta organização, não está arquivado
 *    (`lerCanalDaAvaliacao`). Um id de canal de outra organização morre aqui —
 *    nenhuma chamada ao Google e nenhuma escrita saem por causa dele.
 * 2. A CREDENCIAL, antes do provedor: sem o par OAuth do projeto Google da
 *    instalação o resultado é `sem_credencial` com os nomes que faltam, NUNCA
 *    uma exceção. É o critério "a tela explica o que falta em vez de quebrar".
 * 3. O ESCOPO do canal (conta e local): sem ele não há o que pedir, e inventar
 *    um escopo padrão leria avaliação de outro negócio.
 * 4. O PROVEDOR, e o erro dele é traduzido: token recusado vira
 *    `credencial_recusada` com o motivo, e a tela mostra isso em vez de 500.
 *
 * ─── O que esta fatia NÃO faz ──────────────────────────────────────────────
 *
 * Não responde avaliação (fatia 2), não apaga resposta, não cria aviso de nota
 * baixa (fatia 3) e não guarda histórico além do que a Central já guarda. A
 * retenção própria que a política do Google pede (30 dias) é decisão de
 * produto ainda aberta na issue — está declarada no PR.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  lerAvaliacoes,
  oQueFaltaParaLerAvaliacoes,
  type AmbienteDasAvaliacoes,
} from "./avaliacoes";
import { ErroDaLeituraDeAvaliacoes, listarAvaliacoesDoEscopo } from "./cliente";
import { ingerirAvaliacoes, lerCanalDaAvaliacao } from "./ingest";

export type ResultadoDaSincronizacao =
  | { status: "sem_credencial"; faltando: string[]; explicacao: string }
  | { status: "canal_ausente" }
  | { status: "canal_sem_escopo"; explicacao: string }
  | { status: "credencial_recusada"; motivo: string; codigo: number | null }
  | {
      status: "sincronizado";
      total: number;
      novas: number;
      repetidas: number;
      deOutroEscopo: number;
      invalidas: number;
    };

export interface PedidoDeSincronizacao {
  organizationId: string;
  channelSessionId: string;
  /** O ambiente da instalação; injetado para a prova não depender de `process.env`. */
  ambiente: AmbienteDasAvaliacoes;
  /** Token do projeto Google da organização (obtido pela conexão — fatia 2). */
  token?: string | null;
  buscar?: typeof fetch;
  base?: string;
}

export async function sincronizarAvaliacoes(
  db: SupabaseClient,
  pedido: PedidoDeSincronizacao,
): Promise<ResultadoDaSincronizacao> {
  const canal = await lerCanalDaAvaliacao(db, pedido.organizationId, pedido.channelSessionId);
  if (!canal) return { status: "canal_ausente" };

  const preparo = oQueFaltaParaLerAvaliacoes(pedido.ambiente);
  if (!preparo.pronta) {
    return {
      status: "sem_credencial",
      faltando: preparo.faltando,
      explicacao: preparo.explicacao ?? "",
    };
  }

  if (!canal.escopo) {
    return {
      status: "canal_sem_escopo",
      explicacao:
        "O canal do Google Business não tem conta e local gravados: reconecte o canal para " +
        "que as avaliações possam ser lidas.",
    };
  }

  let itens: unknown[];
  try {
    itens = await listarAvaliacoesDoEscopo({
      escopo: canal.escopo,
      token: pedido.token ?? "",
      buscar: pedido.buscar,
      base: pedido.base,
    });
  } catch (erro) {
    if (erro instanceof ErroDaLeituraDeAvaliacoes) {
      return { status: "credencial_recusada", motivo: erro.message, codigo: erro.status };
    }
    throw erro;
  }

  const leitura = lerAvaliacoes(itens, canal.escopo);
  const entrada = await ingerirAvaliacoes(db, {
    organizationId: pedido.organizationId,
    channelSessionId: canal.id,
    avaliacoes: leitura.avaliacoes,
  });

  return {
    status: "sincronizado",
    total: leitura.avaliacoes.length,
    novas: entrada.novas,
    repetidas: entrada.repetidas,
    deOutroEscopo: leitura.deOutroEscopo,
    invalidas: leitura.invalidas,
  };
}
