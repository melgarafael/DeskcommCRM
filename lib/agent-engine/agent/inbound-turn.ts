/**
 * Loop do agente v0 — handler do job `inbound_turn` (F2-09; blueprint 8.8).
 *
 * Cada job vira uma sessão FRESCA do motor LLM (via seam F2-23 — provider
 * instanciado POR CHAMADA, nunca cache por lead em memória de processo): TODO o
 * estado do run (seq de envio, outcomes, mensagens) vive no closure desta
 * invocação — isolamento entre leads por construção (acceptance 3).
 *
 * Ritual imposto pelo RUNTIME, não pelo modelo:
 *   1. abre lendo playbook (system, por ponteiro — F2-07) + checkpoint anterior de
 *      `lead_checkpoints` (compromissos/objeções/next_action + rolling summary) +
 *      `lead_state` (estágio do funil — F2-10) + últimas N mensagens via
 *      get_lead_context (F2-08);
 *   2. o modelo decide tools livremente: `get_lead_context` (releitura),
 *      `send_message` — enviar é SEMPRE tool call (CLAUDE.md princípio 2); texto
 *      direto do modelo NUNCA vira mensagem (é descartado) — e `update_lead_state`
 *      (F2-10): o modelo MARCA avanços; a máquina de estados no código valida e o
 *      avanço é espelhado no CRM (crm_move_lead_stage); falha do espelho NÃO
 *      reverte o harness (fonte da verdade) — vira log + inbox_items;
 *   3. fecha com uma 2ª chamada de modelo (purpose 'checkpoint') que devolve
 *      SOMENTE o JSON do checkpoint, validado por Zod e persistido — mecanismo
 *      escolhido por ser imposto pelo runtime (tool update_checkpoint dependeria
 *      de o modelo lembrar de chamá-la; a chamada de fechamento sempre acontece).
 *
 * Falhas: transporte/tool do CRM viram mensagem de ensino pro modelo no meio do
 * run (padrão F2-08) E erro do job no fim (retry da fila com o ledger segurando
 * duplicata); veto is_blocked cancela o job em definitivo (JobSettledError —
 * main.ts não completa nem re-tenta). PII nunca entra em log/erro de job.
 */
import type pg from 'pg';
import { z } from 'zod';
import type { ChannelAdapter, ChannelSendResult } from '../channel-adapter';

import { withFields, type Logger } from '../obs/logger';
import { getLeadContext, type LeadContext, type LeadContextResult } from '../edge/crm/get-lead-context';
import type { CrmEdgeConfig } from '../edge/crm/mcp-client';
import { WahaChannelAdapter } from '../edge/channel/waha-adapter';
// applySendOutcome é disposição de FILA (cancel/reschedule + cache de opt-out), não
// egress de canal — o envio em si vai pelo adapter (ChannelAdapter). Ver F2-25.
import { applySendOutcome } from '../edge/crm/send-message';
import {
  runModelCall,
  tool,
  type LlmEdgeConfig,
  type ModelMessage,
  type ToolSet,
} from '../edge/llm/run-model-call';
import type { ProviderRegistry } from '../edge/llm/providers';
import { mirrorLeadStageToCrm } from '../edge/crm/move-lead-stage';
import { insertInboxItem } from '../db/repository';
import type { JobRow, Queryable } from '../queue/queue';
import { applyLeadStateUpdate, getLeadState, type LeadStage, type LeadStateRow } from './lead-state';
import { applySaveLeadNote, buildNotesIndexBlock, getLeadNoteBody } from './lead-notes';
import { applyScheduleFollowup, type FollowupWindowKnobs } from './schedule-followup';
import {
  applyRequestHumanHandoff,
  buildHandoffSummary,
  detectAmbiguousOptOut,
  detectHumanHandoffRequest,
  isLeadInHandoff,
  performHumanHandoff,
} from './human-handoff';
import { maybeCompact, renderCompactedSummary, trimTranscriptToBudget, type CompactionKnobs } from './compaction';
import { pruneToolResults, type PruneToolResultsKnobs } from './prune-tool-results';
import {
  classifyStage,
  recordStageDivergenceCandidate,
  renderStageHint,
  type StageClassifierKnobs,
} from './stage-classifier';
import { loadPlaybook } from './playbook';
import { loadPublishedAgentConfig, matchesHandoffKeyword } from './agent-config';
import { buildMcpTurnTools } from '../edge/crm/mcp-tools';
import { cancelPendingCronsForLead } from '../cron/scheduler';
import {
  latestInboundSignal,
  loadSkills,
  matchSkills,
  recordSkillMissCandidates,
  renderMatchedSkillBodies,
  renderSkillIndex,
} from './skills';
import { wrapToolsWithBreaker, type ToolBreakerThresholds } from './tool-breaker';
import { runBeforeSend } from '../guardrails/before-send';
import type { DisclosureMode } from '../guardrails/disclosure/template';
import { decidePromise } from '../guardrails/promise/engine';
import { loadPromiseTable } from '../guardrails/promise/table';
import { classifyPromise } from '../guardrails/promise/semantic';
import {
  JAILBREAK_ESCALATION_LEVEL,
  classifyJailbreak,
  escalateJailbreakPromise,
  type JailbreakClassifierKnobs,
  type JailbreakLevel,
} from '../guardrails/jailbreak/classifier';

/**
 * Registro EXPLÍCITO das tools do run SEM efeito colateral — só elas entram no
 * modo idempotent_no_progress do breaker (F2-15). send_message e
 * update_lead_state são MUTANTES e ficam fora por construção, não por heurística.
 */
export const READ_ONLY_TOOLS = ['get_lead_context', 'get_lead_note'] as const;

/**
 * Superfície ESTÁTICA das tools do agente (description + inputSchema) — parte do
 * prefixo estável de cache (F2-17). Única fonte: o handler monta as tools reais
 * daqui (+ execute do closure) e `scripts/ops-count-prefix.ts` mede o prefixo
 * real sem precisar de um run. Nada volátil entra aqui, por construção.
 */
