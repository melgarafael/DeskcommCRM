import {claimOfJob,type JobClaim} from "../queue/claim";
import {resultadoDoEnvioDoFollowup} from "../edge/crm/send-ledger";
import { parseServiceBoundary } from "@/lib/atendimento/fronteira";
import { requireCurrentServiceBoundary } from "@/lib/atendimento/fronteira-server";
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
import { definicaoNaConexao } from '@/lib/channels/linha-do-espelho';
import { estadoDaJanela } from '@/lib/channels/janela';
import { renderTemplateBody } from '@/lib/channels/meta/render-template';
import { isStatusSendable } from '@/lib/channels/meta/template-binding';
import { deriveTemplateContract } from '@/lib/channels/meta/template-contract';
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
import {
  followupPublicadoDoEnrollment,
  proximaAberturaDoFollowup,
} from './janela-de-followup';
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
    /** action mode `template` — `message_templates` (texto) ou `meta_templates` (modelo aprovado do canal). */
    template_id: z.string().uuid().optional(),
    /** action mode `ai_message` — modelo aprovado que sai no lugar da IA com a janela de 24 h fechada. */
    fallback_template_id: z.string().uuid().optional(),
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
  | { kind: 'skipped'; reason: string }
  | { kind: 'classified'; class: string }
  /** O envio ficou estacionado até `until` (janela fechada) — nem saiu, nem foi recusado. */
  | { kind: 'deferred'; until: Date; reason: string }
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
    input: { organizationId: string; enrollmentId: string; nodeId: string; jobId?: string; jobClaim?:JobClaim; result: FollowupFlowTurnResult },
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

    const boundary = parseServiceBoundary(job.payload.service_boundary);
    await requireCurrentServiceBoundary(pool, boundary);
    const { rows: targetRows } = await pool.query<{ channel_session_id: string; archived_at: string | null }>(
      `select c.channel_session_id, to_jsonb(cs)->>'archived_at' as archived_at from conversations c
       join channel_sessions cs on cs.id=c.channel_session_id and cs.organization_id=c.organization_id
       where c.organization_id=$1 and c.id=$2 and c.contact_id=$3`,
      [tenantId, boundary!.conversation_id, leadId]);
    if (!targetRows[0]) throw new Error('conversa de origem indisponível');
    if (targetRows[0].archived_at) throw new Error('canal arquivado');
    const target: ReentrySendTarget = { tenantId, leadId, conversationId: boundary!.conversation_id, channelSessionId: targetRows[0]!.channel_session_id };

    const clock = deps.clock ?? ((): Date => new Date());

    // #490 — a janela PRÓPRIA vale só para envio proativo dirigido por fluxo.
    // `classify` e `plan_timing` não falam com o cliente e podem rodar a qualquer
    // hora. Retornos prometidos via `schedule_followup` continuam fora deste
    // recorte: eles não têm enrollment/agent pinado, e a issue deixou essa regra
    // explicitamente em aberto para uma decisão separada.
    if (payload.followup_enrollment_id !== undefined && payload.purpose === 'send_message') {
      const followup = await followupPublicadoDoEnrollment(
        pool,
        tenantId,
        payload.followup_enrollment_id,
      );
      const sendWindow =
        typeof followup === 'object' && followup !== null
          ? (followup as { send_window?: unknown }).send_window
          : null;
      if (sendWindow !== null && sendWindow !== undefined) {
        const runLog = withFields(deps.log, {
          job_id: job.id,
          tenant_id: tenantId,
          lead_id: leadId,
          enrollment_id: payload.followup_enrollment_id,
        });
        const agora = clock();
        const fuso = await fusoDaOrganizacao(pool, tenantId, runLog);
        const proximaAbertura = proximaAberturaDoFollowup(followup, fuso, agora);
        if (proximaAbertura !== null) {
          const complete = deps.completeFollowupTurn;
          if (!complete || payload.node_id === undefined) {
            throw new Error(
              'follow-up adiado pela janela própria sem completeFollowupTurn/node_id — o enrollment não saberia do adiamento',
            );
          }
          await rescheduleReentry(pool, {
            tenantId,
            leadId,
            jobId: job.id,
            at: proximaAbertura,
            payload: job.payload,
          });
          runLog.info('follow-up adiado pela janela própria do agente', {
            next_run_at: proximaAbertura.toISOString(),
            timezone: fuso,
          });
          // O adiamento VOLTA para o enrollment, como o da janela anti-ban em
          // `runFlowDrivenTurn`. Sem isto o motor lê a espera como worker morto:
          // o dead-man da ação esgota ~11h e marca `dead` um enrollment cujo
          // envio ia sair na abertura — e o padrão desta faixa (sexta 18h →
          // segunda 9h) já espera 63h.
          await complete(pool, {
            jobId: job.id,
            jobClaim: claimOfJob(job),
            organizationId: tenantId,
            enrollmentId: payload.followup_enrollment_id,
            nodeId: payload.node_id,
            result: { kind: 'deferred', until: proximaAbertura, reason: 'followup_send_window' },
          });
          return;
        }
      }
    }

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
        fallbackTemplateId: payload.fallback_template_id,
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

