import type { PacoteFactual } from './contrato-contexto';
import type pg from "pg";
import { divergenciaExplicitaDoPedido, type PropostaDeAgenda } from "@/lib/agenda/pedido";
import { carregarContextoDoAtendimento } from "../../agent/contexto-do-atendimento";
import { carregarContextoDeDecisaoHumana } from "../../agent/contexto-de-decisao-humana";
import { guardServiceEffect } from "@/lib/atendimento/fronteira-server";
import type { LlmEdgeConfig } from "../../edge/llm/run-model-call";
import type { ProviderRegistry } from "../../edge/llm/providers";
import type { Logger } from "../../obs/logger";
import { montarContextoDaRevisao } from "./contexto-da-revisao";
import { classifyPromise } from "./semantic";
import { mensagemDoAtendimentoSql } from "@/lib/atendimento/historico-mensagens";

interface Entrada {
  pool: pg.Pool;
  cfg: LlmEdgeConfig;
  tenantId: string;
  leadId: string;
  conversationId: string;
  jobId: string;
  /** Operador lê a mensagem canônica do job que o originou, nunca sua própria declaração. */
  requestJobId?: string;
  casesEnabled?: boolean;
  registry?: ProviderRegistry;
  log: Logger;
  contextoDoTurno?: () => Pick<PacoteFactual, 'agentContext' | 'agendaAvailability' | 'conversationContext'>;
}

/** Uma conferência por proposta/fotografia, fora de transação; falha nunca vira autorização. */
export function criarRevisorDePedidoDeAgenda(e: Entrada): (op: PropostaDeAgenda) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  const ler = () => carregarContextoDoAtendimento(e.pool, {
    tenantId: e.tenantId, leadId: e.leadId, conversationId: e.conversationId,
    jobId: e.requestJobId ?? e.jobId,
  });
  return async op => {
    await guardServiceEffect();
    if (op.acao === "remarcar" && !op.reserva_atual) return false;
    const contexto = await ler();
    if (contexto.pedido?.estado !== "present" || !contexto.pedido.mensagem) return false;
    const divergencia = contexto.pedido.tipoTurno === "inbound_turn" &&
      contexto.pedido.mensagem.origem === "client_message"
      ? divergenciaExplicitaDoPedido(contexto.pedido.mensagem.text, op) : null;
    if (divergencia) {
      e.log.info("proposta de agenda diverge da escolha explícita", { event:"agenda_request_review",resultado:"explicit_mismatch",campo:divergencia });
      return false;
    }
    const lerHumano = () => e.casesEnabled || contexto.pedido?.tipoTurno === "case_reply_turn"
      ? carregarContextoDeDecisaoHumana(e.pool, { tenantId:e.tenantId,leadId:e.leadId,conversationId:e.conversationId },
          { canonicalRequest:contexto.pedido?.mensagem ?? null })
      : Promise.resolve(undefined);
    const humano = await lerHumano();
    const { rows } = await e.pool.query<{
      direction: string; body: string; sent_at: string; status: string; author: string;
    }>(`select m.direction,coalesce(m.media_derived_text,m.body,'') body,m.sent_at::text sent_at,m.status,
         case when m.direction='inbound' then 'client' when m.sent_by_user_id is not null then 'human_authenticated'
           when m.sent_via='ai' then 'agent' when m.sent_via='system' then 'system' else 'unknown_outbound' end author
       from messages m join conversations c on c.id=m.conversation_id and c.organization_id=m.organization_id
       where m.organization_id=$1 and m.contact_id=$2 and m.conversation_id=$3
         and ${mensagemDoAtendimentoSql("m")}
       order by m.sent_at desc,m.id desc limit 21`, [e.tenantId,e.leadId,e.conversationId]);
    const conversa = montarContextoDaRevisao(rows.slice(0,20).reverse(), null,
      new Date().toISOString(), op.fuso);
    if (rows.length > 20) conversa.limitado = true;
    // Sem resumo/autoridade do Conversador. Só a fonte canônica do job autoriza a proposta.
    const compartilhado = e.contextoDoTurno?.();
    const chave = JSON.stringify([op, contexto.fingerprint, humano?.fingerprint, conversa.mensagens, compartilhado]);
    let pedida = cache.get(chave);
    if (!pedida) {
      pedida = classifyPromise(e.pool, e.cfg, { tenantId:e.tenantId,leadId:e.leadId,jobId:e.jobId }, {
        ...compartilhado,
        candidate: "", agendaReviewRequired: true, agendaOperation: op,
        serviceContext: contexto, conversationContext: compartilhado?.conversationContext ?? conversa,
        ...(humano ? { humanDecisionContext:humano } : {}),
      }, { log:e.log, ...(e.registry ? { registry:e.registry } : {}) })
        .then(v => v.agendaCompativel === true);
      cache.set(chave, pedida);
      pedida.catch(() => cache.delete(chave));
    }
    const compativel = await pedida;
    const atual = await ler();
    const humanoAtual = await lerHumano();
    await guardServiceEffect();
    const contextoAtual = atual.fingerprint === contexto.fingerprint;
    const decisaoAtual = humanoAtual?.fingerprint === humano?.fingerprint;
    const leiturasAtuais = JSON.stringify(e.contextoDoTurno?.()) === JSON.stringify(compartilhado);
    const valido = compativel && contextoAtual && decisaoAtual && leiturasAtuais;
    e.log.info("correspondência da agenda conferida antes da escrita", {
      event: "agenda_request_review", acao:op.acao, resultado:valido ? "compatible" : "divergent_or_unproven",
      sinal_positivo:compativel, contexto_atual:contextoAtual, decisao_atual:decisaoAtual,
    });
    return valido;
  };
}