export const AGENT_TOOL_DEFS = {
  get_lead_context: {
    description:
      'Relê o contexto curado do lead nesta organização: dados do contato e as últimas mensagens da conversa.',
    inputSchema: z.object({}),
  },
  send_message: {
    description:
      'Envia UMA mensagem de WhatsApp ao lead desta conversa. É o ÚNICO jeito de falar com o lead; texto fora desta tool nunca é enviado.',
    inputSchema: z.object({
      body: z.string().min(1).describe('corpo da mensagem, em pt-br, pronto para envio'),
    }),
  },
  update_lead_state: {
    description:
      'Marca um avanço REAL no funil deste lead: stage (new → contacted → qualifying → qualified → ' +
      'negotiating → won | lost; só o PRÓXIMO estágio válido — regressão é rejeitada), qualification ' +
      '(budget/authority/need/timeline), next_action e reason (evidência curta do avanço). ' +
      'Nunca invente avanço sem evidência na conversa.',
    // Schema LARGO só para o SDK (o modelo vê os campos); a validação REAL é a
    // whitelist .strict() dentro de applyLeadStateUpdate — campo extra/forjado
    // vira erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    inputSchema: z.object({
      stage: z.string().optional().describe('novo estágio do funil (só o próximo válido)'),
      qualification: z.object({}).passthrough().optional().describe('qualificação: budget, authority, need, timeline'),
      next_action: z.string().nullable().optional().describe('próxima ação concreta combinada com o lead'),
      reason: z.string().optional().describe('evidência curta do avanço (vai ao audit do CRM)'),
    }).passthrough(),
  },
  schedule_followup: {
    description:
      'Agenda o SEU próprio retorno a este lead num momento futuro (follow-up). Use sempre que ' +
      'prometer voltar a falar depois (ex.: "te retorno amanhã de manhã", "confirmo na segunda"). ' +
      'Um agendamento por promessa; o sistema fará o follow-up sozinho no horário combinado — ' +
      'depois de agendar, encerre o turno.',
    // Schema LARGO para o SDK (o modelo vê os campos); a validação REAL é a whitelist
    // .strict() + guard de prototype pollution dentro de applyScheduleFollowup — campo
    // extra/forjado e data inválida viram erro de ENSINO ao modelo, nunca exceção do SDK.
    inputSchema: z.object({
      reason: z.string().describe('por que agendar o retorno'),
      promised_at: z.string().describe('data/hora ISO 8601 do retorno (no futuro), ex.: "2026-07-15T14:00:00Z"'),
      promise: z.string().describe('o que você prometeu ao lead'),
      context_snapshot: z.string().nullable().optional().describe('contexto curto para o seu run futuro'),
    }).passthrough(),
  },
  save_lead_note: {
    description:
      'Salva uma nota DURÁVEL na memória deste lead (persiste entre conversas). Use para fatos que ' +
      'você vai querer lembrar depois: preferências, contexto pessoal, restrições, o que já foi ' +
      'oferecido. A headline (linha curta) entra sempre no índice de memória do lead; o corpo completo ' +
      'fica guardado e você o relê sob demanda com get_lead_note. Para CONSOLIDAR notas antigas, ' +
      'liste os ids delas em "supersedes" (você os vê no índice) — elas são removidas ao salvar a nova.',
    // Schema LARGO para o SDK (o modelo vê os campos); a validação REAL é a whitelist
    // .strict() + guard de prototype pollution dentro de applySaveLeadNote — campo
    // extra/forjado vira erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    inputSchema: z.object({
      headline: z.string().describe('linha curta do índice (sempre visível no prompt)'),
      body: z.string().describe('corpo completo da nota (lido sob demanda por get_lead_note)'),
      supersedes: z
        .array(z.string())
        .optional()
        .describe('ids de notas que esta substitui/consolida (vistos no índice de memória)'),
    }).passthrough(),
  },
  get_lead_note: {
    description:
      'Lê o CORPO completo de UMA nota da memória deste lead pelo id (o id aparece no índice de memória, ' +
      'entre colchetes). Use quando a headline no índice não bastar e você precisar do detalhe.',
    inputSchema: z.object({
      note_id: z.string().describe('id da nota (como aparece no índice, entre colchetes)'),
    }).passthrough(),
  },
  request_human_handoff: {
    description:
      'Passa a conversa para um ATENDENTE HUMANO imediatamente. Use quando o lead pedir para falar com ' +
      'uma pessoa, quando a situação exigir alguém humano (reclamação séria, questão jurídica/financeira ' +
      'sensível) ou quando você atingir o limite do que pode resolver. Depois de acionar, o bot silencia ' +
      'para este lead — encerre o turno sem enviar mais mensagens.',
    // Schema LARGO para o SDK (o modelo vê o campo); a validação REAL é a whitelist .strict()
    // + guard de prototype pollution dentro de applyRequestHumanHandoff — campo extra/forjado
    // vira erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    inputSchema: z.object({
      reason: z.string().optional().describe('por que passar ao humano (curto)'),
    }).passthrough(),
  },
} as const;

/**
 * Job já saiu de 'running' por decisão do próprio run (ex.: cancelJob no veto
 * is_blocked) — o worker NÃO deve completar nem re-tentar. main.ts trata via
 * failJob, que no-opa (lease já não é dele) — estado final é o que o run deixou.
 */
export class JobSettledError extends Error {
  override readonly name = 'job_settled';
}

// Shape que o drain (F2-05) grava no payload do job — organization/lead vêm da
// ROW do job (fonte confiável), nunca daqui; o payload só carrega ponteiros do CRM.
const inboundTurnPayloadSchema = z
  .object({
    conversation_id: z.string().uuid(),
    contact_id: z.string().uuid(),
    channel_session_id: z.string().uuid(),
    inbound_message_id: z.string().uuid(),
    crm_event_id: z.string().uuid(),
  })
  .passthrough();

/** Conteúdo do checkpoint — o modelo devolve, o Zod valida, o Postgres guarda. */
export const checkpointContentSchema = z.object({
  commitments: z.array(z.string()).default([]),
  objections: z.array(z.string()).default([]),
  next_action: z.string().nullable().default(null),
  rolling_summary: z.string().default(''),
});
export type CheckpointContent = z.infer<typeof checkpointContentSchema>;

export interface LeadCheckpointRow extends CheckpointContent {
  id: string;
  seq: string;
  organization_id: string;
  contact_id: string;
  job_id: string | null;
  created_at: Date;
}

/** Instrução FIXA do fechamento — o runtime a impõe; o teste a usa como marcador. */
export const CHECKPOINT_INSTRUCTION =
  'Feche o turno AGORA. Responda SOMENTE com um JSON válido no formato ' +
  '{"commitments": string[], "objections": string[], "next_action": string|null, "rolling_summary": string} ' +
  '— compromissos assumidos, objeções do lead, próxima ação e o resumo acumulado ' +
  'da conversa até aqui (inclua o que o resumo anterior já dizia). Sem texto fora do JSON.';

export interface InboundTurnKnobs {
  /** últimas N mensagens no contexto de abertura (LEAD_CONTEXT_HISTORY_LIMIT) */
  historyLimit: number;
  /** teto do payload do contexto (LEAD_CONTEXT_MAX_TOKENS) */
  maxContextTokens: number;
  /** orçamento fixo do índice de notas do lead injetado no sufixo (LEAD_NOTES_INDEX_MAX_TOKENS) */
  notesIndexMaxTokens: number;
  /** teto de steps do loop de tools por run (AGENT_MAX_STEPS) — circuit breaker fino é F2-15 */
  maxSteps: number;
  /** atraso do reagendamento em veto/queued herdado da F2-06 (SEND_QUEUED_RETRY_MS) */
  queuedRetryDelayMs: number;
  /** circuit breaker de tools por run (F2-15) — env TOOL_BREAKER_* */
  breaker: ToolBreakerThresholds;
  /**
   * Janela aceitável do follow-up agendado pela tool schedule_followup (F3-02).
   * Ausente = a tool NÃO é oferecida ao modelo neste run (main.ts sempre a preenche
   * pelos knobs do env; testes que não exercitam a tool a omitem sem custo).
   */
  followup?: FollowupWindowKnobs;
  /**
   * Compaction + flush pré-compaction (F3-07). Ausente = desligada (o turno usa o
   * transcript cru, capado por get_lead_context) — main.ts sempre a preenche pelos
   * knobs do env; testes que não a exercitam a omitem sem custo.
   */
  compaction?: CompactionKnobs;
  /**
   * Pruning de tool results antigos (F3-10). Ausente = desligado (as responseMessages do
   * run seguem íntegras na chamada de fechamento) — main.ts sempre o preenche pelos knobs
   * do env; testes que não o exercitam o omitem sem custo.
   */
  prune?: PruneToolResultsKnobs;
  /**
   * Skills situacionais (F3-09): diretório onde os near-misses de matching viram
   * candidatos ao golden set (GOLDEN_CANDIDATES_DIR). Ausente = misses NÃO gravados (o
   * matching + injeção de corpo seguem valendo) — main.ts sempre o preenche pelo env;
   * testes injetam um dir TEMP e nunca o golden real (freeze do tree).
   */
  goldenCandidatesDir?: string;
  /**
   * Stage-classifier por turno (F3-11; SalesGPT). Ausente = classificador NÃO roda (o
   * turno segue sem hint de estágio) — main.ts sempre o preenche pelo env; testes que não
   * o exercitam o omitem sem custo. A DIVERGÊNCIA classificador×modelo é gravada em
   * goldenCandidatesDir (mesmo dir da F3-09) — só se ele estiver configurado.
   */
  stageClassifier?: StageClassifierKnobs;
  /**
   * Classifier anti-jailbreak no inbound do lead (F4-04; advisório). Ausente = NÃO roda (o
   * turno segue sem flag) — main.ts sempre o preenche pelo env; testes que não o exercitam o
   * omitem sem custo. Flag ALTA + tentativa de promessa fora de tabela (F4-01) no MESMO turno
   * escala para inbox_items (dedup por episódio).
   */
  jailbreak?: JailbreakClassifierKnobs;
  /**
   * Modo do gate de disclosure (F4-05; DISCLOSURE_MODE): 'inject' (default — o disclosure é
   * sempre adicionado à 1ª mensagem) ou 'veto' (bloqueia + ensina). Ausente = default 'inject'
   * do runBeforeSend. main.ts sempre o preenche pelo env.
   */
  disclosureMode?: DisclosureMode;
  /**
   * Camada SEMÂNTICA de promessa (F4-02) na cadeia before_send (gate 5 da ordem final F4-08).
   * Ausente = camada NÃO roda (o gate fica no-op) — testes que não a exercitam a omitem; main.ts
   * a preenche pelo env (PROMISE_SEMANTIC_*). `enabled=false` também mantém o gate no-op.
   * CUSTO: com enabled, é UMA chamada de modelo auxiliar POR TENTATIVA DE ENVIO (não por turno).
   */
  promiseSemantic?: { enabled: boolean; model?: string };
}

