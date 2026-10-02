import type pg from 'pg';
import { costCents } from '@/lib/agent-engine/edge/llm/pricing';
import type { EscolhaDoJev } from '@/lib/ai/decisao/roteador';
import type { TurnAgentResolution } from './resolve-turn-agent';
import { logger } from '@/lib/logger';

/** Sem texto de cliente: a linha explica qual modo decidiu e quanto ele custou. */
export async function registrarDecisaoDoRoteador(db: pg.Pool, dados: {
  organizationId: string;
  routerId: string;
  conversationId: string;
  messageId: string | null;
  jobId: string;
  modo: 'tradicional_comparacao' | 'jev_comparacao' | 'jev_sob_demanda';
  contextMessageCount: number;
  origem: 'tradicional' | 'jev' | 'reserva';
  motivoReserva: 'falha_jev' | 'baixa_confianca' | 'sem_intencao' | 'intencao_invalida' | null;
  intentJev: string | null;
  intentTradicional: string | null;
  jev: EscolhaDoJev | null;
  jevSolicitado: boolean;
  chamouTradicional: boolean;
  resultado: TurnAgentResolution;
  tempoTotalMs: number;
}): Promise<void> {
  try {
    let custoTradicional: number | null = 0;
    if (dados.chamouTradicional) {
      const { rows } = await db.query<{ cost_cents: string | number | null }>(
        `select cost_cents from public.llm_calls
         where organization_id=$1 and job_id=$2 and purpose='intent_router' and provider<>'typesafe'
         order by created_at desc limit 1`,
        [dados.organizationId, dados.jobId],
      );
      custoTradicional = rows[0]?.cost_cents == null ? null : Number(rows[0].cost_cents);
    }
    const custoJev = !dados.jevSolicitado ? 0 : dados.jev === null ? null : costCents(dados.jev.modelo, {
      inputTokens: dados.jev.tokensDeEntrada,
      outputTokens: dados.jev.tokensDeSaida,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    await db.query(
      `insert into public.jev_router_decisions
       (organization_id,router_id,conversation_id,message_id,job_id,modo,context_message_count,
        origem,motivo_reserva,intent_jev,intent_tradicional,intent_final,agent_id_final,
        confianca_final,modelo_jev,custo_jev_cents,custo_tradicional_cents,custo_incompleto,tempo_total_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       on conflict (organization_id,router_id,message_id) where message_id is not null do nothing`,
      [dados.organizationId,dados.routerId,dados.conversationId,dados.messageId,dados.jobId,
        dados.modo,dados.contextMessageCount,dados.origem,dados.motivoReserva,dados.intentJev,
        dados.intentTradicional,dados.resultado.intentName,dados.resultado.config?.agentId ?? null,
        dados.resultado.confidence,dados.jev?.modelo ?? null,custoJev,custoTradicional,
        custoJev === null || custoTradicional === null,dados.tempoTotalMs],
    );
  } catch {
    // Telemetria não pode impedir uma pessoa de receber resposta.
    logger.warn('Não foi possível registrar a decisão do roteador', {
      organization_id: dados.organizationId, router_id: dados.routerId,
    });
  }
}
