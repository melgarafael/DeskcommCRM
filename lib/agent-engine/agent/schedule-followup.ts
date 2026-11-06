/**
 * Tool schedule_followup (F3-02) — o agente agenda o PRÓPRIO retorno ao lead: o
 * motor da continuidade (dor nº 4 do dono). Valida o que o modelo prometeu e cria
 * um cron_job one-shot (kind 'at') em promised_at. No disparo o cron enfileira um
 * followup_turn na fila do lead (lane por lead, F2-03) e se desabilita — one-shot.
 * A re-entrada temporal plena ("passaram N dias, você prometeu X") é a F3-03; aqui
 * a tool só CRIA o agendamento com o snapshot.
 *
 * Disciplina espelhada da update_lead_state (F2-10): whitelist .strict() + guard de
 * prototype pollution ANTES do parse (Zod v4 dropa __proto__ em silêncio — F2-12);
 * campo extra/forjado vira ENSINO pt-br ao modelo, nunca strip silencioso. tenant e
 * lead vêm SEMPRE do runtime (row do job), jamais do payload do modelo. Data no
 * passado / fora da janela aceitável (knobs) → ensino, sem agendar nada.
 *
 * ⚠️ A REGRA NÃO MORA MAIS AQUI (IA 360 · wave 2). Janela, guard anti-empilhamento
 * e formato do payload vivem em `lib/followup/retorno.ts`, compartilhados com a
 * capacidade configurável na tela e com a rota do humano. O que sobrou neste
 * arquivo é o que é só do modelo: a whitelist do payload e o ENSINO em português —
 * texto que existe para o LLM se corrigir, e que não faz sentido numa rota REST.
 */
import { z } from 'zod';
import type pg from 'pg';

import { duracaoLegivel, agendaRetorno } from '@/lib/followup/retorno';
import { criaRetornoDbPg } from '@/lib/followup/retorno-pg';
import { emitAgentActivityForContact } from '@/lib/leads/agent-activity';

import { findForbiddenKey, zodIssuesSummary } from './lead-state';

/** Janela aceitável do retorno agendado pelo agente — knobs (env.ts), nunca constantes. */
export interface FollowupWindowKnobs {
  /** antecedência mínima: promised_at antes disso é "muito cedo" (FOLLOWUP_MIN_AHEAD_MS). */
  minAheadMs: number;
  /** horizonte máximo: promised_at além disso é "muito distante" (FOLLOWUP_MAX_AHEAD_MS). */
  maxAheadMs: number;
  /** janela do stagger determinístico herdada do cron (CRON_STAGGER_WINDOW_MS). */
  staggerWindowMs: number;
}

/** Whitelist EXATA do que o modelo promete — .strict() rejeita o resto (mesmo padrão da F2-10). */
export const scheduleFollowupInputSchema = z.strictObject({
  reason: z.string().min(1).max(500),
  promised_at: z.string().min(1).max(64),
  promise: z.string().min(1).max(1_000),
  context_snapshot: z.string().max(4_000).nullable().optional(),
  // Só a variante de quem tinha `crm_schedule_followup` o mostra ao modelo
  // (`SCHEDULE_FOLLOWUP_COM_NEGOCIO`). Ele não escolhe o ALVO do retorno — esse é o
  // contato do runtime —, só em qual negócio dele a linha da timeline cai.
  lead_id: z.string().max(64).nullable().optional(),
});
export type ScheduleFollowupInput = z.infer<typeof scheduleFollowupInputSchema>;

export type ScheduleFollowupResult =
  | { ok: true; cronJobId: string; promisedAt: Date; message: string }
  | {
      ok: false;
      error: {
        code: 'invalid_payload' | 'promised_at_in_past' | 'promised_at_out_of_window' | 'already_pending';
        message: string;
      };
    };

const PAYLOAD_TEACHING =
  'Campos aceitos: reason (por que agendar), promised_at (data ISO 8601 do retorno, no futuro), ' +
  'promise (o que você prometeu ao lead), context_snapshot (contexto curto para o run futuro), ' +
  'lead_id (opcional: o negócio deste cliente a que o retorno pertence) — nada além. ' +
  'Cliente e organização vêm do runtime; lead_id só escolhe ENTRE os negócios deste cliente.';

function teachInvalidPayload(issues: string): ScheduleFollowupResult {
  return {
    ok: false,
    error: { code: 'invalid_payload', message: `payload inválido em schedule_followup (${issues}). ${PAYLOAD_TEACHING}` },
  };
}

/**
 * Valida o payload prometido e cria o cron_job one-shot. Idempotência/exactly-once do
 * DISPARO é da F3-01 (scheduleCronJob + tickCron); aqui a garantia é só de validação
 * na CRIAÇÃO. Erros de DB (ex.: lead sumiu) sobem — o tool wrapper do run os captura
 * e ensina o modelo a encerrar (padrão F2-09).
 */
