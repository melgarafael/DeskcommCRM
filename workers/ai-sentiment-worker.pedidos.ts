/**
 * OS PEDIDOS DO CLIENTE, DO LADO DO WORKER DE CLIMA — a cola entre o Jev
 * (`lib/ai/decisao/pedidos.ts`) e o que só o worker lê: a REGRA DE HOJE e os
 * fatos do turno do agente.
 *
 * Mora fora de `lib/ai/decisao` porque a regra de hoje mora no agent-engine, e
 * o que o Jev executa não pode importar de lá. Mas é código que o Jev executa:
 * a cerca `tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts` varre este
 * arquivo inteiro — nenhuma escrita na mensagem, na conversa ou no contato, e
 * do agent-engine só os LEITORES nomeados lá (a detecção de pedido explícito,
 * as palavras de passagem, `isLeadInHandoff`). Quem lê não passa nem bloqueia.
 *
 * ═══ A REGRA DE HOJE, como o turno a aplica (`regraDeHoje`) ═══
 *
 * - pessoa: a detecção de pedido explícito, as palavras de passagem de QUALQUER
 *   agente que pode atender a conversa (`palavrasDeQuemPodeAtender`, normalizadas
 *   como o turno as lê), e o descadastro, pedido ou provável — no turno, o
 *   provável também cala o agente e passa a conversa a uma pessoa;
 * - parar de receber: `lib/opt-out/deteccao.ts`, pedido ou provável.
 *
 * ═══ ONDE O TURNO RODARIA ═══
 *
 * O portão do dreno (`haQuemAtendaASessao`, a mesma função que ele chama), a
 * elegibilidade desta conversa (lida por quem chama), o contato não bloqueado
 * e sem conversa nenhuma com uma pessoa (`isLeadInHandoff`, o no-op do turno),
 * e fora de grupo.
 *
 * Leitura que falha pesa para NÃO perguntar: sem saber se a regra pegou ou se o
 * turno rodaria, o Jev não opina. Nunca rejeita.
 */
import { matchesHandoffKeyword, palavrasDePassagem } from "@/lib/agent-engine/agent/agent-config";
import { detectHumanHandoffRequest, isLeadInHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { haQuemAtendaASessao, palavrasDeQuemPodeAtender } from "@/lib/ai/agents/quem-atende-a-sessao";
import type { ConfigDoJev } from "@/lib/ai/decisao/config";
import { observarPedidos, type PedidosObservados, type RegraPegou } from "@/lib/ai/decisao/pedidos";
import type { Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { ehOptOutProvavel, ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import type { createAdminClient } from "@/lib/supabase/admin";

/** O que a regra de hoje já pegou nesta mensagem, com as palavras de passagem de quem pode atender. */
export function regraDeHoje(mensagem: string, palavras: readonly string[]): RegraPegou {
  const descadastro = ehPedidoDeOptOut(mensagem) || ehOptOutProvavel(mensagem);
  return {
    humano: descadastro || detectHumanHandoffRequest(mensagem) || matchesHandoffKeyword(mensagem, palavras),
    opt_out: descadastro,
  };
}

export interface MensagemDoCliente {
  organizationId: string;
  messageId: string;
  conversationId: string | null;
  /** O número da conversa (`conversations.channel_session_id`). */
  sessaoId: string | null;
  contactId: string | null;
  grupo: boolean;
  /** A elegibilidade DESTA conversa (`permite`), que o worker já leu. */
  iaPodeResponder: boolean;
  /** O agente que o worker resolveu, para a linha de custo — não decide se o turno roda. */
  agentId: string | null;
  config: ConfigDoJev;
  mensagem: string;
  idioma: Idioma;
}

/**
 * Lê a regra e os fatos, e pergunta (`observarPedidos`). `null` quando nada
 * foi lido — fora do turno pelos fatos que o worker já tem, ou uma leitura que
 * falhou. O aviso é o passo seguinte, de quem chama (`avisarAEquipe`).
 */
export async function perguntarOsPedidosDoCliente(
  admin: ReturnType<typeof createAdminClient>,
  c: MensagemDoCliente,
): Promise<PedidosObservados | null> {
  try {
    if (c.conversationId === null || c.contactId === null || c.grupo || !c.iaPodeResponder) return null;
    const conversationId = c.conversationId;
    const contactId = c.contactId;
    const pool = getRequestPool();
    const [contato, comUmaPessoa, haQuem, palavras] = await Promise.all([
      admin
        .from("contacts")
        .select("is_blocked")
        .eq("organization_id", c.organizationId)
        .eq("id", contactId)
        .maybeSingle(),
      isLeadInHandoff(pool, c.organizationId, contactId),
      c.sessaoId === null ? null : haQuemAtendaASessao(pool, c.organizationId, c.sessaoId),
      palavrasDeQuemPodeAtender(pool, c.organizationId, c.sessaoId, conversationId).then(palavrasDePassagem),
    ]);
    return await observarPedidos(admin, {
      organizationId: c.organizationId,
      conversationId,
      messageId: c.messageId,
      contactId,
      agentId: c.agentId,
      mensagem: c.mensagem,
      idioma: c.idioma,
      config: c.config,
      regraPegou: regraDeHoje(c.mensagem, palavras),
      turno: {
        sessaoTemQuemAtenda: haQuem === true,
        iaPodeResponder: c.iaPodeResponder,
        contatoBloqueado: contato.error !== null || contato.data?.is_blocked !== false,
        contatoComUmaPessoa: comUmaPessoa,
        grupo: c.grupo,
      },
    });
  } catch (erro) {
    logger.warn("[ai-sentiment-worker] os pedidos do cliente não foram perguntados ao Jev", {
      organization_id: c.organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
    return null;
  }
}