export interface InboundTurnDeps {
  crmCfg: CrmEdgeConfig;
  llmCfg: LlmEdgeConfig;
  knobs: InboundTurnKnobs;
  log: Logger;
  /** testes: registry com provider fake — produção usa o default do seam */
  registry?: ProviderRegistry;
  /**
   * Seam de canal (F2-25): fábrica do ChannelAdapter para o pool do job. Default =
   * WAHA-via-CRM (o único adapter da v1). Trocar o adapter (ex.: Cloud API) NÃO
   * muda este handler — prova em daemon/test/channel-adapter.test.ts.
   */
  channel?: (pool: pg.Pool) => ChannelAdapter;
  /**
   * Relógio injetável (F2-13) — a janela horária do gate anti-ban é avaliada nele.
   * Default `() => new Date()`; os testes fixam um instante dentro da janela para
   * determinismo.
   */
  clock?: () => Date;
  /**
   * Espera do throttle da cadeia before_send (F2-13) — injetável só para teste.
   * Default = sleep real (runBeforeSend cai em `realSleep`). O E2E de fase (F2-18)
   * passa um spy que registra o waitMs sem esperar de verdade: torna o espaçamento
   * anti-ban observável no artefato de trace de forma determinística.
   */
  sleep?: (ms: number) => Promise<void>;
}

/** Checkpoint mais recente do lead — a memória que atravessa sessões. */
export async function latestCheckpoint(
  db: Queryable,
  tenantId: string,
  leadId: string,
): Promise<LeadCheckpointRow | null> {
  const { rows } = await db.query<LeadCheckpointRow>(
    `select * from lead_checkpoints
     where organization_id = $1 and contact_id = $2
     order by seq desc
     limit 1`,
    [tenantId, leadId],
  );
  return rows[0] ?? null;
}

async function insertCheckpoint(
  db: Queryable,
  input: { tenantId: string; leadId: string; jobId: string; content: CheckpointContent },
): Promise<void> {
  await db.query(
    `insert into lead_checkpoints (organization_id, contact_id, job_id, commitments, objections, next_action, rolling_summary)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.tenantId,
      input.leadId,
      input.jobId,
      JSON.stringify(input.content.commitments),
      JSON.stringify(input.content.objections),
      input.content.next_action,
      input.content.rolling_summary,
    ],
  );
}

/**
 * Extrai e valida o JSON do fechamento. Tolerante a cerca de código e prosa em
 * volta (pega do primeiro '{' ao último '}'); inválido → erro SEM o texto do
 * modelo na mensagem (pode carregar PII da conversa) — o job re-tenta.
 */
export function parseCheckpointText(text: string): CheckpointContent {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('fechamento do turno sem JSON de checkpoint — run re-tentado pela fila');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('JSON de checkpoint inválido no fechamento do turno — run re-tentado pela fila');
  }
  const parsed = checkpointContentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.code}`).join('; ');
    throw new Error(`checkpoint do fechamento com shape inválido (${issues}) — run re-tentado pela fila`);
  }
  return parsed.data;
}

/**
 * Blocos do ritual de abertura (pt-br: é a língua do agente), compartilhados entre
 * o turno inbound e o follow-up (F3-03) — checkpoint + resumo + estado do funil +
 * contexto curado. Só o CABEÇALHO e o RODAPÉ mudam entre os dois tipos de turno.
 */
export function ritualBlocks(
  previous: LeadCheckpointRow | null,
  leadState: LeadStateRow | null,
  context: LeadContext,
  notesIndexBlock: string,
): string[] {
  const checkpointBlock = previous
    ? JSON.stringify({
        commitments: previous.commitments,
        objections: previous.objections,
        next_action: previous.next_action,
      })
    : 'primeiro turno — sem checkpoint anterior';
  const summaryBlock = previous?.rolling_summary ? previous.rolling_summary : '—';
  // slot previsto na F2-09, preenchido pela F2-10: estado do funil no ritual de
  // abertura — sem registro ainda, o lead está em "new" (default da 0008).
  const stateBlock = leadState
    ? JSON.stringify({
        stage: leadState.stage,
        qualification: leadState.qualification,
        next_action: leadState.next_action,
      })
    : 'sem registro — o lead está em "new"';
  return [
    '## Checkpoint anterior (compromissos, objeções, próxima ação)',
    checkpointBlock,
    '',
    '## Resumo acumulado da conversa',
    summaryBlock,
    '',
    '## Estado do funil (lead_state)',
    stateBlock,
    '',
    // Índice da memória durável do lead (F3-05): headlines + id, orçamento fixo. O
    // corpo vem sob demanda (get_lead_note). Injetado AQUI, no SUFIXO — depois do
    // prefixo cacheável (F2-17), como o bloco temporal da F3-03.
    '## Memória do lead (índice de notas — corpo sob demanda via get_lead_note)',
    notesIndexBlock,
    '',
    '## Contexto do lead (contato + últimas mensagens)',
    JSON.stringify(context),
  ];
}

/** Abertura determinística do run inbound — o ritual em texto (pt-br). */
function buildOpeningMessage(
  previous: LeadCheckpointRow | null,
  leadState: LeadStateRow | null,
  context: LeadContext,
  notesIndexBlock: string,
): string {
  return [
    'Novo turno de atendimento: o lead enviou uma mensagem (a última inbound do histórico abaixo).',
    '',
    ...ritualBlocks(previous, leadState, context, notesIndexBlock),
    '',
    'Responda ao lead usando a tool send_message — NUNCA escreva a resposta como texto direto',
    '(texto fora de tool é descartado pelo runtime). Use get_lead_context se precisar reler o contexto.',
    'Houve avanço REAL no funil neste turno? Marque-o com update_lead_state (só o próximo estágio válido).',
    'Aprendeu algo durável sobre o lead? Salve com save_lead_note (a headline entra no índice de memória).',
  ].join('\n');
}

