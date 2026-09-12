import { guardServiceEffect } from "@/lib/atendimento/fronteira-server";
/**
 * Handoff humano como cidadão de 1ª classe (F4-06; blueprint 5.5 — escalação humana
 * clara e imediata é EXIGÊNCIA fiscalizada da Meta, não fallback). Dois gatilhos, uma
 * ação idempotente:
 *   1. DETERMINÍSTICO — regex PT-BR na última mensagem do lead ("falar com atendente",
 *      "quero falar com uma pessoa"…). Roda no runtime ANTES do modelo: o turno não gasta
 *      LLM. Ele AVISA o lead (texto de código, `avisarLeadDaEscalacao`) e só então silencia
 *      — nesta ordem, porque `force_human` arma o `stopGate` e mata todo envio posterior.
 *   2. TOOL request_human_handoff — o modelo aciona quando percebe o limite da automação.
 *
 * A ação (performHumanHandoff), idempotente e at-least-once — TUDO no mesmo banco agora
 * (a fusão matou o transporte MCP):
 *   (a) FONTE DA VERDADE: contacts.force_human=true — irrevogável (regra dura 2);
 *   (b) conversa: status transiciona SÓ 'ai_handling'→'pending' (CASE — nunca pisa em
 *       claimed/closed) + bot_silenced_until='infinity' + last_handoff_at/reason;
 *   (c) cancela os crons PENDENTES do lead (follow-ups agendados não disparam após handoff);
 *   (d) cria agent_inbox_items(kind='handoff') com o resumo (dedup por episódio aberto).
 *
 * tenant/lead/conversation vêm da ROW do job (closure do run), NUNCA do payload (regra dura 1).
 * O resumo vai ao inbox (é PARA o humano assumir) — mas NUNCA a log (PII fora de log, regra 8).
 */
import { z } from 'zod';
import type pg from 'pg';

import { expectativaDeAtendimento } from '@/lib/escalacao/disponibilidade';
import { ehOptOutProvavel } from '@/lib/opt-out/deteccao';
import { emitAgentActivityForContact } from '@/lib/leads/agent-activity';

import type { Logger } from '../obs/logger';
import { cancelPendingCronsForLead } from '../cron/scheduler';
import { findForbiddenKey, zodIssuesSummary } from './lead-state';
import { renderDeclaracaoParaHumano, type DeclaracaoDoTurno } from './declaracao';

/** Postgres `infinity`: o bot nunca reassume após handoff. */
const SILENCE_INFINITY = 'infinity';

/**
 * Normaliza para a detecção determinística: minúsculas + sem acento (NFD) — os padrões
 * abaixo são escritos sem acento, então "atendente"/"consultor" casam com/sem diacrítico.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '');
}

/**
 * Padrões PT-BR CONSERVADORES de pedido explícito de atendimento humano (evita falso
 * positivo: exige o verbo de contato + o alvo humano, ou expressões inequívocas). Rodam
 * sobre o texto normalizado (sem acento).
 */
const HUMAN_HANDOFF_PATTERNS: readonly RegExp[] = [
  /\b(?:falar|conversar)\s+com\s+(?:um[a]?\s+)?(?:atendente|humano|pessoa|gente|consultor|vendedor|representante|responsavel)\b/,
  /\bme\s+(?:passa|passe|transfere|transfira|encaminha|encaminhe|manda|mande)\s+(?:pra|para|pro)\s+(?:um[a]?\s+)?(?:atendente|humano|pessoa|gente|setor|comercial)\b/,
  /\batendimento\s+humano\b/,
  /\b(?:atendente|humano|pessoa)\s+de\s+verdade\b/,
];

/** True se a mensagem do lead é um pedido explícito de atendimento humano (determinístico). */
export function detectHumanHandoffRequest(message: string): boolean {
  if (message.trim() === '') return false;
  const normalized = normalize(message);
  return HUMAN_HANDOFF_PATTERNS.some((re) => re.test(normalized));
}

