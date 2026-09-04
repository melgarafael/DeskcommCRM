/**
 * Handler do job `followup_turn` (F3-03; blueprint 1.3) — a peça BUILD da
 * continuidade. A F3-01 (cron persistente) dispara e a F3-02 (tool schedule_followup)
 * agenda a promessa; aqui, NO DISPARO, o harness COMPUTA o delta temporal e injeta o
 * bloco de re-entrada ANTES do turno: "passaram N dias desde a última resposta, você
 * prometeu X, motivo Y, a última coisa que o lead disse foi Z". É a lacuna confirmada
 * em OpenClaw/Hermes que transforma continuação fria em retomada natural.
 *
 * Reusa runAgentTurn (F2-09) por inteiro — sessão fresca, loop de tools, checkpoint,
 * veto. A ÚNICA diferença é a abertura: o bloco temporal entra no SUFIXO (messages),
 * DEPOIS do prefixo cacheável (system do playbook + tools — F2-17), então não
 * invalida o cache org-wide. O delta é RELATIVO ao now do run (clock injetável),
 * nunca persistido estático.
 *
 * Ids de envio (conversa + número) vêm da ROW do lead no harness (fonte confiável),
 * NUNCA do payload do modelo — o cron só carrega o snapshot da promessa (F3-02).
 */
import { z } from 'zod';
import type pg from 'pg';

import { withFields } from '../obs/logger';
import type { JobRow } from '../queue/queue';
import { getLeadContext, type LeadContext } from '../edge/crm/get-lead-context';
import { WahaChannelAdapter } from '../edge/channel/waha-adapter';
import { applySendOutcome } from '../edge/crm/send-message';
import { runBeforeSend } from '../guardrails/before-send';
import { camadaLigada, lerCamadasDaOrg } from '../guardrails/camadas-da-org';
import { classifyPromise } from '../guardrails/promise/semantic';
import { scheduleCronJob } from '../cron/scheduler';
import {
  JobSettledError,
  ritualBlocks,
  runAgentTurn,
  type InboundTurnDeps,
  type LeadCheckpointRow,
} from './inbound-turn';
import { isLeadInHandoff } from './human-handoff';
import { fusoDaOrganizacao } from './fuso-da-org';
import type { LeadStateRow } from './lead-state';
import { loadReentryTemplate, pickReentryVariant } from './reentry-template';
import {
  classifyFollowupReply,
  planFollowupTiming,
  type EsperaParaPlanejar,
  type PropostaDeEsperaBruta,
} from './followup-flow-classify';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Payload que o cron enfileira no disparo (F3-02 grava reason/promise/promised_at/
 * context_snapshot). Tolerante: um follow-up de origem futura (re-entrada iniciada
 * pelo sistema, sem promessa registrada) enfileira sem esses campos e ainda roda —
 * acc3 (variante mínima, sem promessa inventada).
 */