/**
 * Parâmetros do run que DIFEREM entre inbound (F2-09) e follow-up (F3-03): os ids
 * de envio (de fonte confiável — payload do drain no inbound, row do lead no
 * follow-up, nunca do payload do modelo) e a montagem da mensagem de abertura,
 * chamada DEPOIS do ritual de leitura (o follow-up injeta o bloco temporal aqui,
 * no SUFIXO — depois do prefixo cacheável, sem invalidar o cache F2-17).
 */
export interface AgentTurnInput {
  /** número (channel_sessions.id do CRM) — chave da serialização anti-ban do envio. */
  channelSessionId: string;
  /** conversa do CRM — destino do send_message. */
  conversationId: string;
  /** monta a abertura APÓS o ritual de leitura (inbound vs. bloco temporal do follow-up). */
  buildOpening: (ritual: {
    previous: LeadCheckpointRow | null;
    leadState: LeadStateRow | null;
    context: LeadContext;
    /** índice da memória do lead (F3-05), já dentro do orçamento; vai no sufixo. */
    notesIndexBlock: string;
  }) => string;
}

/**
 * Núcleo do run do agente, compartilhado por inbound_turn (F2-09) e followup_turn
 * (F3-03): ritual de abertura, loop de tools, fechamento com checkpoint e veto. Não
 * guarda NADA entre invocações — sessão fresca por job (todo estado no closure). O
 * que varia entre os dois tipos de turno vem em `input` (AgentTurnInput).
 */