export async function applyScheduleFollowup(
  db: pg.Pool,
  cfg: { clock: () => Date; knobs: FollowupWindowKnobs },
  ids: {
    tenantId: string;
    leadId: string;
    agentId?: string | null;
    /** Funis do agente: o `lead_id` escolhido só vale dentro deles. */
    pipelineIds?: readonly string[] | null;
  },
  rawInput: unknown,
): Promise<ScheduleFollowupResult> {
  const forbidden = findForbiddenKey(rawInput);
  if (forbidden !== null) {
    return teachInvalidPayload(`campos não reconhecidos: ${forbidden}`);
  }
  const parsed = scheduleFollowupInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return teachInvalidPayload(zodIssuesSummary(parsed.error));
  }
  const input = parsed.data;

  // Um relógio só para decidir E para ensinar — ver o ⚠️ das mensagens abaixo.
  const agora = cfg.clock();
  const resultado = await agendaRetorno(
    criaRetornoDbPg(db),
    { agora, janela: cfg.knobs },
    // No harness, "lead" É o contato (inbound-turn: leadId = job.contact_id) — é
    // exatamente o que `cron_jobs.contact_id` guarda.
    { orgId: ids.tenantId, contactId: ids.leadId },
    {
      motivo: input.reason,
      prometidoPara: input.promised_at,
      promessa: input.promise,
      contexto: input.context_snapshot ?? null,
    },
  );

  if (!resultado.ok) {
    // ⚠️ A RECUSA DIZ QUE HORAS SÃO. O modelo não sabe que dia é hoje — medido
    // num turno real: pedido "daqui a três dias", ele mandou a data do próprio
    // treino. Dizer só "já passou" é verdade e é inútil: ele repete a mesma data
    // e queima os passos do turno. Quem recusa devolve o que falta para corrigir.
    const agoraIso = agora.toISOString();
    switch (resultado.codigo) {
      case 'instante_invalido':
        return teachInvalidPayload(
          `promised_at não é uma data ISO 8601 válida. AGORA é ${agoraIso} — some o prazo pedido a este instante e mande o resultado absoluto`,
        );
      case 'instante_no_passado':
        return {
          ok: false,
          error: {
            code: 'promised_at_in_past',
            message:
              `a data prometida (promised_at) já passou: AGORA é ${agoraIso}. Some o prazo ` +
              `combinado a este instante e mande a data absoluta resultante — não repita a mesma data.`,
          },
        };
      case 'instante_fora_da_janela': {
        const cedoDemais = new Date(agora.getTime() + resultado.janela.minAheadMs).toISOString();
        const tardeDemais = new Date(agora.getTime() + resultado.janela.maxAheadMs).toISOString();
        return {
          ok: false,
          error: {
            code: 'promised_at_out_of_window',
            message:
              `horário fora da janela aceitável de follow-up. AGORA é ${agoraIso}; o retorno tem de ` +
              `cair entre ${cedoDemais} e ${tardeDemais} ` +
              `(${duracaoLegivel(resultado.janela.minAheadMs)} a ${duracaoLegivel(resultado.janela.maxAheadMs)} a partir de agora).`,
          },
        };
      }
      case 'ja_existe_retorno': {
        // Guard anti-empilhamento (1 follow-up VIVO por lead): sem isto, o agente
        // marca um "reconfirmar amanhã" a cada turno e o lead vira alvo de N
        // sequências paralelas com data relativa congelada — o bug de spam de
        // produção. Um follow-up pendente já cobre o retorno; o modelo é ENSINADO
        // a não duplicar (não é erro fatal, é continue-sem-agendar).
        const quando = resultado.existente?.prometidoPara ?? null;
        return {
          ok: false,
          error: {
            code: 'already_pending',
            message:
              `este lead JÁ tem um follow-up agendado${quando ? ` para ${quando}` : ''} — ` +
              `não agende outro (evita bombardear o lead com confirmações repetidas). ` +
              `Se precisa mudar o horário, encerre o turno; o follow-up existente vai disparar no horário combinado. ` +
              `Use SEMPRE data ABSOLUTA (ex.: "2026-07-25T13:00:00Z"), nunca relativa como "amanhã" — ` +
              `a promessa é lida dias depois e "amanhã" fica sem sentido.`,
          },
        };
      }
    }
  }

  // O RETORNO ENTRA NA TIMELINE DO NEGÓCIO. Antes desta wave, o agendamento feito
  // pelo motor só existia em `cron_jobs`: o humano via o card do negócio parar de
  // esfriar (o radar o classifica "em voo") e não tinha onde ler POR QUÊ. Falha
  // baixo e roteamento sem adivinhação são de `emitAgentActivityForContact` — não
  // se inventa emissor novo aqui.
  await emitAgentActivityForContact({
    pool: db,
    organizationId: ids.tenantId,
    contactId: ids.leadId,
    type: 'followup_scheduled',
    reason: `Retorno agendado — ${input.reason}`,
    sourceModule: 'followup',
    sourceId: null,
    agentId: ids.agentId ?? null,
    negocioEscolhido: input.lead_id ?? null,
    escopoDoNegocioEscolhido: ids.pipelineIds ?? null,
    payload: {
      retorno_id: resultado.retorno.id,
      quando: resultado.retorno.quando,
      prometido_para: resultado.retorno.prometidoPara,
    },
  });

  return {
    ok: true,
    cronJobId: resultado.retorno.id,
    promisedAt: new Date(resultado.retorno.quando),
    message:
      `retorno agendado para ${input.promised_at}. Encerre o turno agora; ` +
      `o sistema fará o follow-up com o lead no horário combinado.`,
  };
}