export const followupTurnPayloadSchema = z
  .object({
    reason: z.string().optional(),
    promise: z.string().optional(),
    promised_at: z.string().optional(),
    context_snapshot: z.string().nullable().optional(),
    // F3-04: 'template' = re-entrada DETERMINÍSTICA — envia a variante versionada
    // direto pela cadeia de guardrails, sem LLM (custo $0, blueprint). Ausente/'agent'
    // = run normal do agente (comportamento F3-03 intocado).
    mode: z.enum(['agent', 'template']).optional(),
    // Onda 5 (Task 5.1): turno DIRIGIDO POR FLUXO (lib/followup/engine.ts enfileira
    // este payload, campo a campo IDÊNTICO ao FollowupJobRequest.payload de lá).
    // Presente ⇒ ramo guardado em runFlowDrivenTurn; ausente ⇒ comportamento LEGADO
    // (schedule_followup / F3-03 / F3-04) intocado — nem lido.
    followup_enrollment_id: z.string().uuid().optional(),
    node_id: z.string().min(1).optional(),
    purpose: z.enum(['send_message', 'classify', 'plan_timing']).optional(),
    prompt_hint: z.string().optional(),
    /** action mode `text` — enviado pela cadeia de guardrails, sem LLM. */
    fixed_body: z.string().min(1).max(4000).optional(),
    /** action mode `template` — corpo em `message_templates`. */
    template_id: z.string().uuid().optional(),
    volta_index: z.number().int().optional(),
    volta_total: z.number().int().optional(),
    classes: z.array(z.string()).optional(),
    hint: z.string().optional(),
    // purpose 'plan_timing': as esperas adaptativas do fluxo inteiro, na ordem.
    waits: z
      .array(
        z.object({
          node_id: z.string().min(1),
          label: z.string(),
          min_ms: z.number().int(),
          max_ms: z.number().int(),
          guidance: z.string().optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

/** Resultado de um turno dirigido por fluxo — espelha `TurnResult` de lib/followup/turn-bridge.ts
 *  (agent-engine não importa followup/* — regra dura de dependência numa direção só). */
export type FollowupFlowTurnResult =
  | { kind: 'sent' }
  | { kind: 'classified'; class: string }
  | { kind: 'planned'; propostas: PropostaDeEsperaBruta[]; modelo: string };

/**
 * `InboundTurnDeps` + o callback que fecha o turno dirigido por fluxo de volta
 * no enrollment. Ausente (deps antigo, sem o campo) ⇒ o ramo de fluxo lança um
 * erro claro em vez de silenciosamente não persistir nada — falha alto e cedo,
 * nunca um turno "concluído" que a ponte nunca soube que aconteceu.
 */
export interface FollowupTurnDeps extends InboundTurnDeps {
  completeFollowupTurn?: (
    pool: pg.Pool,
    input: { organizationId: string; enrollmentId: string; nodeId: string; result: FollowupFlowTurnResult },
  ) => Promise<void>;
}

/** Duração humana pt-br do intervalo desde a última resposta — só ordem de grandeza. */
function humanizeElapsed(ms: number): string {
  if (ms >= DAY_MS) {
    const days = Math.floor(ms / DAY_MS);
    return days === 1 ? '1 dia' : `${days} dias`;
  }
  if (ms >= HOUR_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    return hours === 1 ? '1 hora' : `${hours} horas`;
  }
  return 'menos de uma hora';
}

/**
 * Bloco temporal de re-entrada. Com promessa → variante completa; sem promessa →
 * variante mínima coerente (acc3), nunca uma promessa inventada. O delta N dias é
 * medido do `now` (clock do run) até a última resposta do lead (última inbound do
 * contexto); sem inbound no contexto, cai numa abertura de retomada sem delta.
 */
export function buildTemporalBlock(input: {
  now: Date;
  reason?: string | undefined;
  promise?: string | undefined;
  promisedAt?: string | undefined;
  lastInbound: { body: string; sentAt: string } | null;
}): string {
  const parts: string[] = [];

  if (input.lastInbound !== null) {
    const elapsedMs = input.now.getTime() - Date.parse(input.lastInbound.sentAt);
    parts.push(
      Number.isNaN(elapsedMs)
        ? 'Você está retomando o contato com o lead após o intervalo combinado.'
        : `Passaram ${humanizeElapsed(Math.max(0, elapsedMs))} desde a última resposta do lead.`,
    );
  } else {
    parts.push('Você está retomando o contato com o lead; não há resposta recente registrada na conversa.');
  }

  const promise = input.promise?.trim();
  if (promise) {
    parts.push(
      input.promisedAt ? `Você prometeu: ${promise} (para ${input.promisedAt}).` : `Você prometeu: ${promise}.`,
    );
  }

  const reason = input.reason?.trim();
  if (reason) {
    parts.push(`Motivo do follow-up: ${reason}.`);
  }

  if (input.lastInbound !== null) {
    parts.push(`A última coisa que o lead disse foi: "${input.lastInbound.body}".`);
  }

  return parts.join(' ');
}

/** Abertura do follow-up: bloco temporal no topo do sufixo + o ritual padrão. */
function buildFollowupOpeningMessage(
  temporalBlock: string,
  previous: LeadCheckpointRow | null,
  leadState: LeadStateRow | null,
  context: LeadContext,
  notesIndexBlock: string,
  projeta = false,
): string {
  return [
    'Follow-up agendado: você havia combinado retornar a este lead — NÃO houve nova mensagem dele desde então.',
    '',
    '## Contexto temporal do follow-up',
    temporalBlock,
    '',
    ...ritualBlocks(previous, leadState, context, notesIndexBlock, projeta),
    '',
    'Retome a conversa com naturalidade usando a tool send_message — NUNCA escreva a resposta como texto direto',
    '(texto fora de tool é descartado pelo runtime). Use get_lead_context se precisar reler o contexto.',
    'Houve avanço REAL no funil neste turno? Marque-o com update_lead_state (só o próximo estágio válido).',
    'Aprendeu algo durável sobre o lead? Salve com save_lead_note (a headline entra no índice de memória).',
  ].join('\n');
}

/** Última mensagem inbound do contexto (a "última coisa que o lead disse" — Z). */
function lastInboundOf(context: LeadContext): { body: string; sentAt: string } | null {
  for (let i = context.messages.length - 1; i >= 0; i -= 1) {
    const m = context.messages[i]!;
    if (m.direction === 'inbound') {
      return { body: m.body, sentAt: m.sent_at };
    }
  }
  return null;
}

/**
 * A última inbound, mas SÓ se veio depois da última outbound — "nada de novo
 * desde a última vez que falamos" vira `null` (onda 5: o classify SÓ tem algo
 * pra classificar quando o lead respondeu DEPOIS do nosso último envio).
 */
function lastInboundSinceLastOutbound(context: LeadContext): string | null {
  let lastOutboundAt: number | null = null;
  for (const m of context.messages) {
    if (m.direction === 'outbound') lastOutboundAt = Date.parse(m.sent_at);
  }
  for (let i = context.messages.length - 1; i >= 0; i -= 1) {
    const m = context.messages[i]!;
    if (m.direction === 'inbound') {
      const at = Date.parse(m.sent_at);
      return lastOutboundAt === null || at > lastOutboundAt ? m.body : null;
    }
  }
  return null;
}

/**
 * Handler de `followup_turn` para o registry do daemon (main.ts). Resolve os ids de
 * envio da row do lead (nunca do payload) e injeta o bloco temporal no sufixo antes
 * de delegar ao núcleo compartilhado do run (runAgentTurn).
 */
export function createFollowupTurnHandler(deps: FollowupTurnDeps) {
  return async (job: JobRow, pool: pg.Pool, ctx: { workerId: string }): Promise<void> => {
    const tenantId = job.organization_id;
    const leadId = job.contact_id;
    if (leadId === null) {
      throw new Error('job followup_turn sem contact_id — o CHECK da fila deveria impedir');
    }
    const payload = followupTurnPayloadSchema.parse(job.payload);

    const target = await resolveSendTarget(pool, tenantId, leadId);

    const clock = deps.clock ?? ((): Date => new Date());

    // Onda 5 (Task 5.1): turno DIRIGIDO POR FLUXO — guard exclusivo, nunca cai nos
    // caminhos legados abaixo (F3-03/F3-04 seguem intocados quando o campo falta).
    if (payload.followup_enrollment_id !== undefined) {
      await runFlowDrivenTurn(deps, job, pool, ctx, clock, target, {
        enrollmentId: payload.followup_enrollment_id,
        nodeId: payload.node_id,
        purpose: payload.purpose,
        promptHint: payload.prompt_hint,
        fixedBody: payload.fixed_body,
        templateId: payload.template_id,
        voltaIndex: payload.volta_index,
        voltaTotal: payload.volta_total,
        classes: payload.classes,
        hint: payload.hint,
        waits: payload.waits,
      });
      return;
    }

    // F3-04: caminho determinístico ($0) — envia o template versionado direto pela
    // cadeia de guardrails, sem chamar o modelo. É um CAMINHO ADICIONAL: o run do
    // agente (abaixo) segue intocado quando o modo não é 'template'.
    if (payload.mode === 'template') {
      await runDeterministicReentry(deps, job, pool, ctx, clock, {
        tenantId,
        leadId,
        channelSessionId: target.channelSessionId,
        conversationId: target.conversationId,
      });
      return;
    }

    await runAgentTurn(deps, job, pool, ctx, {
      channelSessionId: target.channelSessionId,
      conversationId: target.conversationId,
      buildOpening: ({ previous, leadState, context, notesIndexBlock, projeta }) => {
        const temporalBlock = buildTemporalBlock({
          now: clock(),
          reason: payload.reason,
          promise: payload.promise,
          promisedAt: payload.promised_at,
          lastInbound: lastInboundOf(context),
        });
        return buildFollowupOpeningMessage(temporalBlock, previous, leadState, context, notesIndexBlock, projeta);
      },
    });
  };
}

interface ReentrySendTarget {
  tenantId: string;
  leadId: string;
  channelSessionId: string;
  conversationId: string;
}

/**
 * Conversa 1:1 + sessão de envio. Captação por webhook não passa pelo WAHA, então
 * o contato chega sem thread — o follow-up de recepção é o primeiro outbound e
 * precisa ABRIR a conversa no número WORKING da org (mesmo papel de
 * `ensureConversation` na ação send_whatsapp).
 *
 * `to_jsonb(cs) ->> 'archived_at'` em vez de `cs.archived_at`: clone sem a
 * migration 0106 não pode tomar 42703 em todo follow-up.
 */
async function resolveSendTarget(
  pool: pg.Pool,
  tenantId: string,
  contactId: string,
): Promise<ReentrySendTarget> {
  const { rows } = await pool.query<{
    id: string;
    channel_session_id: string | null;
    channel_archived_at: string | null;
  }>(
    `select c.id,
            c.channel_session_id,
            to_jsonb(cs) ->> 'archived_at' as channel_archived_at
       from conversations c
       left join channel_sessions cs
         on cs.id = c.channel_session_id and cs.organization_id = c.organization_id
      where c.organization_id = $1 and c.contact_id = $2 and c.is_group = false
      order by c.last_message_at desc nulls last limit 1`,
    [tenantId, contactId],
  );
  const conv = rows[0];
  if (conv !== undefined && conv.channel_session_id !== null) {
    if (conv.channel_archived_at !== null) {
      throw new Error('followup_turn para canal arquivado — o número foi excluído da Central de Conexões');
    }
    return {
      tenantId,
      leadId: contactId,
      channelSessionId: conv.channel_session_id,
      conversationId: conv.id,
    };
  }

  const session = await pool.query<{ id: string }>(
    `select cs.id
       from channel_sessions cs
      where cs.organization_id = $1
        and (to_jsonb(cs) ->> 'archived_at') is null
      order by case when cs.status = 'WORKING' then 0 else 1 end, cs.created_at asc
      limit 1`,
    [tenantId],
  );
  const channelSessionId = session.rows[0]?.id;
  if (channelSessionId === undefined) {
    throw new Error('followup_turn sem conversa/número do contato — impossível retomar o contato');
  }

  try {
    const inserted = await pool.query<{ id: string }>(
      `insert into conversations (organization_id, contact_id, channel_session_id, channel, status, is_group, metadata)
       values ($1, $2, $3, 'whatsapp', 'open', false, jsonb_build_object('created_by', 'followup_turn'))
       returning id`,
      [tenantId, contactId, channelSessionId],
    );
    const conversationId = inserted.rows[0]?.id;
    if (conversationId === undefined) {
      throw new Error('followup_turn sem conversa/número do contato — impossível retomar o contato');
    }
    return { tenantId, leadId: contactId, channelSessionId, conversationId };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== '23505') throw err;
    const winner = await pool.query<{ id: string }>(
      `select id from conversations
        where organization_id = $1 and contact_id = $2 and channel_session_id = $3 and is_group = false
        order by created_at desc limit 1`,
      [tenantId, contactId, channelSessionId],
    );
    const conversationId = winner.rows[0]?.id;
    if (conversationId === undefined) throw err;
    return { tenantId, leadId: contactId, channelSessionId, conversationId };
  }
}

/**
 * Onda 5 (Task 5.1) — turno dirigido por fluxo (`payload.followup_enrollment_id`
 * presente). Roteia pelos 3 `purpose` que `lib/followup/node-handlers.ts` pode
 * pedir; ao terminar, chama `deps.completeFollowupTurn` (injetado — a ponte de
 * verdade vive em `lib/followup/turn-bridge.ts`, que este arquivo NUNCA importa:
 * agent-engine não conhece followup/*, só o callback).
 */
async function runFlowDrivenTurn(
  deps: FollowupTurnDeps,
  job: JobRow,
  pool: pg.Pool,
  ctx: { workerId: string },
  clock: () => Date,
  target: ReentrySendTarget,
  input: {
    enrollmentId: string;
    nodeId: string | undefined;
    purpose: 'send_message' | 'classify' | 'plan_timing' | undefined;
    promptHint: string | undefined;
    fixedBody: string | undefined;
    templateId: string | undefined;
    voltaIndex: number | undefined;
    voltaTotal: number | undefined;
    classes: string[] | undefined;
    hint: string | undefined;
    waits: EsperaParaPlanejar[] | undefined;
  },
): Promise<void> {
  if (input.nodeId === undefined || input.purpose === undefined) {
    throw new Error('followup_turn dirigido por fluxo sem node_id/purpose no payload — payload do engine incompleto');
  }
  const complete = deps.completeFollowupTurn;
  if (!complete) {
    throw new Error(
      'followup_turn dirigido por fluxo sem completeFollowupTurn nos deps do handler — a ponte não foi injetada na wiring (workers/agent-worker/main.ts)',
    );
  }
  const { enrollmentId, nodeId } = input;
  const runLog = withFields(deps.log, { job_id: job.id, tenant_id: target.tenantId, lead_id: target.leadId, enrollment_id: enrollmentId });

  if (input.purpose === 'send_message') {
    const body = await resolveFlowSendBody(pool, target.tenantId, input);
    if (body !== null) {
      // Texto do operador: sem camada semântica (ver o cabeçalho de sendFixedOutbound).
      const sent = await sendFixedOutbound(deps, job, pool, ctx, clock, target, body, false);
      if (sent) {
        await complete(pool, { organizationId: target.tenantId, enrollmentId, nodeId, result: { kind: 'sent' } });
      }
      return;
    }
    await runAgentTurn(deps, job, pool, ctx, {
      channelSessionId: target.channelSessionId,
      conversationId: target.conversationId,
      buildOpening: ({ previous, leadState, context, notesIndexBlock, projeta }) => {
        const temporalBlock = buildTemporalBlock({ now: clock(), lastInbound: lastInboundOf(context) });
        const opening = buildFollowupOpeningMessage(temporalBlock, previous, leadState, context, notesIndexBlock, projeta);
        if (!input.promptHint) return opening;
        return `${opening}\n\n## Orientação do passo do fluxo\n${input.promptHint}`;
      },
    });
    await complete(pool, { organizationId: target.tenantId, enrollmentId, nodeId, result: { kind: 'sent' } });
    return;
  }

  if (input.purpose === 'classify') {
    const classes = input.classes ?? [];
    const fuso = await fusoDaOrganizacao(pool, target.tenantId, runLog);
    const context = await getLeadContext(pool, deps.crmCfg, { tenantId: target.tenantId, leadId: target.leadId, fuso }, {
      historyLimit: deps.knobs.historyLimit,
      maxTokens: deps.knobs.maxContextTokens,
    });
    if (!context.ok) {
      throw new Error(`turno de classificação do fluxo falhou em get_lead_context (${context.error.code})`);
    }
    const cls = await classifyFollowupReply(
      pool,
      deps.llmCfg,
      { tenantId: target.tenantId, leadId: target.leadId, jobId: job.id },
      {
        candidateText: lastInboundSinceLastOutbound(context.context),
        classes,
        ...(input.hint !== undefined ? { hint: input.hint } : {}),
        ...(deps.knobs.followupAi?.model !== undefined ? { model: deps.knobs.followupAi.model } : {}),
      },
      { ...(deps.registry !== undefined ? { registry: deps.registry } : {}), log: runLog },
    );
    await complete(pool, { organizationId: target.tenantId, enrollmentId, nodeId, result: { kind: 'classified', class: cls } });
    return;
  }

  // 'plan_timing' — o acionamento do fluxo: planeja TODAS as esperas adaptativas
  // de uma vez. Sem esperas no payload não há o que planejar, e chamar o modelo
  // para devolver um plano vazio seria pagar por nada.
  const esperas = input.waits ?? [];
  if (esperas.length === 0) {
    throw new Error('turno de planejamento de tempo sem esperas no payload — o engine só o enfileira quando há espera adaptativa');
  }
  const context = await getLeadContext(
    pool,
    deps.crmCfg,
    { tenantId: target.tenantId, leadId: target.leadId, fuso: await fusoDaOrganizacao(pool, target.tenantId, runLog) },
    { historyLimit: deps.knobs.historyLimit, maxTokens: deps.knobs.maxContextTokens },
  );
  if (!context.ok) {
    throw new Error(`turno de planejamento de tempo do fluxo falhou em get_lead_context (${context.error.code})`);
  }
  const plano = await planFollowupTiming(
    pool,
    deps.llmCfg,
    { tenantId: target.tenantId, leadId: target.leadId, jobId: job.id },
    {
      context: context.context,
      esperas,
      ...(deps.knobs.followupAi?.model !== undefined ? { model: deps.knobs.followupAi.model } : {}),
    },
    { ...(deps.registry !== undefined ? { registry: deps.registry } : {}), log: runLog, clock },
  );
  await complete(pool, {
    organizationId: target.tenantId,
    enrollmentId,
    nodeId,
    result: { kind: 'planned', propostas: plano.propostas, modelo: plano.modelo },
  });
}

/**
 * Re-entrada DETERMINÍSTICA (F3-04): carrega o template ativo por ponteiro, escolhe a
 * variante do lead (hash — acc2) e a envia SEM LLM. Enviar continua sendo o sink
 * idempotente (F2-06) ATRÁS da cadeia de guardrails (F2-13): STOP/anti-ban/spinning
 * rodam igual ao caminho do agente — só o modelo é pulado ($0). Fora da janela
 * anti-ban o envio é RE-AGENDADO (nunca dropado — acc3).
 */
async function runDeterministicReentry(
  deps: InboundTurnDeps,
  job: JobRow,
  pool: pg.Pool,
  ctx: { workerId: string },
  clock: () => Date,
  target: ReentrySendTarget,
): Promise<void> {
  const template = await loadReentryTemplate(pool, target.tenantId);
  if (template === null) {
    throw new Error('re-entrada determinística sem template apontado para o tenant — publique um template e mova o ponteiro');
  }
  // Re-entrada por template: honra a camada da organização, como na main.
  await sendFixedOutbound(
    deps,
    job,
    pool,
    ctx,
    clock,
    target,
    pickReentryVariant(target.leadId, template.variants),
    true,
  );
}

function interpolarVoltaDoPayload(texto: string, index: number | undefined, total: number | undefined): string {
  if (index === undefined || total === undefined) return texto;
  return texto.replaceAll('{{volta}}', String(index)).replaceAll('{{voltas}}', String(total));
}

async function resolveFlowSendBody(
  pool: pg.Pool,
  tenantId: string,
  input: {
    fixedBody: string | undefined;
    templateId: string | undefined;
    voltaIndex: number | undefined;
    voltaTotal: number | undefined;
  },
): Promise<string | null> {
  if (input.fixedBody !== undefined) {
    return interpolarVoltaDoPayload(input.fixedBody, input.voltaIndex, input.voltaTotal);
  }
  if (input.templateId === undefined) return null;
  const { rows } = await pool.query<{ body: string }>(
    `select body from message_templates where organization_id = $1 and id = $2 limit 1`,
    [tenantId, input.templateId],
  );
  const body = rows[0]?.body;
  if (body === undefined || body.length === 0) {
    throw new Error('followup_turn sem modelo de mensagem — o template_id do passo não existe nesta organização');
  }
  return interpolarVoltaDoPayload(body, input.voltaIndex, input.voltaTotal);
}

/**
 * Envia `body` pela cadeia de guardrails, sem LLM. `true` = o sink aceitou.
 *
 * ─── Por que a camada semântica é PARÂMETRO, e não uma decisão só ───────────
 *
 * Esta função tem dois chamadores, e eles NÃO querem a mesma coisa:
 *
 *  - **texto do fluxo** (`action.mode=text`, `runFlowDrivenTurn`) — é do
 *    operador, e a classificação semântica de promessa exige LLM: ligá-la ali
 *    barrava o 1º outbound de captação de quem não tem BYOK. Passa `false`, e
 *    essa é a decisão original deste PR, mantida com a razão que ela já tinha.
 *
 *  - **re-entrada determinística por TEMPLATE** (`runDeterministicReentry`) —
 *    na `main` ela SEMPRE passou pela camada quando a organização a liga
 *    (`camadaLigada(camadasDaOrg.promessa_semantica, …)`), pelo motivo escrito
 *    lá: "a re-entrada determinística passa pela MESMA cadeia, então tem de
 *    honrar a MESMA preferência. Ler só no inbound deixaria a camada ligada num
 *    caminho e desligada no outro, para a mesma organização."
 *
 * Ao unificar os dois chamadores numa função só, a razão do primeiro passou a
 * valer para o segundo em silêncio — e a escolha que a organização faz na tela
 * virava dado gravado e ignorado pelo motor. `tests/unit/camada-lida-no-motor.test.ts`
 * existe exatamente para isso, e o cabeçalho dele conta que uma sabotagem desta
 * linha deixou 13 testes verdes.
 *
 * STOP / anti-ban / spinning / LGPD continuam na cadeia nos DOIS casos.
 */
async function sendFixedOutbound(
  deps: InboundTurnDeps,
  job: JobRow,
  pool: pg.Pool,
  ctx: { workerId: string },
  clock: () => Date,
  target: ReentrySendTarget,
  body: string,
  /** `true` só na re-entrada por template — ver o cabeçalho. */
  comCamadaSemantica: boolean,
): Promise<boolean> {
  const { tenantId, leadId, channelSessionId, conversationId } = target;
  const runLog = withFields(deps.log, { job_id: job.id, tenant_id: tenantId, lead_id: leadId });

  if (await isLeadInHandoff(pool, tenantId, leadId)) {
    runLog.info('envio fixo pulado — lead silenciado (handoff/opt-out)', { kind: job.kind });
    return false;
  }

  const context = await getLeadContext(
    pool,
    deps.crmCfg,
    { tenantId, leadId, fuso: await fusoDaOrganizacao(pool, tenantId, runLog) },
    { historyLimit: deps.knobs.historyLimit, maxTokens: deps.knobs.maxContextTokens },
  );
  if (!context.ok) {
    throw new Error(`envio fixo do follow-up falhou em get_lead_context (${context.error.code})`);
  }
  const optedOutThisTurn = context.context.contact.is_blocked;

  const channel = (deps.channel ?? ((p: pg.Pool) => new WahaChannelAdapter(p, deps.crmCfg)))(pool);

  // A escolha da ORGANIZAÇÃO, e não só o knob do `.env` do worker. Lida aqui, e
  // não no chamador, para que o único caminho até `runBeforeSend` seja também o
  // único lugar onde a preferência é consultada. Consulta só quando vale —
  // texto de fluxo não usa, e não deve pagar um round-trip por isso.
  const camadasDaOrg = comCamadaSemantica ? await lerCamadasDaOrg(pool, tenantId) : null;
  const camadaSemanticaLigada =
    camadasDaOrg !== null &&
    camadaLigada(camadasDaOrg.promessa_semantica, deps.knobs.promiseSemantic?.enabled === true);

  const chain = await runBeforeSend({
    pool,
    log: runLog,
    tenantId,
    leadId,
    jobId: job.id,
    channelSessionId,
    body,
    optedOutThisTurn,
    crmDailyLimit: null,
    now: clock(),
    sleep: deps.sleep,
    lgpd: context.lgpd,
    ...(deps.knobs.disclosureMode !== undefined ? { disclosureMode: deps.knobs.disclosureMode } : {}),
    ...(camadaSemanticaLigada
      ? {
          classifyPromiseSemantic: (candidate: string) =>
            classifyPromise(
              pool,
              deps.llmCfg,
              { tenantId, leadId, jobId: job.id },
              { candidate, ...(deps.knobs.promiseSemantic?.model !== undefined ? { model: deps.knobs.promiseSemantic.model } : {}) },
              { ...(deps.registry !== undefined ? { registry: deps.registry } : {}), log: runLog },
            ),
        }
      : {}),
    send: (finalBody) => channel.send({ tenantId, leadId, jobId: job.id, seq: 1, conversationId, body: finalBody }),
  });

  if (chain.status === 'vetoed') {
    if (chain.code === 'outside_window' && chain.nextAllowedAt !== undefined) {
      await rescheduleReentry(pool, {
        tenantId,
        leadId,
        jobId: job.id,
        at: chain.nextAllowedAt,
        payload: job.payload,
      });
      runLog.info('envio fixo re-agendado por janela anti-ban', {
        code: chain.code,
        next_run_at: chain.nextAllowedAt.toISOString(),
      });
      return false;
    }
    runLog.info('envio fixo vetado pela cadeia — não re-agendado', { code: chain.code });
    return false;
  }

  const outcome = chain.outcome;
  switch (outcome.kind) {
    case 'sent':
    case 'already_sent':
    case 'queued':
      runLog.info('envio fixo concluído', { kind: outcome.kind });
      return true;
    case 'blocked':
      await applySendOutcome(pool, outcome, { jobId: job.id, workerId: ctx.workerId, tenantId, leadId }, {
        queuedRetryDelayMs: deps.knobs.queuedRetryDelayMs,
      });
      throw new JobSettledError('envio fixo vetado pelo sink (is_blocked) — job cancelado em definitivo');
    case 'failed':
      throw new Error('envio fixo: CRM marcou o envio como failed — run re-tentado pela fila');
    case 'unavailable':
      throw new Error(`envio fixo: canal indisponível (${outcome.reason}) — run re-tentado pela fila`);
  }
}

/**
 * Re-agenda a re-entrada para `at` (próxima janela válida) num cron_job 'at' one-shot
 * (F3-01), reusando o payload de origem (mantém mode='template'). IDEMPOTENTE por job
 * de origem: dois runs do MESMO job (retry pós-crash) criam UM só cron. staggerWindowMs
 * 0 de propósito — o jitter anti-ban já está embutido em `at` (nextAllowedAt do gate),
 * não é um número novo escondido.
 * ponytail: check-then-insert é seguro porque o followup_turn de um lead roda numa lane
 * serializada (F2-03) e o retry é sequencial; se um dia rodar concorrente por lead, vira
 * unique index parcial em (tenant_id, lead_id, payload->>'reschedule_of').
 */
async function rescheduleReentry(
  pool: pg.Pool,
  input: { tenantId: string; leadId: string; jobId: string; at: Date; payload: Record<string, unknown> },
): Promise<void> {
  const { rowCount } = await pool.query(
    `select 1 from cron_jobs
     where organization_id = $1 and contact_id = $2 and payload->>'reschedule_of' = $3`,
    [input.tenantId, input.leadId, input.jobId],
  );
  if (rowCount !== null && rowCount > 0) {
    return; // já re-agendado para este job (idempotência)
  }
  await scheduleCronJob(pool, input.tenantId, {
    leadId: input.leadId,
    spec: { kind: 'at', at: input.at },
    jobKind: 'followup_turn',
    payload: { ...input.payload, reschedule_of: input.jobId },
    staggerWindowMs: 0,
  });
}