export async function runAgentTurn(
  deps: InboundTurnDeps,
  job: JobRow,
  pool: pg.Pool,
  ctx: { workerId: string },
  input: AgentTurnInput,
): Promise<void> {
  const tenantId = job.organization_id;
  const leadId = job.contact_id;
  if (leadId === null) {
    throw new Error('job de turno sem contact_id — o CHECK da fila deveria impedir');
  }
  const contextKnobs = { historyLimit: deps.knobs.historyLimit, maxTokens: deps.knobs.maxContextTokens };
  // Contexto do RUN em toda linha de log do turno (F2-16): job_id É o run id.
  const runLog = withFields(deps.log, { job_id: job.id, tenant_id: tenantId, lead_id: leadId });

  // F4-06 (acceptance 2): lead em handoff humano → NO-OP no INÍCIO do turno, antes de
  // qualquer chamada de modelo/CRM. O bot silenciou (bot_silenced_until='infinity', cache
  // do force_human do CRM) e só o humano/CRM libera — o agente nunca reassume (regra dura 2).
  if (await isLeadInHandoff(pool, tenantId, leadId)) {
    runLog.info('turno pulado — lead em handoff humano (bot silenciado)', { kind: job.kind });
    return;
  }

  // Fase 2B: config do agente por PONTEIRO PUBLICADO (tela ai/agents) — lida a
  // cada turno, zero cache; org/sessão da row do job (fonte confiável). null =
  // sem agente publicado p/ esta sessão → fallback (playbook + settings + env).
  const agentConfig = await loadPublishedAgentConfig(pool, tenantId, input.channelSessionId);
  if (agentConfig !== null) {
    runLog.info('config do agente publicada em uso', {
      agent_id: agentConfig.agentId,
      agent_version_id: agentConfig.versionId,
      model: agentConfig.model,
    });
  }
  // Knobs por-turno: a versão publicada vence o env; sem ela, env (main.ts).
  const maxSteps = agentConfig?.maxSteps ?? deps.knobs.maxSteps;
  // Fallback de modelo das chamadas AUXILIARES (classificadores/compaction/promessa):
  // knob de env → modelo do agente PUBLICADO na tela → organizations.settings.llm.
  // Sem isso, self-host que configurou tudo pela tela (que não preenche default_model)
  // morria no primeiro classificador: "modelo LLM não definido".
  const agentModel = agentConfig?.model;
  const turnContextKnobs =
    agentConfig !== null
      ? { historyLimit: agentConfig.historyMessageWindow, maxTokens: deps.knobs.maxContextTokens }
      : contextKnobs;

  // Ritual de abertura: playbook por ponteiro + checkpoint + contexto curado.
  // Com agente publicado, o system_prompt DELE é a camada tenant (platform de
  // compliance continua à frente, sempre).
  const playbook = await loadPlaybook(
    pool,
    tenantId,
    agentConfig !== null ? { agentLayer: agentConfig.systemPrompt } : undefined,
  );
  // Skills situacionais (F3-09): índice (name+description) SEMPRE residente — vai junto do
  // system do playbook, no prefixo estável org-wide (disclosure progressivo; cacheável F2-17).
  // O CORPO só carrega no match, no sufixo por-lead (mais abaixo). loadSkills resolve os
  // ponteiros a cada run: trocar/rollback de skill = mover o ponteiro, sem restart.
  const skills = await loadSkills(pool, tenantId);
  const skillIndex = renderSkillIndex(skills);
  const system =
    skillIndex === ''
      ? playbook.prompt
      : `${playbook.prompt}\n\n=== skills (índice — o corpo carrega no turno quando a situação dispara) ===\n${skillIndex}`;
  const previous = await latestCheckpoint(pool, tenantId, leadId);
  const leadState = await getLeadState(pool, tenantId, leadId);
  const openingContext = await getLeadContext(
    pool,
    deps.crmCfg,
    { tenantId, leadId, conversationId: input.conversationId },
    turnContextKnobs,
  );
  if (!openingContext.ok) {
    // Sem contexto não há turno: transiente (CRM fora) OU permanente (lead
    // sumiu) — ambos re-tentam pela fila e morrem em 'dead' se persistirem.
    throw new Error(`abertura do turno falhou em get_lead_context (${openingContext.error.code})`);
  }

  // F4-06 (acceptance 1): detecção DETERMINÍSTICA (regex PT-BR, sem LLM) de pedido explícito
  // de atendimento humano na última mensagem do lead. Handoff é cidadão de 1ª classe (exigência
  // Meta fiscalizada, blueprint 5.5) — dispara ANTES do modelo: o bot silencia sem gastar LLM,
  // sem enviar. A ação (CRM force_human + cache + cancela crons + inbox) é idempotente.
  const inboundSignal = latestInboundSignal(openingContext.context.messages);
  if (
    detectHumanHandoffRequest(inboundSignal) ||
    (agentConfig !== null && matchesHandoffKeyword(inboundSignal, agentConfig.handoffKeywords))
  ) {
    await performHumanHandoff(
      pool,
      { tenantId, leadId, conversationId: input.conversationId },
      { reason: 'requested_human', conversationSummary: buildHandoffSummary(previous), log: runLog },
    );
    runLog.info('handoff humano acionado por pedido explícito do lead (detecção determinística)', {
      kind: job.kind,
    });
    return; // bot silencia: sem modelo, sem envio neste turno
  }

  // F4-07: STOP AMBÍGUO ("para de me mandar isso", "não quero mais receber", "me tira da
  // lista", ou a palavra-chave STOP/PARAR/SAIR sozinha). Detecção CONSERVADORA — na dúvida
  // é STOP: o bot silencia JÁ (sem LLM, sem envio) via o MESMO mecanismo durável do handoff
  // (bot_silenced_until='infinity', que SOBREVIVE à leitura do CRM que sobrescreve o cache
  // is_opted_out) e escala à inbox para o humano confirmar o opt-out real (is_blocked) no
  // CRM. Cancela os follow-ups agendados de tabela. Nada disso reverte (regra dura nº 2).
  if (detectAmbiguousOptOut(latestInboundSignal(openingContext.context.messages))) {
    await performHumanHandoff(
      pool,
      { tenantId, leadId, conversationId: input.conversationId },
      {
        reason: 'suspected_optout',
        conversationSummary: buildHandoffSummary(previous),
        inboxTitle: 'Suspeita de opt-out — confirmar bloqueio do contato no CRM',
        log: runLog,
      },
    );
    runLog.info('possível opt-out detectado no inbound — bot silenciado e escalado ao humano', {
      kind: job.kind,
    });
    return; // bot silencia: sem modelo, sem envio neste turno
  }

  // F3-07: compaction + flush pré-compaction. Quando o histórico cresce além do limiar,
  // o FLUSH grava as notas duráveis (lead_notes) e a compaction resume a conversa com o
  // modelo BARATO; o resumo compactado entra no lugar do rolling summary e o transcript
  // integral é trocado por uma cauda recente sob orçamento (regra de cache 15). O rolling
  // summary DURÁVEL segue vindo do checkpoint de fechamento; aqui ele só alimenta o prompt.
  let effectivePrevious = previous;
  let effectiveContext = openingContext.context;
  if (deps.knobs.compaction !== undefined) {
    const compacted = await maybeCompact(
      pool,
      deps.llmCfg,
      { tenantId, leadId, jobId: job.id },
      {
        context: openingContext.context,
        previousSummary: previous?.rolling_summary ?? '',
        knobs: {
          ...deps.knobs.compaction,
          ...(deps.knobs.compaction.model === undefined && agentModel !== undefined
            ? { model: agentModel }
            : {}),
        },
        notesIndexMaxTokens: deps.knobs.notesIndexMaxTokens,
      },
      { registry: deps.registry, log: runLog },
    );
    if (compacted !== null) {
      // Só o rolling_summary é sobrescrito (o resumo compactado carrega compromissos/
      // objeções/estágio/dados pessoais planificados). O `previous` sintético do 1º
      // turno com histórico importado é local — nunca persistido; o fechamento grava o
      // checkpoint real.
      const base: LeadCheckpointRow =
        previous ??
        {
          id: '',
          seq: '0',
          organization_id: tenantId,
          contact_id: leadId,
          job_id: null,
          created_at: new Date(),
          commitments: [],
          objections: [],
          next_action: null,
          rolling_summary: '',
        };
      effectivePrevious = { ...base, rolling_summary: renderCompactedSummary(compacted) };
      effectiveContext = {
        ...openingContext.context,
        messages: trimTranscriptToBudget(openingContext.context.messages, deps.knobs.compaction.transcriptMaxTokens),
      };
    }
  }

  // Índice da memória durável do lead (F3-05) — headlines dentro do orçamento fixo,
  // injetado no SUFIXO da abertura (não invalida o prefixo cacheável F2-17). Montado
  // DEPOIS do flush (F3-07) para que as notas gravadas neste turno já entrem no índice.
  const notesIndexBlock = await buildNotesIndexBlock(pool, tenantId, leadId, deps.knobs.notesIndexMaxTokens);
  // Observabilidade da memória (Fase 2A): SÓ ids/contagens no log — headline/corpo
  // são PII e nunca saem do prompt. Prova auditável de que a memória durável do
  // lead entrou no contexto DESTE turno.
  {
    const { rows: noteIdRows } = await pool.query<{ id: string }>(
      'select id from lead_notes where organization_id = $1 and contact_id = $2 order by created_at',
      [tenantId, leadId],
    );
    runLog.info('memória do lead injetada no turno', {
      checkpoint_seq: effectivePrevious?.seq ?? null,
      notes_count: noteIdRows.length,
      note_ids: noteIdRows.map((r) => r.id),
    });
  }

  // Seam de canal (F2-25): o envio vai SÓ pela interface ChannelAdapter — o
  // default WAHA-via-CRM envolve o sink F2-06. Instanciado por job (o pool é
  // per-job neste codebase); trocar o adapter não muda nada abaixo.
  // Fase 2B: o envio carrega o ai_agents.id REAL como ator (audit/metadata do
  // CRM apontam o agente publicado, não um id genérico).
  const turnCrmCfg =
    agentConfig !== null ? { ...deps.crmCfg, agentActorId: agentConfig.agentId } : deps.crmCfg;
  const channel = (deps.channel ?? ((p: pg.Pool) => new WahaChannelAdapter(p, turnCrmCfg)))(pool);
  const clock = deps.clock ?? ((): Date => new Date());
  // STOP lido no turno (fonte: CRM via get_lead_context) — combinado com o cache
  // durável leads.is_opted_out no gate 1 da cadeia (F2-13).
  const optedOutThisTurn = openingContext.context.contact.is_blocked;
  // LGPD (F4-09): base legal/anonimização do CRM lidas na abertura do turno (fonte confiável,
  // regra dura nº 1) — o gate LGPD da cadeia veta anonimizado (sempre) e 1º toque de prospecção
  // sem base legal. Resposta a inbound (isProspecting=false) não dispara o veto de base legal.
  const lgpd = openingContext.lgpd;

  // F4-07: STOP no CRM detectado no turno → cancela TODOS os follow-ups agendados do lead
  // (não só o job atual). O stopGate já veta ESTE turno; o cancel garante que nenhum cron
  // futuro dispare em vão (opt-out irrevogável, regra dura nº 2). Idempotente — reusa o
  // cancel compartilhado com o handoff (F4-06).
  if (optedOutThisTurn) {
    const canceled = await cancelPendingCronsForLead(pool, tenantId, leadId);
    if (canceled > 0) {
      runLog.info('opt-out detectado no turno — follow-ups agendados cancelados', { canceled });
    }
  }

  // Estado do RUN — vive só neste closure (isolamento por construção, acc 3).
  let seq = 0;
  // F3-11: estágio que o MODELO confirmou via update_lead_state neste turno (a máquina
  // F2-10 é a única porta). Comparado com a sugestão do classificador no fim → divergência.
  let confirmedStage: LeadStage | null = null;
  // F4-04: a tabela de promessa versionada do tenant (F4-01), carregada uma vez para
  // correlacionar tentativa de promessa fora de tabela com o sinal de jailbreak — a
  // detecção NÃO depende do gate estar na cadeia default (a ordem final é da F4-08).
  const promiseTable = (await loadPromiseTable(pool, tenantId))?.table ?? null;
  // Gate 5 da cadeia (F4-02/F4-08): closure do classificador semântico com tenant/lead/job da
  // ROW do job fechados dentro (regra dura nº 1) — resolvido pelo seam agnóstico. undefined =
  // camada off (gate no-op). CUSTO: uma chamada de modelo POR ENVIO quando ligada.
  const semanticClassifier =
    deps.knobs.promiseSemantic?.enabled === true
      ? (candidate: string) =>
          classifyPromise(
            pool,
            deps.llmCfg,
            { tenantId, leadId, jobId: job.id },
            {
              candidate,
              ...((deps.knobs.promiseSemantic?.model ?? agentModel) !== undefined
                ? { model: (deps.knobs.promiseSemantic?.model ?? agentModel) as string }
                : {}),
            },
            { ...(deps.registry !== undefined ? { registry: deps.registry } : {}), log: runLog },
          )
      : undefined;
  let outOfTablePromiseAttempted = false;
  const outcomes: ChannelSendResult[] = [];
  let runError: Error | null = null;
  const noteRunError = (err: Error): void => {
    runError ??= err;
  };

  const rawTools: ToolSet = {
    get_lead_context: tool({
      ...AGENT_TOOL_DEFS.get_lead_context,
      execute: async (): Promise<LeadContextResult | { ok: false; error: { code: string; message: string } }> => {
        try {
          return await getLeadContext(
            pool,
            deps.crmCfg,
            { tenantId, leadId, conversationId: input.conversationId },
            turnContextKnobs,
          );
        } catch (err) {
          // bug de programação: ensina o modelo a encerrar E derruba o job no fim
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao ler o contexto — encerre o turno agora.' },
          };
        }
      },
    }),
    send_message: tool({
      ...AGENT_TOOL_DEFS.send_message,
      execute: async ({ body }) => {
        // F4-04: sinaliza (independente do gate F4-01/F4-08) se ESTA candidata é uma
        // promessa fora de tabela — usado só para correlacionar com o jailbreak no fim do
        // turno. A detecção é determinística (decidePromise); sem tabela do tenant = no-op.
        if (promiseTable !== null && !decidePromise({ candidate: body, table: promiseTable }).allow) {
          outOfTablePromiseAttempted = true;
        }
        // Cadeia de guardrails (F2-13): stop/opt-out → anti-ban → spinning rodam
        // AQUI, entre a decisão do modelo e o adapter. Se um gate veta, o
        // channel.send NÃO acontece e a razão volta ao modelo como erro instrutivo;
        // seq só avança quando o envio é de fato tentado (gate veto não gasta seq
        // — preserva o alinhamento (job_id, seq) do ledger F2-06 entre re-runs).
        try {
          const chain = await runBeforeSend({
            pool,
            log: runLog,
            tenantId,
            leadId,
            jobId: job.id,
            channelSessionId: input.channelSessionId,
            body,
            optedOutThisTurn,
            // ponytail: channel_sessions.daily_message_limit do CRM ainda não é lido
            // no runtime — null cai nos degraus de warm-up (conservadores). Injetar
            // aqui quando o drain expuser o limite da sessão.
            crmDailyLimit: null,
            now: clock(),
            sleep: deps.sleep,
            lgpd,
            ...(deps.knobs.disclosureMode !== undefined ? { disclosureMode: deps.knobs.disclosureMode } : {}),
            // Gate 5 (F4-02): classificador semântico roteado pelo MESMO seam agnóstico (budget
            // da org checado nele). Closure com tenant/lead/job da ROW fechados — nunca do payload.
            ...(semanticClassifier !== undefined ? { classifyPromiseSemantic: semanticClassifier } : {}),
            // `finalBody` = corpo após a cadeia (o disclosureGate F4-05 pode prependar o
            // disclosure via inject); é ELE que vai ao canal, não o `body` capturado da tool.
            send: (finalBody) => {
              seq += 1;
              return channel.send({
                tenantId,
                leadId,
                jobId: job.id,
                seq,
                conversationId: input.conversationId,
                body: finalBody,
              });
            },
          });
          if (chain.status === 'vetoed') {
            // Erro de ENSINO pt-br (mesmo shape de get_lead_context/breaker): o
            // modelo o vê no turno seguinte. NÃO é exceção — não derruba o run.
            return { ok: false, error: { code: chain.code, message: chain.message } };
          }
          const outcome = chain.outcome;
          outcomes.push(outcome);
          switch (outcome.kind) {
            case 'sent':
            case 'already_sent':
              return { ok: true, status: 'enviada', message_id: outcome.messageId };
            case 'queued':
              return {
                ok: true,
                status: 'aceita_aguardando_canal',
                message:
                  'o canal aceitou a mensagem e vai enviá-la quando a sessão voltar — não reenvie.',
              };
            case 'blocked':
              return {
                ok: false,
                error: {
                  code: 'contato_bloqueado',
                  message:
                    'o contato optou por não receber mensagens (bloqueio irrevogável) — não envie mais nada e encerre o turno.',
                },
              };
            case 'failed':
              return {
                ok: false,
                error: {
                  code: 'envio_falhou',
                  message: 'o canal falhou ao enviar — não tente de novo neste turno; o sistema fará retry.',
                },
              };
            case 'unavailable':
              // transiente (transporte/tool do canal): ensina o modelo a parar; o
              // job re-tenta com a MESMA idempotency_key (ledger ficou 'requested').
              noteRunError(new Error(`canal indisponível no envio (${outcome.reason}) — job re-tentado pela fila`));
              return {
                ok: false,
                error: {
                  code: 'envio_indisponivel',
                  message: 'não consegui enviar agora (canal indisponível) — encerre o turno; o sistema re-tentará.',
                },
              };
          }
        } catch (err) {
          // bug de programação no adapter: ensina o modelo a encerrar E derruba o job.
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno no envio — encerre o turno agora.' },
          };
        }
      },
    }),
    update_lead_state: tool({
      ...AGENT_TOOL_DEFS.update_lead_state,
      execute: async (raw) => {
        try {
          const update = await applyLeadStateUpdate(pool, { tenantId, leadId, jobId: job.id }, raw);
          if (!update.ok) {
            return update; // erro de ensino (payload fora da whitelist / transição inválida)
          }
          if (update.transition !== null) {
            // Espelho no CRM (surrogates). Falha NUNCA reverte o harness (fonte
            // da verdade do funil) nem falha o job: humano resolve via inbox_items;
            // 'not_configured' (tenant sem pareamento/mapa) é só warn — espelho
            // deliberadamente desligado não é incidente.
            const mirror = await mirrorLeadStageToCrm(pool, deps.crmCfg, {
              tenantId,
              leadId,
              toStage: update.transition.to,
              ...(update.transition.reason !== undefined ? { reason: update.transition.reason } : {}),
            });
            if (!mirror.ok) {
              runLog.warn('espelho de stage no CRM falhou — harness mantido', {
                to_stage: update.transition.to,
                reason: mirror.reason,
              });
              if (mirror.reason !== 'not_configured') {
                await insertInboxItem(pool, tenantId, {
                  kind: 'other',
                  title: 'Espelho de stage no CRM falhou — funil possivelmente inconsistente',
                  body: `lead_state avançou para "${update.transition.to}" no harness, mas crm_move_lead_stage falhou (${mirror.reason}: ${mirror.detail}). Reconcilie o stage no CRM manualmente.`,
                  refKind: 'lead',
                  refId: leadId,
                });
              }
            }
          }
          // F3-11: o estágio que o modelo confirmou (a máquina F2-10 gravou) — base da
          // comparação com a sugestão do classificador no fechamento do run.
          confirmedStage = update.state.stage;
          return { ok: true, status: 'estado_atualizado', stage: update.state.stage, message: update.message };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: {
              code: 'internal_error',
              message: 'erro interno ao atualizar o estado do lead — encerre o turno agora.',
            },
          };
        }
      },
    }),
    // F3-05: memória durável por lead. save_lead_note é MUTANTE (fora de
    // READ_ONLY_TOOLS); tenant/lead vêm da ROW do job (closure), nunca do payload.
    // Hard cap do índice imposto AQUI na escrita (applySaveLeadNote) — estouro vira
    // ensino pedindo consolidação, sem gravar (padrão Hermes).
    save_lead_note: tool({
      ...AGENT_TOOL_DEFS.save_lead_note,
      execute: async (raw) => {
        try {
          const res = await applySaveLeadNote(
            pool,
            { tenantId, leadId },
            { budgetTokens: deps.knobs.notesIndexMaxTokens },
            raw,
          );
          if (!res.ok) {
            return res; // ensino (payload fora da whitelist / orçamento do índice estourado)
          }
          return { ok: true, status: 'nota_salva', superseded: res.superseded, message: res.message };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao salvar a nota — encerre o turno agora.' },
          };
        }
      },
    }),
    // get_lead_note é READ-ONLY: relê o corpo de UMA nota do lead pelo id (sob demanda —
    // o índice só traz headline). Escopado por (tenant, lead) do closure.
    get_lead_note: tool({
      ...AGENT_TOOL_DEFS.get_lead_note,
      execute: async ({ note_id }) => {
        try {
          const noteId = note_id.trim();
          const body = noteId === '' ? null : await getLeadNoteBody(pool, tenantId, leadId, noteId);
          if (body === null) {
            return {
              ok: false,
              error: {
                code: 'note_not_found',
                message: 'não há nota com esse id na memória deste lead — confira o id no índice de memória.',
              },
            };
          }
          return { ok: true, note_id: noteId, body };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao ler a nota — encerre o turno agora.' },
          };
        }
      },
    }),
    // F4-06: handoff humano acionado pelo PRÓPRIO modelo (cidadão de 1ª classe). MUTANTE
    // (seta force_human no CRM + cancela crons + inbox), fora de READ_ONLY_TOOLS. tenant/
    // lead/conversation vêm da ROW do job (closure), nunca do payload do modelo.
    request_human_handoff: tool({
      ...AGENT_TOOL_DEFS.request_human_handoff,
      execute: async (raw) => {
        try {
          const res = await applyRequestHumanHandoff(
            pool,
            { tenantId, leadId, conversationId: input.conversationId },
            { conversationSummary: buildHandoffSummary(previous), log: runLog },
            raw,
          );
          if (!res.ok) return res; // erro de ensino (payload fora da whitelist)
          return { ok: true, status: res.status, message: res.message };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao acionar o handoff humano — encerre o turno agora.' },
          };
        }
      },
    }),
  };

  // F3-02: a tool de agendamento (schedule_followup) só entra quando sua janela
  // está configurada — main.ts sempre a preenche pelos knobs do env; tenant/lead
  // vêm da ROW do job (closure), nunca do payload do modelo. É MUTANTE (cria
  // cron_job), por isso fica fora de READ_ONLY_TOOLS.
  const followupKnobs = deps.knobs.followup;
  if (followupKnobs !== undefined) {
    rawTools.schedule_followup = tool({
      ...AGENT_TOOL_DEFS.schedule_followup,
      execute: async (raw) => {
        try {
          const res = await applyScheduleFollowup(pool, { clock, knobs: followupKnobs }, { tenantId, leadId }, raw);
          if (!res.ok) {
            return res; // erro de ensino (payload / data no passado / fora da janela)
          }
          return { ok: true, status: 'agendado', agendado_para: res.promisedAt.toISOString(), message: res.message };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao agendar o retorno — encerre o turno agora.' },
          };
        }
      },
    });
  }

  // Fase 2B: a tela pode DESLIGAR a tool de handoff do modelo (a detecção
  // determinística de pedido de humano continua ativa — guardrail nunca sai).
  if (agentConfig !== null && !agentConfig.handoffToolEnabled) {
    delete rawTools.request_human_handoff;
  }

  // 2B-tools: tools do catálogo MCP habilitadas NA TELA entram no run (audit +
  // role/scope da ponte nativa; envio e handoff do catálogo são bloqueados —
  // ver edge/crm/mcp-tools.ts). As 7 tools do engine têm precedência de nome.
  let mcpCleanup: (() => Promise<void>) | null = null;
  if (agentConfig !== null && agentConfig.toolIds.length > 0) {
    try {
      const mcp = await buildMcpTurnTools(deps.crmCfg, { organizationId: tenantId, jobId: job.id }, agentConfig, runLog);
      if (mcp !== null) {
        mcpCleanup = mcp.cleanup;
        for (const [name, mcpTool] of Object.entries(mcp.tools)) {
          if (!(name in rawTools)) rawTools[name] = mcpTool;
        }
        runLog.info('tools MCP da tela montadas no turno', { mcp_tool_ids: mcp.toolIds });
      }
    } catch (err) {
      // Tool extra é privilégio, não invariante: falha no mint/montagem NÃO
      // derruba o turno — o run segue com as tools do engine e o humano vê o log.
      runLog.error('tools MCP da tela não montadas — turno segue sem elas', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      });
    }
  }

  // Circuit breaker de tools (F2-15): estado no closure DESTA invocação — zera
  // entre runs por construção (mesma garantia de isolamento do resto do run).
  const tools = wrapToolsWithBreaker(rawTools, {
    thresholds: deps.knobs.breaker,
    readOnlyTools: READ_ONLY_TOOLS,
    log: runLog, // os warns dos gates do breaker saem carimbados com o run
  });

  // Guideline-matching if-then (F3-09): o SINAL do turno (última mensagem inbound) decide
  // quais skills disparam. Corpos casados vão no SUFIXO da abertura (situacional, por-lead —
  // depois do prefixo cacheável); situação neutra ⇒ nenhum corpo (economia de tokens). Os
  // near-misses (probe sem hard-match) viram candidatos ao golden set, gravados por fs em
  // runtime (não a tool Write) — só se o dir estiver configurado.
  const skillSignal = latestInboundSignal(effectiveContext.messages);
  const skillMatch = matchSkills(skills, skillSignal);
  const matchedSkillsBlock = renderMatchedSkillBodies(skillMatch.matched);
  if (deps.knobs.goldenCandidatesDir !== undefined) {
    await recordSkillMissCandidates(
      deps.knobs.goldenCandidatesDir,
      { tenantId, leadId, jobId: job.id, signal: skillSignal, candidates: skillMatch.missCandidates },
      runLog,
    );
  }

  // F3-11: stage-classifier auxiliar. Roda ANTES do turno (modelo BARATO pelo seam
  // agnóstico) e sugere o estágio; a sugestão entra como HINT no SUFIXO por-lead — o modelo
  // do agente decide e confirma via update_lead_state (a máquina F2-10 é a única porta). A
  // sugestão fica guardada para comparar com o que o modelo confirmou (divergência, no fim).
  const currentStage: LeadStage = leadState?.stage ?? 'new';
  let stageSuggestion: LeadStage | null = null;
  let stageHintBlock = '';
  if (deps.knobs.stageClassifier !== undefined) {
    stageSuggestion = await classifyStage(
      pool,
      deps.llmCfg,
      { tenantId, leadId, jobId: job.id },
      {
        context: effectiveContext,
        currentStage,
        ...((deps.knobs.stageClassifier.model ?? agentModel) !== undefined
          ? { model: (deps.knobs.stageClassifier.model ?? agentModel) as string }
          : {}),
      },
      { registry: deps.registry, log: runLog },
    );
    if (stageSuggestion !== null) {
      stageHintBlock = renderStageHint(stageSuggestion, currentStage);
    }
  }

  // F4-04: classifier ADVISÓRIO anti-jailbreak sobre a mensagem INBOUND do lead (o
  // skillSignal já é a última inbound). Roda pelo seam agnóstico (modelo BARATO, budget
  // checado nele). NÃO veta o inbound — só FLAGRA o turno no trace; flag/level não são PII
  // (a mensagem/reason nunca vão a log). A correlação com promessa fora de tabela escala no fim.
  let jailbreakLevel: JailbreakLevel = 'none';
  if (deps.knobs.jailbreak !== undefined) {
    const verdict = await classifyJailbreak(
      pool,
      deps.llmCfg,
      { tenantId, leadId, jobId: job.id },
      {
        message: skillSignal,
        ...((deps.knobs.jailbreak.model ?? agentModel) !== undefined
          ? { model: (deps.knobs.jailbreak.model ?? agentModel) as string }
          : {}),
      },
      { registry: deps.registry, log: runLog },
    );
    jailbreakLevel = verdict.level;
    if (verdict.flag) {
      // trace do turno: só flag/level (não PII) — a mensagem e o reason nunca são logados.
      runLog.warn('jailbreak: sinal detectado na mensagem do lead', {
        jailbreak_flag: true,
        jailbreak_level: verdict.level,
      });
    }
  }

  const openingBase = input.buildOpening({
    previous: effectivePrevious,
    leadState,
    context: effectiveContext,
    notesIndexBlock,
  });
  // Sufixos por-lead (situacionais, voláteis — depois do prefixo cacheável F2-17): corpos de
  // skill casadas (F3-09) + hint do classificador (F3-11). Vazios são omitidos.
  const openingSuffixes = [matchedSkillsBlock, stageHintBlock].filter((b) => b !== '');
  const openingMessages: ModelMessage[] = [
    {
      role: 'user',
      content: openingSuffixes.length === 0 ? openingBase : `${openingBase}\n\n${openingSuffixes.join('\n\n')}`,
    },
  ];

  // O modelo decide tools livremente dentro do teto de steps (knob AGENT_MAX_STEPS).
  const turn = await runModelCall(
    pool,
    deps.llmCfg,
    {
      tenantId,
      leadId,
      jobId: job.id,
      purpose: 'agent_turn',
      system,
      messages: openingMessages,
      tools,
      maxSteps,
      ...(agentConfig !== null
        ? {
            model: agentConfig.model,
            llmOverride: { provider: agentConfig.provider, credentialId: agentConfig.credentialId },
          }
        : {}),
    },
    { registry: deps.registry, log: runLog },
  );

  // F4-04: correlação dos dois sinais do MESMO turno — jailbreak ALTO + tentativa de
  // promessa fora de tabela (F4-01). Ambos estão determinados aqui (o jailbreak rodou na
  // abertura; as tentativas de envio já passaram pelo loop). Dispara escalação humana em
  // inbox_items (dedup por episódio). Advisório: o classifier sozinho nunca escala — o gate
  // determinístico é que confirma a promessa indevida. Feito antes do runError/veto para
  // não se perder num turno que falha o envio depois.
  if (jailbreakLevel === JAILBREAK_ESCALATION_LEVEL && outOfTablePromiseAttempted) {
    const created = await escalateJailbreakPromise(pool, { tenantId, leadId, level: jailbreakLevel });
    if (created > 0) {
      runLog.warn('jailbreak: escalação humana criada (flag alta + promessa fora de tabela no turno)', {
        jailbreak_level: jailbreakLevel,
      });
    }
  }

  if (runError !== null) {
    throw runError; // job falha → retry da fila; o ledger segura duplicata de envio
  }
  if (outcomes.some((o) => o.kind === 'failed')) {
    // ponytail: retry re-roda o run inteiro (LLM incluso); seq N re-encontra a
    // linha do ledger — 'accepted' pula, 'failed' rotaciona a key (F2-06).
    throw new Error('envio marcado como failed pelo CRM — run re-tentado pela fila');
  }

  // F3-10: poda os tool results antigos da fita do run ANTES de reenviá-los no fechamento
  // (é onde a fita inteira é re-serializada num prompt) — o conteúdo durável já foi para
  // lead_notes pelo flush (F3-07), então o stub não perde nada recuperável. Opera SÓ no
  // sufixo por-lead, nunca no prefixo estável (regra de cache 15).
  const responseMessages =
    deps.knobs.prune !== undefined
      ? pruneToolResults(turn.result.response.messages, deps.knobs.prune)
      : turn.result.response.messages;

  // Fechamento imposto pelo runtime: 2ª chamada, mesma conversa, só o checkpoint.
  const closing = await runModelCall(
    pool,
    deps.llmCfg,
    {
      tenantId,
      leadId,
      jobId: job.id,
      purpose: 'checkpoint',
      ...(agentConfig !== null
        ? {
            model: agentConfig.model,
            llmOverride: { provider: agentConfig.provider, credentialId: agentConfig.credentialId },
          }
        : {}),
      system,
      messages: [
        ...openingMessages,
        ...responseMessages,
        { role: 'user', content: CHECKPOINT_INSTRUCTION },
      ],
    },
    { registry: deps.registry, log: runLog },
  );
  const content = parseCheckpointText(closing.result.text);
  await insertCheckpoint(pool, { tenantId, leadId, jobId: job.id, content });

  // F3-11: divergência classificador×modelo. O classificador sugeriu um estágio; se o
  // modelo confirmou (via update_lead_state — a máquina F2-10) um estágio DIFERENTE, o
  // desacordo vira candidato ao golden set (fs em runtime — reuso do dir da F3-09). Sem
  // sugestão, sem confirmação, ou concordância ⇒ nenhum arquivo (zero divergência).
  if (
    deps.knobs.goldenCandidatesDir !== undefined &&
    stageSuggestion !== null &&
    confirmedStage !== null &&
    stageSuggestion !== confirmedStage
  ) {
    await recordStageDivergenceCandidate(
      deps.knobs.goldenCandidatesDir,
      {
        tenantId,
        leadId,
        jobId: job.id,
        signal: skillSignal,
        divergence: { suggested: stageSuggestion, confirmed: confirmedStage },
      },
      runLog,
    );
  }

  const blocked = outcomes.find((o) => o.kind === 'blocked');
  if (blocked !== undefined) {
    // veto permanente (regra dura nº 2): cancela o job e cacheia o opt-out —
    // depois do checkpoint (o artefato do turno fica registrado mesmo em veto).
    await applySendOutcome(
      pool,
      blocked,
      { jobId: job.id, workerId: ctx.workerId, tenantId, leadId },
      { queuedRetryDelayMs: deps.knobs.queuedRetryDelayMs },
    );
    throw new JobSettledError(
      'turno encerrado com veto do sink (is_blocked) — job cancelado em definitivo, checkpoint gravado',
    );
  }

  await mcpCleanup?.();

  runLog.info('turno do agente concluído', {
    kind: job.kind,
    messages_sent: outcomes.length,
    model: turn.model,
  });
}

/**
 * Handler de `inbound_turn` para o registry do daemon (main.ts): o lead mandou uma
 * mensagem. Ids de envio vêm do payload do drain (fonte confiável — F2-05); a
 * abertura é o ritual padrão, sem bloco temporal.
 */
export function createInboundTurnHandler(deps: InboundTurnDeps) {
  return async (job: JobRow, pool: pg.Pool, ctx: { workerId: string }): Promise<void> => {
    const payload = inboundTurnPayloadSchema.parse(job.payload);
    await runAgentTurn(deps, job, pool, ctx, {
      channelSessionId: payload.channel_session_id,
      conversationId: payload.conversation_id,
      buildOpening: ({ previous, leadState, context, notesIndexBlock }) =>
        buildOpeningMessage(previous, leadState, context, notesIndexBlock),
    });
  };
}
