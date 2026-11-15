import { z } from "zod";
import type pg from "pg";

import {
  MAX_MENSAGENS_DA_ANALISE,
  SYSTEM_DA_ANALISE_DO_HISTORICO,
  montarTranscricaoDoHistorico,
  parseResultadoDaAnaliseDoHistorico,
  pedidoDaAnaliseDoHistorico,
  qualificationPreenchida,
  type MensagemDoHistoricoParaAnalise,
  type MotivoParaPularAnalise,
} from "@/lib/channels/historico/analise";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import { recalculaScoreDoLead } from "@/lib/leads/score-writer";

import { runModelCall } from "../edge/llm/run-model-call";
import { withFields } from "../obs/logger";
import type { JobRow, Queryable } from "../queue/queue";
import { insertCheckpoint } from "./abertura/checkpoint";
import type { InboundTurnDeps } from "./inbound-turn";
import { applyLeadStateUpdate } from "./lead-state";

export const historyAnalysisPayloadSchema = z.object({
  importacao_id: z.string().uuid(),
  conversation_id: z.string().uuid(),
}).passthrough();

/**
 * Pergunta à régua única do banco (`fn_historico_analise_motivo_para_pular`,
 * migration 9350) se este contato pode ser lido: quem recusou IA nunca é lido,
 * e quem já tem estado mais novo que o histórico nunca é sobrescrito.
 */
async function motivoParaPular(
  db: Queryable,
  organizationId: string,
  contactId: string,
  importacaoId: string,
): Promise<MotivoParaPularAnalise | null> {
  const { rows } = await db.query<{ motivo: MotivoParaPularAnalise | null }>(
    `select public.fn_historico_analise_motivo_para_pular($1, $2, $3) as motivo`,
    [organizationId, contactId, importacaoId],
  );
  return rows[0]?.motivo ?? null;
}

/**
 * Analisa o acervo sem qualquer capacidade de saída. Este módulo não importa
 * ChannelAdapter, before-send nem ferramenta MCP: a ausência é a barreira.
 */
export function createHistoryAnalysisHandler(deps: InboundTurnDeps) {
  return async function handleHistoryAnalysis(
    job: JobRow,
    pool: pg.Pool,
    _ctx: { workerId: string },
  ): Promise<void> {
    if (job.kind !== "history_analysis" || job.contact_id === null) {
      throw new Error("history_analysis_sem_contato");
    }
    const payload = historyAnalysisPayloadSchema.parse(job.payload);
    const log = withFields(deps.log, {
      job_id: job.id,
      tenant_id: job.organization_id,
      lead_id: job.contact_id,
      importacao_id: payload.importacao_id,
    });

    // Retry depois do COMMIT: o checkpoint é o recibo de que checkpoint,
    // qualificação e score foram gravados na mesma transação.
    const { rows: recibos } = await pool.query<{ id: string }>(
      `select id from lead_checkpoints
        where organization_id = $1 and contact_id = $2 and job_id = $3
        limit 1`,
      [job.organization_id, job.contact_id, job.id],
    );
    if (recibos.length > 0) return;

    // Antes de LER a conversa e de gastar a chamada de IA. O estado pode ter
    // mudado desde o enfileiramento (o contato pediu para sair, o agente ao vivo
    // escreveu algo mais novo): o job termina sem ler e sem gravar.
    const contactId = job.contact_id;
    const motivoAntes = await motivoParaPular(pool, job.organization_id, contactId, payload.importacao_id);
    if (motivoAntes !== null) {
      log.info("histórico não analisado — contato fora da análise", { motivo: motivoAntes });
      return;
    }

    const { rows } = await pool.query<MensagemDoHistoricoParaAnalise>(
      `select id, direction, sent_at::text, body
         from messages
        where organization_id = $1
          and contact_id = $2
          and metadata ->> 'importacao_id' = $3
          and type not in ('reaction', 'system')
          and nullif(btrim(coalesce(body, '')), '') is not null
        order by sent_at desc, id desc
        limit $4`,
      [job.organization_id, job.contact_id, payload.importacao_id, MAX_MENSAGENS_DA_ANALISE],
    );
    const fita = montarTranscricaoDoHistorico([...rows].reverse());
    if (fita.texto === "") {
      log.info("histórico sem texto analisável — job concluído sem alterar o CRM");
      return;
    }

    const chamada = await runModelCall(
      pool,
      deps.llmCfg,
      {
        tenantId: job.organization_id,
        leadId: job.contact_id,
        jobId: job.id,
        purpose: "checkpoint",
        system: SYSTEM_DA_ANALISE_DO_HISTORICO,
        messages: [{ role: "user", content: pedidoDaAnaliseDoHistorico(fita.texto, fita.truncada) }],
        maxOutputTokens: 3_000,
      },
      { registry: deps.registry, log },
    );
    const resultado = parseResultadoDaAnaliseDoHistorico(chamada.result.text, fita.ids);

    const client = await pool.connect();
    try {
      await client.query("begin");
      // De novo, dentro da transação que grava: a chamada de IA leva segundos, e
      // o agente ao vivo pode ter escrito qualificação mais nova nesse meio-tempo.
      const motivoNaEscrita = await motivoParaPular(client, job.organization_id, contactId, payload.importacao_id);
      if (motivoNaEscrita !== null) {
        await client.query("rollback");
        log.info("análise descartada — o contato mudou durante a chamada de IA", { motivo: motivoNaEscrita });
        return;
      }
      await insertCheckpoint(client, {
        tenantId: job.organization_id,
        leadId: job.contact_id,
        jobId: job.id,
        content: {
          commitments: resultado.commitments,
          objections: resultado.objections,
          next_action: resultado.next_action,
          rolling_summary: resultado.rolling_summary,
        },
      });

      const qualification = qualificationPreenchida(resultado.qualification);
      if (Object.keys(qualification).length > 0 || resultado.next_action !== null) {
        const atualizacao = await applyLeadStateUpdate(
          client,
          { tenantId: job.organization_id, leadId: job.contact_id, jobId: job.id },
          { qualification, next_action: resultado.next_action },
        );
        if (!atualizacao.ok) throw new Error(`analise_historico_lead_state:${atualizacao.error.code}`);
      }

      const { rows: leads } = await client.query<LeadCandidate>(
        `select id, organization_id, pipeline_id, status, last_activity_at, created_at
           from crm_leads
          where organization_id = $1 and contact_id = $2`,
        [job.organization_id, job.contact_id],
      );
      const alvo = resolveActiveLeadForContact(leads);
      if (alvo.routed) await recalculaScoreDoLead(client, job.organization_id, alvo.leadId);
      await client.query("commit");
      log.info("histórico analisado sem saída ao cliente", {
        mensagens: rows.length,
        truncada: fita.truncada,
        score_recalculado: alvo.routed,
      });
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  };
}