/**
 * O que aconteceu com um envio sem LLM. `deferred` carrega o INSTANTE porque
 * quem recebe precisa dele: sem a data, "adiado" e "some" são a mesma coisa
 * para o enrollment.
 */
type EnvioFixoDesfecho =
  | { kind: "sent" }
  | { kind: "deferred"; until: Date; reason: string }
  | { kind: "skipped" };

interface ReentrySendTarget {
  tenantId: string;
  leadId: string;
  channelSessionId: string;
  conversationId: string;
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
    fallbackTemplateId: string | undefined;
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
    let passo = await resolveFlowSendBody(pool, target.tenantId, target.channelSessionId, input);
    // O PLANO B DA MENSAGEM POR IA. Com a janela de 24 h fechada, o canal recusa
    // qualquer texto livre — o da IA inclusive —, e o passo terminava sem mandar
    // nada. A tela prometia "se a IA não conseguir escrever, mandar este modelo"
    // e o campo era gravado, validado e nunca lido. Só vale para modelo APROVADO
    // do canal: um texto de `message_templates` seria recusado pela mesma janela,
    // então nesse caso o turno segue para a IA como sempre seguiu.
    if (
      passo === null &&
      input.fallbackTemplateId !== undefined &&
      (await janelaFechada(pool, target, clock()))
    ) {
      passo = await resolveModeloAprovado(pool, target.tenantId, target.channelSessionId, input.fallbackTemplateId);
    }
    if (passo !== null && passo.tipo === 'recusado') {
      runLog.info('passo do fluxo pulado — o modelo não pode sair', { motivo: passo.motivo });
      await complete(pool, { jobId: job.id, jobClaim: claimOfJob(job), organizationId: target.tenantId, enrollmentId, nodeId, result: { kind: 'skipped', reason: passo.motivo } });
      return;
    }
    if (passo !== null) {
      // Texto do operador: sem camada semântica (ver o cabeçalho de sendFixedOutbound).
      const desfecho = await sendFixedOutbound(
        deps, job, pool, ctx, clock, target, passo.body, false,
        passo.tipo === 'modelo_aprovado' ? passo.modelo : undefined,
      );
      // TODO OS TRÊS DESFECHOS VOLTAM PARA O ENROLLMENT. O adiado era o que não
      // voltava, e o silêncio dele custava o enrollment inteiro: o motor ficava
      // rechecando um turno que ninguém ia fechar e, esgotado o orçamento do
      // dead-man (~11h), marcava `dead` com `action_turn_never_completed` — um
      // motivo falso, porque o worker estava vivo e o envio só esperava a
      // janela abrir. Uma noite de sábado com domingo fechado (33h) já passava
      // do orçamento na `main`; a faixa de envio por agente chega a 159h.
      if (desfecho.kind === 'sent') {
        await complete(pool, { jobId:job.id,jobClaim:claimOfJob(job), organizationId: target.tenantId, enrollmentId, nodeId, result: { kind: 'sent' } });
      } else if (desfecho.kind === 'skipped') {
        await complete(pool,{jobId:job.id,jobClaim:claimOfJob(job),organizationId:target.tenantId,enrollmentId,nodeId,result:{kind:'skipped',reason:'O envio foi recusado pelas regras do atendimento.'}});
      } else {
        await complete(pool,{jobId:job.id,jobClaim:claimOfJob(job),organizationId:target.tenantId,enrollmentId,nodeId,result:{kind:'deferred',until:desfecho.until,reason:desfecho.reason}});
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
    const result = await resultadoDoEnvioDoFollowup(pool,job.organization_id,job.id);
    await complete(pool, { jobId:job.id,jobClaim:claimOfJob(job), organizationId: target.tenantId, enrollmentId, nodeId, result });
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
    await complete(pool, { jobId:job.id,jobClaim:claimOfJob(job), organizationId: target.tenantId, enrollmentId, nodeId, result: { kind: 'classified', class: cls } });
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
    jobId:job.id,jobClaim:claimOfJob(job),
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

/**
 * O que um passo de envio sem IA manda.
 *
 * `modelo_aprovado` carrega, além do corpo RENDERIZADO (é ele que os gates de
 * conteúdo avaliam), o nome e o idioma que o canal precisa para disparar o modelo.
 * `recusado` é configuração que não pode sair — o passo é pulado com o motivo, em
 * vez de a fila re-tentar até matar a inscrição por algo que tempo não conserta.
 */
type PassoSemIa =
  | { tipo: 'texto'; body: string }
  | {
      tipo: 'modelo_aprovado';
      body: string;
      modelo: { name: string; language: string; values: Record<string, string> };
    }
  | { tipo: 'recusado'; motivo: string };

async function resolveFlowSendBody(
  pool: pg.Pool,
  tenantId: string,
  channelSessionId: string,
  input: {
    fixedBody: string | undefined;
    templateId: string | undefined;
    voltaIndex: number | undefined;
    voltaTotal: number | undefined;
  },
): Promise<PassoSemIa | null> {
  if (input.fixedBody !== undefined) {
    return { tipo: 'texto', body: interpolarVoltaDoPayload(input.fixedBody, input.voltaIndex, input.voltaTotal) };
  }
  if (input.templateId === undefined) return null;
  const { rows } = await pool.query<{ body: string }>(
    `select body from message_templates where organization_id = $1 and id = $2 limit 1`,
    [tenantId, input.templateId],
  );
  const body = rows[0]?.body;
  if (body !== undefined && body.length > 0) {
    return { tipo: 'texto', body: interpolarVoltaDoPayload(body, input.voltaIndex, input.voltaTotal) };
  }
  // Não é texto pronto: pode ser um modelo APROVADO do canal. Até aqui o passo só
  // lia `message_templates`, e um fluxo apontado para um modelo aprovado — o único
  // envio que passa com a janela de 24 h fechada — morria neste `throw` no primeiro
  // disparo, depois de o editor ter aceitado e publicado o grafo.
  const aprovado = await resolveModeloAprovado(pool, tenantId, channelSessionId, input.templateId);
  if (aprovado === null) {
    throw new Error('followup_turn sem modelo de mensagem — o template_id do passo não existe nesta organização');
  }
  return aprovado;
}

/**
 * Um modelo aprovado do canal (`meta_templates.id`), pronto para sair NESTA
 * conexão. `null` = o id não é de modelo do canal nesta organização.
 *
 * O id aponta uma linha, mas quem vale é a definição da conexão da conversa
 * (`definicaoNaConexao`, a mesma regra do `send_template` do agente): dois números
 * podem espelhar o mesmo nome, e disparar a linha de outra conta é recusa certa.
 *
 * O fluxo não tem de onde tirar valor para variável, então modelo com `{{1}}` é
 * recusado com o motivo — mandar o marcador cru ao cliente seria pior.
 */
async function resolveModeloAprovado(
  pool: pg.Pool,
  tenantId: string,
  channelSessionId: string,
  metaTemplateId: string,
): Promise<PassoSemIa | null> {
  const { rows } = await pool.query<{ name: string; language: string }>(
    `select name, language from meta_templates where organization_id = $1 and id = $2 limit 1`,
    [tenantId, metaTemplateId],
  );
  const alvo = rows[0];
  if (alvo === undefined) return null;
  const linha = await definicaoNaConexao<{ components: unknown; parameter_format: string; status: string }>(
    pool,
    ['components', 'parameter_format', 'status'],
    { organizationId: tenantId, name: alvo.name, language: alvo.language, channelSessionId },
  );
  if (linha === null) {
    return { tipo: 'recusado', motivo: `O modelo "${alvo.name}" não existe no número desta conversa.` };
  }
  if (!isStatusSendable(linha.status)) {
    return {
      tipo: 'recusado',
      motivo: `O modelo "${alvo.name}" está ${linha.status} na plataforma — só modelo aprovado pode ser enviado.`,
    };
  }
  const meta = { name: alvo.name, language: alvo.language, parameterFormat: linha.parameter_format };
  const contrato = deriveTemplateContract({
    name: alvo.name,
    language: alvo.language,
    parameter_format: linha.parameter_format,
    components: linha.components as never,
  });
  if (contrato.slots.length > 0) {
    return {
      tipo: 'recusado',
      motivo: `O modelo "${alvo.name}" tem variáveis, e o fluxo não tem de onde tirar os valores. Use um modelo sem variáveis.`,
    };
  }
  return {
    tipo: 'modelo_aprovado',
    body: renderTemplateBody(linha.components, {}, meta),
    modelo: { name: alvo.name, language: alvo.language, values: {} },
  };
}

/**
 * A janela de 24 h desta conversa está fechada? Mesmo insumo do gate da cadeia
 * (`readLastInboundAt` em before-send.ts: a conversa do contato NESTE número) e a
 * mesma conta (`estadoDaJanela`) — decidir aqui com outra régua faria o plano B
 * sair quando a cadeia deixaria a IA passar, ou o contrário.
 */
async function janelaFechada(pool: pg.Pool, target: ReentrySendTarget, agora: Date): Promise<boolean> {
  const { rows } = await pool.query<{ provider: string | null; last_inbound_at: Date | null }>(
    `select s.provider,
            (select c.last_inbound_at from conversations c
              where c.organization_id = s.organization_id and c.contact_id = $3
                and c.channel_session_id = s.id
              order by c.last_inbound_at desc nulls last
              limit 1) as last_inbound_at
       from channel_sessions s
      where s.organization_id = $1 and s.id = $2`,
    [target.tenantId, target.channelSessionId, target.leadId],
  );
  const linha = rows[0];
  if (linha === undefined) return false;
  const ultimo = linha.last_inbound_at === null ? null : new Date(linha.last_inbound_at).toISOString();
  return estadoDaJanela(linha.provider, ultimo, agora).tipo === 'fechada';
}

/**
 * Envia `body` pela cadeia de guardrails, sem LLM. Distingue aceito, adiado e veto terminal.
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
  /**
   * Presente = `body` é um modelo APROVADO do canal, já renderizado. A cadeia inteira
   * continua valendo (stop, LGPD, horário); só o gate da janela de 24 h o deixa
   * passar, que é o que um modelo aprovado é — como no `send_template` do agente.
   */
  modelo?: { name: string; language: string; values: Record<string, string> },
): Promise<EnvioFixoDesfecho> {
  const { tenantId, leadId, channelSessionId, conversationId } = target;
  const runLog = withFields(deps.log, { job_id: job.id, tenant_id: tenantId, lead_id: leadId });

  if (await isLeadInHandoff(pool, tenantId, leadId)) {
    runLog.info('envio fixo pulado — lead silenciado (handoff/opt-out)', { kind: job.kind });
    return { kind: "skipped" };
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
    ...(modelo !== undefined ? { isTemplate: true } : {}),
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
    send: (finalBody) =>
      channel.send({
        tenantId, leadId, jobId: job.id, jobClaim: claimOfJob(job), seq: 1, conversationId, body: finalBody,
        ...(modelo !== undefined ? { template: modelo } : {}),
      }),
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
      return { kind: "deferred", until: chain.nextAllowedAt, reason: chain.code };
    }
    runLog.info('envio fixo vetado pela cadeia — não re-agendado', { code: chain.code });
    return { kind: "skipped" };
  }

  const outcome = chain.outcome;
  switch (outcome.kind) {
    case 'sent':
    case 'already_sent':
      runLog.info('envio fixo concluído', { kind: outcome.kind });
      return { kind: "sent" };
    case 'queued':
      throw new Error('envio fixo: mensagem aguardando o canal — não conclui o passo');
    case 'blocked':
      await applySendOutcome(pool, outcome, { jobId: job.id, workerId: ctx.workerId, tenantId, leadId, jobClaim:claimOfJob(job) }, {
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