/**
 * Rede de segurança para confirmação de handoff pós-pergunta do agente.
 *
 * Quando o modelo pergunta "posso encaminhar para a equipe humana?" e o lead
 * responde "sim"/"pode"/"claro", o G1 original não cobre — ele só detecta
 * pedidos explícitos ("quero falar com humano"). Esta função fecha o gap:
 * se a última mensagem do bot ofereceu handoff E a resposta atual é afirmativa,
 * trata como gatilho de handoff determinístico.
 *
 * Falsos positivos são mitigados pelo contexto: só ativa quando AMBOS os lados
 * (pergunta + resposta) estão presentes. Um "sim" isolado sem oferta prévia não
 * aciona.
 */
const HANDOFF_OFFER_PATTERN =
  /\b(encaminhar|transferir|equipe\s+humana|atendente\s+humano|falar\s+com\s+(?:algu[eé]m|uma\s+pessoa|um\s+atendente))\b/i;

const AFFIRMATIVE_RESPONSE_PATTERN =
  /^\s*(sim|pode|podes|claro|ok|t[aá]|belezinha|beleza|quero|quero\s+sim|isso|confirmo|pode\s+encaminhar|pode\s+transferir)\s*[.!]?$/i;

export interface DetectHandoffConfirmationInput {
  /** Corpo da mensagem inbound do lead. */
  message: string;
  /** Última mensagem enviada pelo bot na conversa (se disponível). */
  lastBotMessage?: string | null;
}

export function detectHandoffConfirmation(input: DetectHandoffConfirmationInput): boolean {
  const { message, lastBotMessage } = input;
  if (!message || !lastBotMessage) return false;
  return HANDOFF_OFFER_PATTERN.test(lastBotMessage) && AFFIRMATIVE_RESPONSE_PATTERN.test(message.trim());
}


/**
 * True se a última mensagem do lead SUGERE opt-out. A regra mora em
 * `lib/opt-out/deteccao.ts` — a MESMA que a ingestão usa para gravar o bloqueio,
 * e é o ponto: enquanto eram duas, o runtime era o lado calibrado e a ingestão
 * bloqueava paciente que só perguntou como parar a dor.
 *
 * Aqui vale o nível PROVÁVEL (inequívoco + ambíguo), e não o inequívoco: este
 * sinal só para de responder e escala à inbox — não silencia ninguém para
 * sempre. Quem tem esse poder é a pessoa que confirma o bloqueio no CRM.
 */
export function detectAmbiguousOptOut(message: string): boolean {
  return ehOptOutProvavel(message);
}

/**
 * NO-OP de runs futuros (acceptance 2): o lead está em handoff quando force_human está
 * setado no contato OU alguma conversa dele ainda está silenciada (bot_silenced_until no
 * futuro — 'infinity' sempre vale). Lido no INÍCIO do turno, antes de qualquer chamada
 * de modelo. Só o humano (via CRM) libera.
 */
export async function isLeadInHandoff(db: pg.Pool, tenantId: string, leadId: string): Promise<boolean> {
  const { rows } = await db.query<{ handoff: boolean }>(
    `select (
       c.force_human
       or exists (
         select 1 from conversations v
         where v.organization_id = $1 and v.contact_id = c.id
           and v.bot_silenced_until is not null and v.bot_silenced_until > now()
       )
     ) as handoff
     from contacts c
     where c.organization_id = $1 and c.id = $2`,
    [tenantId, leadId],
  );
  return rows[0]?.handoff === true;
}

export interface HandoffIds {
  tenantId: string;
  leadId: string;
  /** conversations.id — a conversa que transiciona para a fila humana. */
  conversationId: string;
}

/**
 * Executa o handoff (idempotente, at-least-once) — tudo no banco do CRM, sem transporte.
 * Re-executar no mesmo episódio é no-op semântico: force_human/silêncio já setados, o
 * CASE do status não pisa em estado humano (claimed/closed) e o inbox deduplica.
 */
export async function performHumanHandoff(
  db: pg.Pool,
  ids: HandoffIds,
  opts: {
    reason: string;
    conversationSummary: string;
    inboxTitle?: string;
    /**
     * O desfecho do aviso que o chamador mandou ao lead ANTES desta passagem
     * (`avisarLeadDaEscalacao`). Opcional porque nem todo chamador é o motor de
     * conversa — o "Assumir eu" de um caso é acionado por uma pessoa que já está
     * na conversa e fala por si.
     *
     * Quando presente, ele vira LINHA no aviso da Central. A pergunta que o
     * atendente faz ao abrir a conversa é "essa pessoa sabe que estou vindo?", e
     * a resposta muda a primeira frase que ele digita. Falhar fechado na ação,
     * aberto na informação.
     */
    avisoAoLead?: { avisado: boolean; porque?: string };
    log: Logger;
  },
): Promise<void> {
  // (a) FONTE DA VERDADE: force_human no contato — irrevogável pelo agente (regra dura 2).
  await guardServiceEffect();
  await db.query(`update contacts set force_human = true where organization_id = $1 and id = $2`, [
    ids.tenantId,
    ids.leadId,
  ]);

  // (b) Conversa: silencia o bot para sempre e devolve à fila humana. O status SÓ
  // transiciona 'ai_handling'→'pending' — conversa já claimed/closed/pending fica como
  // está (nunca rouba do humano nem reabre encerrada). Fase 3: junto, zera a aderência
  // ao agente do router — se o bot for reativado, o router decide de novo (não reassume
  // o mesmo agente por inércia).
  await guardServiceEffect();
  await db.query(
    `update conversations
        set status = case when status = 'ai_handling' then 'pending' else status end,
            bot_silenced_until = $3,
            last_handoff_at = now(),
            last_handoff_reason = $4,
            active_ai_agent_id = null,
            active_intent = null,
            active_agent_set_at = null
      where organization_id = $1 and id = $2`,
    [ids.tenantId, ids.conversationId, SILENCE_INFINITY, opts.reason],
  );

  // (c) Cancela os crons PENDENTES do lead (follow-ups agendados — F3-01/02). Idempotente,
  // via o cancel compartilhado (mesma garantia que o opt-out irrevogável usa — F4-07).
  await guardServiceEffect();
  await cancelPendingCronsForLead(db, ids.tenantId, ids.leadId);

  // (d) inbox de escalação com o resumo da conversa. Dedup por episódio ABERTO (mesmo padrão
  // do escalateJailbreakPromise): 2× no mesmo handoff aberto → 1 item.
  //
  // Try/catch porque o inbox é o ALERTA — sem ele a conversa fica na fila mas
  // invisível para a equipe (medido em produção 2026-09-12: handoff aplicado com
  // sucesso, status=pending correto, mas zero item na Central). O handoff em si
  // já aconteceu (force_human + silêncio); perder o inbox não pode desfazer isso.
  try {
    await guardServiceEffect();
    const result = await db.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       select $1, 'handoff', 'critical', $2, $3, 'contact', $4
       where not exists (
         select 1 from agent_inbox_items
         where organization_id = $1 and kind = 'handoff' and ref_kind = 'contact' and ref_id = $4 and status = 'open'
       )`,
      [
        ids.tenantId,
        opts.inboxTitle ?? 'Handoff humano solicitado — assumir a conversa',
        `Motivo: ${opts.reason}. ${linhaDoAviso(opts.avisoAoLead)}Resumo da conversa até aqui:\n${opts.conversationSummary}`,
        ids.leadId,
      ],
    );
    if (result.rowCount === 0) {
      opts.log.warn('handoff: inbox item não criado (dedup ou race)', {
        conversation_id: ids.conversationId,
        lead_id: ids.leadId,
        reason: opts.reason,
      });
    }
  } catch (err) {
    opts.log.warn('handoff: inbox item falhou — conversa na fila mas sem alerta na Central', {
      conversation_id: ids.conversationId,
      lead_id: ids.leadId,
      reason: opts.reason,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
  }

  // (e) A IDA na linha do tempo do NEGÓCIO. `triggerHandoff` (o caminho do CRM)
  // já gravava `handoff_triggered`; este caminho — o do harness e o do "Assumir
  // eu" dos casos — não gravava nada. Metade das passagens era invisível no
  // dossiê do cliente, e quem lesse a timeline veria a volta sem a ida.
  //
  // O `reason` é FIXO de propósito: `opts.reason` pode ser o texto livre que o
  // atendente escreveu ao escalar, e esta linha aparece na tela e no export de
  // LGPD (regra do activity-emitter: o porquê é legível, sem PII).
  //
  // Try/catch porque a timeline não pode derrubar a operação que ela descreve —
  // mesma disciplina fire-and-forget do emissor da API.
  try {
    const roteou = await emitAgentActivityForContact({
      pool: db,
      organizationId: ids.tenantId,
      contactId: ids.leadId,
      type: 'handoff_triggered',
      sourceModule: 'human-handoff',
      sourceId: ids.conversationId,
      reason: 'Atendimento passado para uma pessoa',
      payload: { conversation_id: ids.conversationId },
    });
    if (!roteou.routed) {
      opts.log.warn('handoff: atividade não roteada para um negócio', { reason: roteou.reason });
    }
  } catch (err) {
    opts.log.warn('handoff: atividade da passagem não foi gravada', {
      error: err instanceof Error ? err.message.slice(0, 200) : 'erro desconhecido',
    });
  }

  // PII fora do log: só ids/motivo — nunca o resumo da conversa (regra dura 8).
  opts.log.info('handoff humano aplicado (force_human + silêncio + crons cancelados + inbox)', {
    reason: opts.reason,
  });
}

/**
 * A linha do aviso da Central que responde "essa pessoa sabe que estou vindo?".
 *
 * Ausente = o chamador não mandou aviso nenhum (caminho acionado por uma pessoa),
 * e aí o silêncio é honesto: nada a afirmar. Presente e falso = o cliente está
 * esperando SEM SABER, e o atendente precisa abrir a conversa se apresentando.
 */
function linhaDoAviso(aviso: { avisado: boolean; porque?: string } | undefined): string {
  if (aviso === undefined) return '';
  if (aviso.avisado) return 'O cliente JÁ FOI avisado de que uma pessoa vai assumir. ';
  return `⚠️ O cliente NÃO foi avisado (${aviso.porque ?? 'motivo desconhecido'}) — ele está esperando sem saber. `;
}

/** Whitelist EXATA do payload da tool (mesmo padrão .strict() da F2-10/F3-02). */
export const requestHumanHandoffInputSchema = z.strictObject({
  reason: z.string().min(1).max(500).optional(),
});

const PAYLOAD_TEACHING =
  'Campo aceito: reason (por que passar ao humano) — opcional, nada além. Lead, organização e ' +
  'conversa vêm do runtime, nunca do payload da tool.';

export type RequestHumanHandoffResult =
  | { ok: true; status: 'handoff_solicitado'; message: string }
  | { ok: false; error: { code: 'invalid_payload'; message: string } };

/**
 * Wrapper da tool request_human_handoff exposta ao modelo. Valida o payload e delega a
 * performHumanHandoff. Erros de DB (ex.: lead sumiu) sobem — o tool wrapper do run os
 * captura e ensina o modelo a encerrar (padrão F2-09).
 */
export async function applyRequestHumanHandoff(
  db: pg.Pool,
  ids: HandoffIds,
  opts: {
    conversationSummary: string;
    /** Ver `performHumanHandoff` — o desfecho do aviso vira linha no aviso da Central. */
    avisoAoLead?: { avisado: boolean; porque?: string };
    log: Logger;
  },
  rawInput: unknown,
): Promise<RequestHumanHandoffResult> {
  const forbidden = findForbiddenKey(rawInput);
  if (forbidden !== null) {
    return { ok: false, error: { code: 'invalid_payload', message: `campos não reconhecidos: ${forbidden}. ${PAYLOAD_TEACHING}` } };
  }
  const parsed = requestHumanHandoffInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: { code: 'invalid_payload', message: `payload inválido em request_human_handoff (${zodIssuesSummary(parsed.error)}). ${PAYLOAD_TEACHING}` } };
  }

  await performHumanHandoff(db, ids, {
    reason: parsed.data.reason ?? 'requested_human',
    conversationSummary: opts.conversationSummary,
    ...(opts.avisoAoLead !== undefined ? { avisoAoLead: opts.avisoAoLead } : {}),
    log: opts.log,
  });

  // ACH-03: a expectativa vai JUNTO com a confirmação. Antes, a mensagem afirmava
  // que "um atendente vai assumir" sem que ninguém tivesse olhado se havia
  // alguém — e o agente repassava essa promessa ao cliente. Agora a resposta
  // carrega o estado real da equipe, e o modelo não precisa lembrar de perguntar.
  const { frase } = await expectativaDeAtendimento(db, ids.tenantId, new Date());

  // ⚠️ A frase anterior era "encerre o turno AGORA, sem enviar mais mensagens ao
  // lead além do aviso" — e prometia uma saída que a PRIMEIRA linha de
  // `performHumanHandoff` acabou de fechar: `force_human = true` arma o
  // `stopGate`, que veta todo envio seguinte. O modelo que obedecesse ao "além
  // do aviso" mandaria uma mensagem que morre no gate, e o lead ficaria mudo.
  // Agora a mensagem AFIRMA o que é verdade: o aviso ou já foi dele, antes da
  // chamada, ou foi do sistema — em nenhum dos casos há uma fala a mais.
  const jaAvisado =
    opts.avisoAoLead === undefined || opts.avisoAoLead.avisado
      ? 'O lead JÁ foi avisado de que uma pessoa vai assumir.'
      : 'ATENÇÃO: não foi possível avisar o lead (o canal recusou a mensagem); a equipe foi alertada disso.';

  return {
    ok: true,
    status: 'handoff_solicitado',
    message:
      `Handoff humano acionado; a conversa saiu do atendimento automático. ${jaAvisado} ${frase} ` +
      'Encerre o turno AGORA — você não consegue mais enviar mensagens a este lead.',
  };
}

/**
 * Resumo curto da conversa para o inbox de escalação — a partir do checkpoint durável
 * (compromissos/objeções/próxima ação/resumo). Vai ao inbox (PARA o humano), nunca a log.
 */
export function buildHandoffSummary(
  previous: {
    commitments: string[];
    objections: string[];
    next_action: string | null;
    rolling_summary: string;
    /**
     * A declaração do último turno (spec 16 §5). Opcional na assinatura porque
     * chamador antigo (e checkpoint gravado antes da coluna existir) não a tem —
     * ausência degrada para o resumo de hoje, nunca quebra o handoff.
     */
    declaracao?: DeclaracaoDoTurno | null;
  } | null,
): string {
  if (previous === null) {
    return 'Sem resumo acumulado ainda (conversa recente) — abra a conversa no CRM para o contexto completo.';
  }
  const parts: string[] = [];
  if (previous.rolling_summary.trim() !== '') parts.push(previous.rolling_summary.trim());
  // A declaração vem ANTES dos campos antigos de propósito: quem assume uma
  // conversa no meio precisa primeiro do que a pessoa quer e do que foi
  // prometido a ela — é o que decide a próxima frase que ele vai digitar.
  // Compromissos e objeções acumulados são contexto, não ação imediata.
  const declarado = renderDeclaracaoParaHumano(previous.declaracao ?? null);
  if (declarado !== '') parts.push(declarado);
  if (previous.commitments.length > 0) parts.push(`Compromissos: ${previous.commitments.join('; ')}`);
  if (previous.objections.length > 0) parts.push(`Objeções: ${previous.objections.join('; ')}`);
  if (previous.next_action) parts.push(`Próxima ação: ${previous.next_action}`);
  return parts.length === 0
    ? 'Sem resumo acumulado ainda (conversa recente) — abra a conversa no CRM para o contexto completo.'
    : parts.join('\n');
}
