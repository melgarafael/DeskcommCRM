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
import { auxModelArgs, type AuxModelArgs } from './aux-model-args';
import type { ChannelAdapter, ChannelSendResult } from '../channel-adapter';

import { withFields, type Logger } from '../obs/logger';
import { getLeadContext, type LeadContext, type LeadContextResult } from '../edge/crm/get-lead-context';
import { citationsFromHits, searchKnowledge } from './search-knowledge';
import type { CrmEdgeConfig } from '../edge/crm/mcp-client';
import { WahaChannelAdapter } from '../edge/channel/waha-adapter';
// applySendOutcome é disposição de FILA (cancel/reschedule + cache de opt-out), não
// egress de canal — o envio em si vai pelo adapter (ChannelAdapter). Ver F2-25.
import { applySendOutcome } from '../edge/crm/send-message';
import {
  LlmBudgetExceededError,
  runModelCall,
  tool,
  type LlmEdgeConfig,
  type ModelMessage,
  type ToolSet,
} from '../edge/llm/run-model-call';
import type { ProviderRegistry } from '../edge/llm/providers';
import { HANDOFF_REASON_ORCAMENTO } from '../edge/llm/orcamento';
import { MIRROR_WARN_ONLY, mirrorLeadStageToCrm } from '../edge/crm/move-lead-stage';
import { insertInboxItem } from '../db/repository';
import { createAdminClient } from '@/lib/supabase/admin';
import { moverLeadParaEtapaDeHandoff } from '@/lib/leads/handoff-stage-move';
import { detectUrgencySignal } from '../guardrails/sinal-de-urgencia';
import { buildNativeMediaParts } from './media-parts';
import { enqueueJob, rescheduleJob, type JobRow, type Queryable } from '../queue/queue';
import { applyLeadStateUpdate, getLeadState, type LeadStage, type LeadStateRow } from './lead-state';
import { applySaveLeadNote, buildNotesIndexBlock, getLeadNoteBody } from './lead-notes';
import { buildCompromissosBlock } from './compromissos-do-contato';
import { applyScheduleFollowup, type FollowupWindowKnobs } from './schedule-followup';
import {
  avisarLeadDaEscalacao,
  avisarLeadLendoOContato,
  type DesfechoDoAviso,
} from './aviso-de-escalacao';
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
import { DECLARACAO_INSTRUCTION, declaracaoDoTurnoSchema, promessasEmAberto, type DeclaracaoDoTurno } from './declaracao';
import { projetarContexto, projetarRetornoDeTool, turnoProjeta, type ContextoProjetado } from './projecao';
import { capacidadesEntreguesAoOperador, catalogoEntregueAoOperador } from './entrega-de-capacidade';
import { composeSystemPrompt, loadOrgMemory, renderOrgMemory } from './org-memory';
import { matchesHandoffKeyword } from './agent-config';
import { msAteAJanelaAbrir } from './janela-de-atendimento';
import { janelaDeEnvioAberta, proximaAberturaDaJanela } from '../pacing/engine';
import { loadChannelKnobs } from '../pacing/store';
import { avisarJanelaFechada, resolverAvisoDeJanela } from '../pacing/aviso-de-janela';
import { resolveTurnAgent } from './resolve-turn-agent';
import {
  hasOpenCaseForContact,
  getCaseAwaitingLead,
  openCase,
  provideCaseUpdate,
  openHumanCaseInputSchema,
  provideCaseUpdateInputSchema,
} from './human-cases';
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
import { readSkillReference, skillHasReferences } from './skill-references';
import { READ_ONLY_TOOLS, wrapToolsWithBreaker, type ToolBreakerThresholds } from './tool-breaker';
import { loadChannelProvider, runBeforeSend } from '../guardrails/before-send';
import { isStatusSendable } from '../../channels/meta/template-binding';
import { capabilitiesOf } from '@/lib/channels/capabilities';
import { renderTemplateBody } from '@/lib/channels/meta/render-template';
import { sendInBubbles } from './split-message';
import type { DisclosureMode } from '../guardrails/disclosure/template';
import { decidePromise } from '../guardrails/promise/engine';
import { loadPromiseTable } from '../guardrails/promise/table';
import { classifyPromise } from '../guardrails/promise/semantic';
import { expectativaDeAtendimento } from '@/lib/escalacao/disponibilidade';
import { diffCheckpoint } from '@/lib/leads/checkpoint-diff';
import { emitAgentActivityForContact } from '@/lib/leads/agent-activity';
import { resolveActiveLeadForContact, type LeadCandidate } from '@/lib/leads/active-lead';
import { recalculaScoreDoLead } from '@/lib/leads/score-writer';
import {
  JAILBREAK_ESCALATION_LEVEL,
  classifyJailbreak,
  escalateJailbreakPromise,
  type JailbreakClassifierKnobs,
  type JailbreakLevel,
} from '../guardrails/jailbreak/classifier';
import { camadaLigada, lerCamadasDaOrg } from '../guardrails/camadas-da-org';
import { fusoDaOrganizacao } from './fuso-da-org';
import { renderAgora } from '@/lib/tempo/agora';
import { decidirElegibilidadeDaConversa } from '@/lib/ai/elegibilidade/consulta-pg';

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
  search_knowledge: {
    description:
      'Busca na BASE DE CONHECIMENTO da organização (FAQ, políticas, catálogo) os trechos mais ' +
      'relevantes para uma pergunta. Use ANTES de responder qualquer dúvida factual sobre produto, ' +
      'preço, prazo, política ou funcionamento — responda com base nos trechos retornados e não ' +
      'invente o que não encontrar. Sem resultados = diga que vai confirmar, nunca chute.',
    inputSchema: z.object({
      query: z.string().min(2).describe('a pergunta ou termos a buscar, em pt-br'),
    }).passthrough(),
  },
  request_human_handoff: {
    description:
      'Passa a conversa para um ATENDENTE HUMANO imediatamente. Use quando o lead pedir para falar com ' +
      'uma pessoa, quando a situação exigir alguém humano (reclamação séria, questão jurídica/financeira ' +
      'sensível) ou quando você atingir o limite do que pode resolver. ' +
      'AVISE O LEAD ANTES: mande uma mensagem dizendo que você vai chamar alguém da equipe e SÓ ENTÃO ' +
      'chame esta ferramenta — depois dela você não consegue mais falar com ele. Se você não avisar, ' +
      'o sistema manda um aviso padrão no seu lugar. Acionada a ferramenta, encerre o turno. ' +
      'NUNCA diga ao lead que "já chamei alguém" ou "já passei para a equipe" sem ter chamado esta ' +
      'ferramenta NO MESMO turno — a frase no passado não substitui a ação, e ninguém é avisado de verdade.',
    // Schema LARGO para o SDK (o modelo vê o campo); a validação REAL é a whitelist .strict()
    // + guard de prototype pollution dentro de applyRequestHumanHandoff — campo extra/forjado
    // vira erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    inputSchema: z.object({
      reason: z.string().optional().describe('por que passar ao humano (curto)'),
    }).passthrough(),
  },
  read_skill_reference: {
    description:
      'Lê o conteúdo de UMA reference (arquivo de apoio) do pacote de uma skill situacional que já ' +
      'CASOU neste turno. Use quando o corpo da skill ativa mencionar uma reference e você precisar do ' +
      'detalhe completo dela. Só funciona para skills ativas AGORA — pedir skill não ativa ou caminho ' +
      'fora do manifesto dela volta erro.',
    inputSchema: z.object({
      skill_name: z.string().min(1).describe('nome da skill ativa neste turno (como aparece no bloco de skills)'),
      ref_path: z.string().min(1).describe('caminho da reference dentro do pacote da skill'),
    }).passthrough(),
  },
  open_human_case: {
    description:
      'Abra um caso para um humano de retaguarda quando você NÃO conseguir resolver o pedido do lead ' +
      'sozinho (liberar acesso, corrigir algo num sistema, uma decisão que exige uma pessoa). Você CONTINUA ' +
      'conversando com o lead normalmente — não silencia. Use SEMPRE que for prometer ao lead que alguém vai ' +
      'verificar/resolver: prometer sem abrir o caso é proibido. Isso vale mesmo quando você nomeia a ' +
      'pessoa ("vou confirmar com o Fulano", "já registrei com a equipe") — nomear alguém não abre o caso; ' +
      'só esta ferramenta abre. Chame-a NO MESMO turno em que fizer a promessa, nunca depois.',
    // Schema LARGO para o SDK (o modelo vê os campos); a validação REAL é a whitelist
    // .strict() openHumanCaseInputSchema (human-cases.ts) — campo extra/forjado vira
    // erro de ENSINO ao modelo, nunca exceção do SDK nem strip silencioso.
    inputSchema: z.object({
      title: z.string().describe('título curto, ex.: "Liberar acesso ao painel"'),
      summary: z.string().describe('o que o lead precisa, em pt-br'),
      blocker: z.string().describe('por que você não consegue resolver sozinho'),
    }).passthrough(),
  },
  provide_case_update: {
    description:
      'Quando um caso está esperando informação do cliente e você já colheu essa informação na conversa, ' +
      'use esta tool para devolver a informação ao humano responsável. Não invente — só o que o lead disse.',
    // Schema LARGO para o SDK; a validação REAL é a whitelist .strict()
    // provideCaseUpdateInputSchema (human-cases.ts).
    inputSchema: z.object({
      case_id: z.string().describe('id do caso aberto'),
      info: z.string().describe('a informação colhida do lead'),
    }).passthrough(),
  },
  send_template: {
    description:
      'Envia um TEMPLATE aprovado do WhatsApp. Use SOMENTE quando o send_message for recusado ' +
      'porque a janela de 24 horas com o contato fechou — a mensagem de erro diz quando é o caso. ' +
      'Você precisa do nome exato do template, do idioma e de um valor para CADA parâmetro. ' +
      'Se faltar valor, a resposta diz quais e você pode chamar de novo; qualquer outro erro ' +
      'significa que um humano precisa agir — encerre o turno sem insistir.',
    inputSchema: z.object({
      template_name: z.string().min(1).describe('nome exato do template, como aprovado na Meta'),
      language: z.string().min(2).describe('código do idioma, ex.: pt_BR'),
      values: z
        .record(z.string(), z.string())
        .describe('valor de cada parâmetro, na chave que a tela de templates mostra (ex.: "1", "2")'),
    }).passthrough(),
  },
} as const;

/**
 * Quantos vetos de `internal_vocabulary_leak` o turno tolera antes de o fail-safe soltar
 * o envio (ver o bloco em `send_message.execute`). Mesmo degrau do fail-safe de casos
 * humanos — 1ª vez ensina, a 2ª decide — porque a assimetria é a mesma: uma reescrita
 * que o modelo não fez não vale um cliente sem resposta.
 */
export const MAX_VETOS_DE_VOCABULARIO_INTERNO = 2;

/**
 * Teto de mensagens FÍSICAS enviadas ao lead por turno quando `knobs.maxSendsPerTurn`
 * está ausente (testes) — produção sempre recebe o knob do env (MAX_SENDS_PER_TURN).
 *
 * Existe porque NENHUM gate de before-send limita CONTAGEM por turno — `pacing` só
 * limita RITMO (tempo entre envios), não quantidade. Sem este teto, um modelo que
 * decida tratar uma lista de perguntas de qualificação como uma mensagem por pergunta
 * (em vez de perguntar uma e esperar a resposta) só para no teto genérico de STEPS do
 * loop de tools (AGENT_MAX_STEPS) — e esse teto conta QUALQUER tool, não só envio.
 * Medido em produção: um lead recebeu 8 mensagens seguidas do mesmo turno.
 */
export const DEFAULT_MAX_SENDS_PER_TURN = 3;

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
  /**
   * A declaração do turno (spec 16 §5) — a fronteira entre FALAR e OPERAR.
   *
   * `.optional()` SEM default, e a diferença importa: `undefined` significa que o
   * modelo não declarou nada (fechamento incompleto — turno a investigar), e é
   * estado distinto de `{nada_a_declarar: true}`, que é uma avaliação registrada.
   * Um `.default({})` aqui apagaria essa distinção e faria "o modelo esqueceu"
   * parecer "não havia nada" — ver o cabeçalho de `declaracao.ts`.
   *
   * Opcional também é o que mantém a retrocompatibilidade: checkpoint gravado
   * antes desta versão, e clone self-host cujo modelo ainda não conhece o campo,
   * seguem validando.
   */
  declaracao: declaracaoDoTurnoSchema.optional(),
});
export type CheckpointContent = z.infer<typeof checkpointContentSchema>;

/**
 * A ROW como o Postgres a devolve. `declaracao` é `Omit`-ada e redeclarada porque
 * o "não sei" tem representação DIFERENTE nas duas pontas: o modelo omite o campo
 * (`undefined`), o banco guarda `null`. Herdar o `?:` do schema faria o tipo
 * prometer `undefined` onde `select *` entrega `null` — e o `=== undefined` de
 * quem lesse a row seria falso justamente no caso que ele quer pegar.
 */
export interface LeadCheckpointRow extends Omit<CheckpointContent, 'declaracao'> {
  id: string;
  seq: string;
  organization_id: string;
  contact_id: string;
  job_id: string | null;
  created_at: Date;
  declaracao: DeclaracaoDoTurno | null;
}

/**
 * Instrução FIXA do fechamento — o runtime a impõe; o teste a usa como marcador.
 *
 * A declaração (spec 16 §5) viaja AQUI, na chamada que já acontece, e não numa
 * tool: uma `declarar_intencao` dependeria de o modelo lembrar de chamá-la, e o
 * turno em que ele esquecesse seria um lead parado em silêncio. É o mesmo
 * argumento que este arquivo já usa para o checkpoint — e sai de graça, porque
 * é a mesma chamada de modelo.
 */
export const CHECKPOINT_INSTRUCTION =
  'Feche o turno AGORA. Responda SOMENTE com um JSON válido no formato ' +
  '{"commitments": string[], "objections": string[], "next_action": string|null, "rolling_summary": string} ' +
  '— compromissos assumidos, objeções do lead, próxima ação e o resumo acumulado ' +
  'da conversa até aqui (inclua o que o resumo anterior já dizia). ' +
  // ⚠️ O REFERENCIAL DE `next_action`, e ele não é zelo de redação.
  //
  // Este JSON é escrito no FECHO do turno: a pergunta já saiu, a resposta ainda
  // não chegou. Sem dizer QUANDO, "próxima ação" é ambígua entre "o que acabei
  // de fazer" e "o que farei depois" — e o modelo gravava a primeira. No turno
  // seguinte o texto volta como o PRIMEIRO bloco do prompt, acima do histórico,
  // e manda repetir a pergunta que o histórico logo abaixo já responde. Medido
  // numa conversa real: o agente pediu o e-mail QUATRO vezes, com o cliente
  // respondendo três. (issue #510)
  //
  // A negação explícita está aqui porque dizer o que É não basta quando o erro
  // tem um atrator forte: a pergunta recém-feita é o texto mais fresco no
  // contexto do modelo.
  'Em `next_action`, escreva a ação que vem DEPOIS da resposta que você está ' +
  'esperando — nunca a pergunta que você acabou de fazer. Se o turno terminou ' +
  'perguntando, a próxima ação é o que fazer COM a resposta quando ela chegar. ' +
  DECLARACAO_INSTRUCTION +
  ' Sem texto fora do JSON.';

/**
 * Reexportado do módulo puro, onde ele PRECISA morar: o caminho legado
 * (`workers/ai-response-worker.ts`) grava a mesma razão e não pode importar este
 * arquivo. Fica visível aqui porque é daqui que o engine a grava.
 */
export { HANDOFF_REASON_ORCAMENTO };

/**
 * Primeira linha do resumo que vai ao humano quando o orçamento interrompe o
 * turno. É TEXTO FIXO, e tem de ser: o desvio existe porque não há orçamento
 * para chamar o modelo, então gerar este resumo por LLM seria gastar exatamente
 * o que acabou de ser recusado. O contexto útil vem logo abaixo, do checkpoint
 * durável (`buildHandoffSummary`), que também não custa token nenhum.
 */
export const RESUMO_DO_HANDOFF_POR_ORCAMENTO =
  'A IA parou de responder porque o teto de gasto mensal com IA desta organização foi ' +
  'atingido — o lead NÃO pediu atendimento humano. Assuma a conversa; para devolvê-la ao ' +
  'atendimento automático, ajuste o teto em Uso de IA › Orçamento e use "Devolver ao ' +
  'automático" no cabeçalho da conversa.';

/** Título do item da Central que este handoff abre — rótulo visível, logo constante. */
export const TITULO_DO_HANDOFF_POR_ORCAMENTO = 'Teto de gasto com IA atingido — assumir a conversa';

/**
 * ORÇAMENTO ESGOTADO NÃO PODE VIRAR SILÊNCIO PARA O LEAD.
 *
 * `aplicarOrcamento` recusa a chamada ANTES de sair byte para o provedor
 * (`../edge/llm/run-model-call.ts`), e a exceção subia direto para o `catch` do
 * worker. Do lado de fora, no WhatsApp, isso é uma pessoa que perguntou alguma
 * coisa e não recebeu resposta nenhuma — nem da IA, nem de gente. A proteção que
 * existe para salvar dinheiro quebrava o invariante 4 da doutrina do Sistema
 * Vivo: nenhuma demanda sem próximo passo.
 *
 * A resposta certa já existe no repositório e é feita exatamente para isto:
 * `performHumanHandoff` transiciona a conversa `ai_handling`→`pending` (fila
 * humana), silencia o bot, cancela os follow-ups agendados do lead e abre um
 * `agent_inbox_items` kind `handoff` — TUDO em banco, SEM GASTAR UM TOKEN, o que
 * aqui não é detalhe: o motivo do desvio é justamente não haver orçamento. Por
 * isso o resumo é texto fixo mais o checkpoint durável, nunca um resumo gerado.
 *
 * RELANÇA sempre. Quem decide o destino do job é a fila
 * (`workers/agent-worker/main.ts` manda erro terminal para `cancelJob`, não para
 * `failJob`). Engolir aqui trocaria uma falha visível por uma silenciosa, e pior:
 * o turno seguiria para o fechamento como se o modelo tivesse respondido.
 *
 * Se o PRÓPRIO handoff falhar (banco fora), a exceção DELE é que sobe — e é o
 * comportamento certo: ela não é terminal, então o job re-tenta e o handoff volta
 * a ser tentado. Preservar o erro de orçamento aqui faria o job ser cancelado com
 * o lead ainda no vácuo, que é o defeito que esta função existe para fechar.
 *
 * É função de módulo, e não closure do turno, para poder ser exercitada sozinha:
 * o caminho de erro de um turno de agente é caro demais para se provar só de
 * ponta a ponta, e o que precisa ser provado aqui é pequeno e exato.
 *
 * ═══ POR QUE ELA ENVOLVE O TURNO INTEIRO, E NÃO AS CHAMADAS DE MODELO ═══
 *
 * A primeira versão envolvia as DUAS chamadas diretas de `runModelCall` do
 * turno. Estava errada, e do jeito mais silencioso possível: o turno faz outras
 * chamadas de modelo ANTES delas, por funções auxiliares —
 * `classifyStage` (`stage-classifier.ts`, purpose `stage_classifier`, roda em
 * TODO turno porque `main.ts` monta `stageClassifier: {…}` como literal de
 * objeto, sempre definido) e `maybeCompact`/flush (`compaction.ts`, purposes
 * `compaction`/`flush`). Nenhum desses purposes está em `PURPOSES_ISENTOS`, e
 * nenhum tinha try/catch: com o teto estourado, o erro subia do classificador
 * ANTES de a escolta existir, o handoff NUNCA rodava, e o worker — que lê
 * `terminal` e chama `cancelJob` — descartava o job. Lead no vácuo, sem retry,
 * sem alerta. A escolta cobria o caso raro e faltava no dominante.
 *
 * Envolver o turno inteiro é o único desenho que não envelhece: não há lista de
 * auxiliares a manter, e o auxiliar que alguém acrescentar amanhã já nasce
 * coberto. `resumoDoCheckpoint` é uma FUNÇÃO resolvida dentro do catch (e não um
 * valor pronto), porque no caminho novo a escolta abre antes de o checkpoint ter
 * sido lido — e ler o checkpoint no caminho feliz seria uma query a mais por
 * turno para um texto que quase nunca é usado.
 */
export async function comHandoffSeOrcamentoAcabar<T>(
  ctx: {
    pool: pg.Pool;
    tenantId: string;
    leadId: string;
    conversationId: string;
    /**
     * Resolvido SÓ no caminho de erro: `buildHandoffSummary(latestCheckpoint(...))`
     * — do checkpoint durável, zero LLM.
     */
    resumoDoCheckpoint: () => Promise<string>;
    /**
     * Avisa o lead de que uma pessoa vai assumir, ANTES do handoff.
     *
     * Também resolvido só no caminho de erro, e pela mesma razão do resumo: o
     * caminho feliz não deve pagar por nada disto. O aviso é texto de CÓDIGO,
     * então não gasta um token — o que aqui não é detalhe, é o único jeito de
     * ele existir: o motivo do desvio é justamente não haver mais orçamento.
     */
    avisarLead: () => Promise<DesfechoDoAviso>;
    log: Logger;
  },
  chamada: () => Promise<T>,
): Promise<T> {
  try {
    return await chamada();
  } catch (err) {
    if (!(err instanceof LlmBudgetExceededError)) throw err;
    const resumo = await ctx.resumoDoCheckpoint();
    // AVISA antes de silenciar — ver a nota de ORDEM no gatilho determinístico:
    // `performHumanHandoff` arma a trava que o gate de envio lê, então a única
    // janela em que o aviso passa é ANTES dela.
    //
    // O try/catch NÃO é defesa contra o emissor de hoje (`avisarLeadLendoOContato`
    // já promete não lançar) — é contra a dependência que a ordem cria. Sem ele,
    // um canal fora do ar faria o cliente perder o aviso E o atendente, quando o
    // pior dos dois já teria acontecido no primeiro. Medido por
    // `tests/unit/handoff-por-orcamento.test.ts` ("aviso que falha NÃO impede a
    // passagem"), que reprovava a versão anterior desta linha.
    let aviso: DesfechoDoAviso;
    try {
      aviso = await ctx.avisarLead();
    } catch (erroDoAviso) {
      ctx.log.warn('aviso ao lead falhou antes da passagem por orçamento', {
        error: erroDoAviso instanceof Error ? erroDoAviso.message.slice(0, 200) : 'erro desconhecido',
      });
      aviso = { avisado: false, porque: 'erro_no_envio' };
    }
    await performHumanHandoff(
      ctx.pool,
      { tenantId: ctx.tenantId, leadId: ctx.leadId, conversationId: ctx.conversationId },
      {
        reason: HANDOFF_REASON_ORCAMENTO,
        conversationSummary: `${RESUMO_DO_HANDOFF_POR_ORCAMENTO}\n\n${resumo}`,
        inboxTitle: TITULO_DO_HANDOFF_POR_ORCAMENTO,
        avisoAoLead: aviso,
        log: ctx.log,
      },
    );
    ctx.log.warn('turno interrompido pelo teto de gasto — conversa devolvida à fila humana', {
      lead_avisado: aviso.avisado,
    });
    throw err;
  }
}

/**
 * O resumo que vai ao humano quando o orçamento interrompe o turno, lido do
 * checkpoint durável. Falhar aqui NÃO pode impedir o handoff: sem resumo o
 * humano assume com menos contexto; sem handoff ele não assume nada.
 */
async function resumoDoCheckpointDuravel(
  pool: pg.Pool,
  tenantId: string,
  leadId: string,
  log: Logger,
): Promise<string> {
  try {
    return buildHandoffSummary(await latestCheckpoint(pool, tenantId, leadId));
  } catch (err) {
    log.warn('resumo do checkpoint não pôde ser lido — o handoff segue sem ele', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
    return buildHandoffSummary(null);
  }
}

/**
 * Bloco de sistema RESIDENTE das tools de caso (spec 15 §5.2) — entra no prefixo
 * cacheável junto do índice de skills quando `casesEnabled`, pra não sumir em
 * conversa longa (ao contrário do índice de skills, este bloco não some).
 */
const CASES_SYSTEM_BLOCK =
  '## Casos para um humano de retaguarda\n' +
  'Quando você NÃO conseguir resolver o pedido do lead sozinho (liberar acesso, corrigir algo num ' +
  'sistema, uma decisão que exige uma pessoa), use a tool open_human_case — você CONTINUA conversando ' +
  'com o lead, não silencia. NUNCA prometa ao lead que um humano vai verificar/resolver sem antes chamar ' +
  'open_human_case. Quando um caso estiver esperando informação do cliente e você já a obteve na ' +
  'conversa, use provide_case_update para devolver ao responsável. Ao avisar o lead que abriu o caso, ' +
  'NUNCA narre a causa técnica ou interna (erro de sistema, falha de confirmação, nome de ferramenta, ' +
  'log ou qualquer diagnóstico) — isso é assunto técnico e não vai pro cliente. `title`/`summary`/`blocker` ' +
  'são só para o humano; a mensagem ao lead diz apenas, em linguagem simples, que você vai verificar/ajustar ' +
  'e volta com uma resposta, sem explicar o motivo interno.';

/**
 * Bloco de sistema RESIDENTE de transparência — SEMPRE presente, independente de
 * `casesEnabled` ou de `open_human_case` ter sido chamado neste turno.
 *
 * Por quê: `CASES_SYSTEM_BLOCK` só ensina a não narrar a causa técnica NO MOMENTO de
 * abrir um caso — mas o modelo narra "problema no sistema" também SEM abrir caso
 * nenhum, quando só está incerto ou algo falhou silenciosamente (medido em produção,
 * 2026-08-29: "houve um pequeno problema no sistema sobre o agendamento", mandado ao
 * cliente às 11:43, sem nenhum `agent_cases` aberto naquele turno — o veto de
 * `CASES_SYSTEM_BLOCK` nunca chegou a valer porque a tool nunca foi chamada). O
 * detector de vazamento (`vazamento-interno.ts`) não pega isso por desenho — ele caça
 * FORMA (identificador técnico), não sentença comum em português — então a única
 * cura possível aqui é instrução, não filtro.
 */
const TRANSPARENCIA_SYSTEM_BLOCK =
  '## Nunca narre problema interno ao lead\n' +
  'Em QUALQUER mensagem — abrindo caso ou não — NUNCA diga ao lead que "houve um problema/erro no ' +
  'sistema", "falha na confirmação", "erro técnico" ou qualquer variação que admita que algo deu errado ' +
  'do lado interno. Isso vale mesmo quando você está incerto do resultado de uma ferramenta ou algo ' +
  'falhou sem você entender o motivo. O lead não precisa do diagnóstico, precisa saber o que fazer ' +
  'agora: diga que vai verificar/confirmar e volta com a resposta, peça mais um instante, ou pergunte de ' +
  'novo o que falta — nunca admita que "o sistema" ou "a confirmação" teve um problema.';

/**
 * Bloco de sistema RESIDENTE da Agenda — entra no prefixo cacheável sempre que o
 * agente tem `crm_book_appointment` no `tool_ids` publicado, INDEPENDENTE de a skill
 * situacional "agendamento" ter disparado no turno.
 *
 * Por quê: a skill "agendamento" (`lib/agent-engine/agent/skills.ts`) só injeta o
 * corpo dela quando a ÚLTIMA mensagem inbound do turno bate uma keyword. Medido
 * neste repo: o turno em que o lead ACEITA um horário oferecido ("pode ser amanhã
 * às 9 então") raramente repete uma keyword de agendar — quem carrega a keyword é o
 * turno ANTERIOR, que já passou. Sem o corpo da skill presente NAQUELE turno
 * específico, o modelo confirmava o compromisso pela conversa, sem nunca chamar
 * `crm_book_appointment` — sentença dita ao cliente, nada gravado no banco. Esta
 * regra é curta, redundante com a skill de propósito e, por só depender de
 * `agentConfig.toolIds` (não da mensagem do turno), fica sempre presente.
 *
 * ⚠️ Segundo parágrafo (2026-08-29): a mesma lacuna de keyword tem um irmão mais
 * barato de cometer. Medido em produção: o lead disse "Pode ser segunda de manha"
 * e depois só "?" — nenhuma das duas bate keyword da skill "agendamento", então o
 * corpo dela (que tem a instrução "chame crm_find_free_slots e leia a resposta")
 * nunca entrou no contexto. O primeiro parágrafo deste bloco só proíbe MENTIR
 * ("confirmado" sem checar) — não obriga a CHECAR. Sem essa obrigação, o modelo
 * tinha uma saída segura e preguiçosa: responder "vou verificar e te aviso" pra
 * sempre, sem nunca chamar a ferramenta. O segundo parágrafo fecha essa saída.
 *
 * ⚠️ Terceiro parágrafo (2026-08-29, mesmo dia): o segundo parágrafo sozinho NÃO
 * bastou — medido no mesmo teste, depois de publicado. Causa raiz achada no
 * `system_prompt` que o PRÓPRIO tenant escreveu para este agente: ele instrui a
 * "encaminhar dúvidas ou situações fora da sua autonomia ao gerente Fernando".
 * O modelo estava classificando "confirmar horário" como uma dessas situações e
 * respondendo "vou confirmar com o Fernando/a equipe" — coerente com a
 * identidade que o tenant deu a ele, só que sem nunca chamar a ferramenta. Um
 * agravante: a MESMA conversa já tinha várias respostas assim ANTES deste fix
 * existir, e o modelo lê o próprio histórico — puxando a resposta pra manter
 * consistência com o que ele mesmo já disse. O terceiro parágrafo nomeia o
 * conflito explicitamente e resolve a favor da ferramenta: checar/marcar
 * agenda com uma tool disponível NUNCA é "fora da autonomia", nem quando o
 * prompt do tenant nomeia um gerente para outras decisões — e ele AINDA vale
 * pra essas outras decisões (aprovar desconto, exceção de política etc.),
 * porque este parágrafo só fala de checar/marcar horário.
 */
const AGENDA_SYSTEM_BLOCK =
  '## Agenda — nunca confirme sem checar\n' +
  'Você só pode dizer a um lead que um horário/consulta/visita está confirmado DEPOIS de chamar ' +
  'crm_book_appointment (ou crm_reschedule_appointment, para remarcação) e ver o retorno confirmando o ' +
  'sucesso. Isso vale mesmo quando o lead já aceitou um horário que você ofereceu — aceite verbal não é ' +
  'reserva. NUNCA diga "confirmado", "está marcado" ou equivalente baseado só no histórico da conversa. ' +
  'Se ainda não chamou a ferramenta neste turno, chame antes de responder; se a chamada falhar ou você não ' +
  'tiver certeza do resultado, diga que vai verificar e NÃO afirme que está confirmado.\n' +
  'Isso NÃO é desculpa para procrastinar: se o lead mencionou (agora ou em qualquer mensagem anterior da ' +
  'conversa) um dia/horário específico que ainda não foi checado, chame crm_find_free_slots NESTE turno ' +
  'antes de responder — não repita "vou verificar/confirmar e te aviso" sem ter chamado a ferramenta. Um ' +
  '"vou verificar" só é aceitável na MESMA resposta em que você já chamou a ferramenta e ela falhou ou não ' +
  'trouxe resultado; nunca como substituto de chamar.\n' +
  'Checar e marcar horário usando crm_find_free_slots/crm_book_appointment está SEMPRE dentro da sua ' +
  'autonomia quando essas ferramentas estão disponíveis para você — mesmo que as instruções da empresa ' +
  'peçam para encaminhar decisões fora da sua autonomia a um gerente/responsável nomeado (ex.: "fale com o ' +
  'Fernando"). Isso vale para OUTRAS decisões (desconto, exceção de política, algo que a ferramenta não ' +
  'cobre) — nunca para simplesmente consultar ou marcar um horário que a ferramenta resolve sozinha. NÃO ' +
  'diga "vou confirmar/verificar com [nome de pessoa/equipe]" para justificar não ter chamado a ferramenta: ' +
  'chame primeiro, e só fale de encaminhar a alguém se a ferramenta genuinamente não resolver.';

/**
 * Tools de agenda cuja EXECUÇÃO neste turno arma o `agendaStallGate` (before-send.ts) —
 * ver o wrap no loop de montagem das tools MCP, mais abaixo.
 */
const AGENDA_TOOL_NAMES = new Set([
  'crm_find_free_slots',
  'crm_book_appointment',
  'crm_reschedule_appointment',
]);

export interface InboundTurnKnobs {
  /** últimas N mensagens no contexto de abertura (LEAD_CONTEXT_HISTORY_LIMIT) */
  historyLimit: number;
  /** teto do payload do contexto (LEAD_CONTEXT_MAX_TOKENS) */
  maxContextTokens: number;
  /** orçamento fixo do índice de notas do lead injetado no sufixo (LEAD_NOTES_INDEX_MAX_TOKENS) */
  notesIndexMaxTokens: number;
  /** teto de steps do loop de tools por run (AGENT_MAX_STEPS) — circuit breaker fino é F2-15 */
  maxSteps: number;
  /**
   * Teto de mensagens FÍSICAS enviadas ao lead neste turno (MAX_SENDS_PER_TURN),
   * send_message + send_template somados, bolhas incluídas. Ausente = usa
   * `DEFAULT_MAX_SENDS_PER_TURN` — main.ts sempre o preenche pelo knob do env;
   * testes que não exercitam o teto o omitem sem custo.
   */
  maxSendsPerTurn?: number;
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
  /**
   * Onda 5 (Task 5.1) — modelo auxiliar dos turnos `classify`/`decide_timing` do
   * sistema de fluxos de follow-up (lib/agent-engine/agent/followup-flow-classify.ts).
   * Ausente = usa o defaultModel da org (mesma convenção de stageClassifier/jailbreak).
   */
  followupAi?: { model?: string };
  /**
   * Janela de validade da autorização de IA de um contato (gate opt-in
   * `channel_sessions.metadata.ai_gate = 'allowlist'`). Só consultada quando o
   * canal tem o gate ligado. Ausente nos testes que não o exercitam — o default
   * de 21 dias é aplicado.
   */
  allowlistTtlMs?: number;
}

/** Default de `allowlistTtlMs` (21 dias) para testes que omitem o knob. */
export const ALLOWLIST_TTL_MS_PADRAO = 21 * 24 * 60 * 60 * 1000;

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

/**
 * O checkpoint DO TURNO indicado — não "o mais recente do lead".
 *
 * `latestCheckpoint` é a pergunta certa para ABRIR um turno e a errada para
 * PROCESSAR um: entre o fim do turno N e o claim do job do Operador N cabe o turno
 * N+1 inteiro. A fila ordena por `(priority, run_after)`, o job do Operador nasce
 * com `run_after = now()` e o inbound com `now() + INBOUND_DEBOUNCE_MS` (8s) —
 * então uma mensagem que chega enquanto o turno corrente fecha é servida ANTES, e o
 * Operador N acordaria lendo a declaração N+1. O efeito é a mesma promessa
 * executada duas vezes e um aviso aberto duas vezes para uma promessa só.
 *
 * A chave sempre viajou no payload (`origin_job_id`) e era usada só como campo de
 * log. Sem índice novo: `idx_lead_checkpoints_latest (organization_id, contact_id,
 * seq desc)` já restringe a varredura àquele lead, e o `job_id` filtra em cima.
 */
export async function checkpointDoJob(
  db: Queryable,
  tenantId: string,
  leadId: string,
  jobId: string,
): Promise<LeadCheckpointRow | null> {
  const { rows } = await db.query<LeadCheckpointRow>(
    `select * from lead_checkpoints
     where organization_id = $1 and contact_id = $2 and job_id = $3
     order by seq desc
     limit 1`,
    [tenantId, leadId, jobId],
  );
  return rows[0] ?? null;
}

/**
 * A decisão de ENFILEIRAR o Operador — irmã de `decidirSeRoda`, que decide se ele
 * RODA.
 *
 * A segunda era função pura desde o primeiro dia; a primeira ficou implícita em
 * "sempre". A decisão (e) da spec declarou o custo em dinheiro (+1 chamada com o
 * papel ligado) e ninguém declarou o custo em CAPACIDADE DE FILA, pago mesmo com o
 * papel desligado — o default de toda instalação.
 *
 * Por turno, para escrever uma linha de log num contêiner que o dono do negócio
 * nunca abre: um job, um slot de `QUEUE_MAX_CONCURRENCY` e a única vaga daquele
 * lead no lote do claim (`distinct on (coalesce(contact_id, id))`). Sob rajada, é o
 * turno de CRM sendo servido antes da próxima mensagem do cliente.
 *
 * O que se perde: o registro "papel_desligado" do handler. Aceitável — era um
 * `log.info` de worker, que este arquivo classifica como não-superfície, e a linha
 * do chamador o repõe no mesmo nível com custo zero de fila.
 *
 * O que isto NÃO conserta, e um leitor futuro vai supor que sim: com o papel
 * desligado, promessa feita pelo Conversador continua sem registro na Central. Era
 * assim antes e continua sendo.
 */
export function decidirSeEnfileiraOperador(input: {
  temAgentePublicado: boolean;
  papelLigado: boolean;
}): { enfileira: boolean; porque: 'ligado' | 'sem_agente' | 'papel_desligado' } {
  if (!input.temAgentePublicado) return { enfileira: false, porque: 'sem_agente' };
  if (!input.papelLigado) return { enfileira: false, porque: 'papel_desligado' };
  return { enfileira: true, porque: 'ligado' };
}

async function insertCheckpoint(
  db: Queryable,
  input: { tenantId: string; leadId: string; jobId: string; content: CheckpointContent },
): Promise<void> {
  await db.query(
    `insert into lead_checkpoints (organization_id, contact_id, job_id, commitments, objections, next_action, rolling_summary, declaracao)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.tenantId,
      input.leadId,
      input.jobId,
      JSON.stringify(input.content.commitments),
      JSON.stringify(input.content.objections),
      input.content.next_action,
      input.content.rolling_summary,
      // NULL (não `'{}'`) quando o modelo não declarou: a coluna preserva a
      // distinção "não declarou" × "declarou que não havia nada" que o schema
      // sustenta em memória. Gravar um objeto vazio aqui jogaria fora, no
      // Postgres, a informação que o Zod tomou o cuidado de manter.
      input.content.declaracao === undefined ? null : JSON.stringify(input.content.declaracao),
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
  /**
   * Projetar o contexto (spec 16 §4)? Default `false` para não mudar em silêncio
   * o prompt de quem já chama isto (follow-up, resposta de caso) — cada chamador
   * liga quando souber responder a pergunta que a projeção faz: "este turno
   * consegue usar um id para alguma coisa?".
   */
  projeta = false,
  /**
   * Os compromissos já marcados deste contato, em texto (issue #512).
   *
   * OPCIONAL e último de propósito: `ritualBlocks` tem quatro chamadores
   * (inbound, follow-up, resposta de caso, retomada da escalação) e o bloco é
   * pago no SUFIXO, em TODA conversa. Ligar os quatro de uma vez daria tokens a
   * turnos que talvez nunca falem de horário — cada chamador decide, e hoje só
   * o inbound decidiu.
   */
  compromissosBlock = '',
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
    // O cabeçalho declara QUANDO isto foi escrito e QUEM MANDA no desacordo.
    //
    // Este é o PRIMEIRO bloco do prompt, acima do histórico — posição que um
    // modelo lê como "a instrução mais recente". Ele é o oposto disso: foi
    // escrito no fecho do turno ANTERIOR, antes da mensagem que o cliente
    // acabou de mandar. Sem dizer isso, um checkpoint desatualizado vence o
    // histórico que o contradiz. (issue #510)
    '## Checkpoint anterior — escrito ANTES da última mensagem do cliente',
    '(Se o histórico abaixo já responde o que este bloco pede, o histórico manda.)',
    checkpointBlock,
    '',
    '## Resumo acumulado da conversa',
    summaryBlock,
    '',
    // Era "## Estado do funil (lead_state)". O nome da tabela no cabeçalho era
    // vazamento gratuito — o modelo o lê e o repete, que é a porta 2 medida, só
    // que sem nem precisar de uma ferramenta para carregá-la. O CONTEÚDO deste
    // bloco (stage: 'qualifying') continua sendo vocabulário interno e continua
    // aqui: `update_lead_state` precisa dele para marcar o próximo estágio.
    // Sai no passo 6 da spec 16, junto com a ferramenta. Dívida declarada.
    '## Estado do funil',
    stateBlock,
    '',
    // Índice da memória durável do lead (F3-05): headlines + id, orçamento fixo. O
    // corpo vem sob demanda (get_lead_note). Injetado AQUI, no SUFIXO — depois do
    // prefixo cacheável (F2-17), como o bloco temporal da F3-03.
    '## Memória do lead (índice de notas — corpo sob demanda via get_lead_note)',
    notesIndexBlock,
    '',
    // Só entra quando há algo: um bloco dizendo "nenhum compromisso" custaria
    // tokens em toda conversa para informar uma ausência que o modelo não
    // precisa saber.
    ...(compromissosBlock.trim() !== ''
      ? ['## Compromissos já marcados deste contato', compromissosBlock, '']
      : []),
    '## Contexto do lead (contato + últimas mensagens)',
    // Campo de cadastro VAZIO não é prova de que a informação não existe.
    //
    // `contact.email: null` chegava como fato, e o modelo o lia com autoridade
    // de cadastro — vencendo o histórico onde o cliente ACABOU de digitar o
    // e-mail. E como não há caminho de escrita, o campo nunca deixa de ser
    // null: o pedido se repetia para sempre. A ressalva é CONDICIONAL de
    // propósito — pô-la sempre ensinaria o modelo a duvidar de dado bom, que é
    // o defeito espelhado. (issue #510)
    ...(context.contact?.email == null
      ? [
          '(O e-mail não está confirmado no cadastro. Isso NÃO quer dizer que o ' +
            'cliente não tenha dado: ele pode já ter sido dito no histórico abaixo. ' +
            'Confira lá antes de pedir de novo.)',
        ]
      : []),
    // A projeção (spec 16 §4) fecha a terceira porta: sem ela, `lead_id`,
    // `conversation_id` e `media_storage_path` chegam crus ao prompt — e UUID
    // cru na tela do cliente foi MEDIDO. Ela só arma quando o turno não tem
    // ferramenta de catálogo (ver `turnoProjeta`), porque é aí que esses ids
    // não têm uso nenhum. Nos demais, quem cobre é o gate de saída.
    JSON.stringify(projeta ? projetarContexto(context) : context),
  ];
}

/** Abertura determinística do run inbound — o ritual em texto (pt-br). */
export function buildOpeningMessage(
  previous: LeadCheckpointRow | null,
  leadState: LeadStateRow | null,
  context: LeadContext,
  notesIndexBlock: string,
  projeta = false,
  /**
   * Ferramentas que saíram para o Operador (spec 16, passo 6). O prompt PRECISA
   * deixar de citá-las — e esta é a parte que É a cura, não um acabamento.
   *
   * Remover a ferramenta e manter a instrução produziria o pior dos dois mundos:
   * o modelo tentaria chamar o que não existe, gastaria passo com o erro, E o
   * NOME continuaria no contexto — que é exatamente por onde o vazamento voltou
   * quando limparam só a descrição (`crm_list_webhook_sources`, medido).
   */
  entregues: readonly string[] = [],
  /** Os compromissos já marcados deste contato, em texto (issue #512). */
  compromissosBlock = '',
): string {
  const entregue = (nome: string): boolean => entregues.includes(nome);
  return [
    'Novo turno de atendimento: o lead enviou uma mensagem (a última inbound do histórico abaixo).',
    '',
    ...ritualBlocks(previous, leadState, context, notesIndexBlock, projeta, compromissosBlock),
    '',
    'Responda ao lead usando a tool send_message — NUNCA escreva a resposta como texto direto',
    '(texto fora de tool é descartado pelo runtime). Use get_lead_context se precisar reler o contexto.',
    // Quando o avanço do funil vira trabalho do Operador, o Conversador não
    // precisa saber que existe um funil. É a diferença entre "não fale disso" e
    // "não há disso no seu contexto" — a segunda não depende de obediência.
    ...(entregue('update_lead_state')
      ? []
      : ['Houve avanço REAL no funil neste turno? Marque-o com update_lead_state (só o próximo estágio válido).']),
    ...(entregue('save_lead_note')
      ? []
      : ['Aprendeu algo durável sobre o lead? Salve com save_lead_note (a headline entra no índice de memória).']),
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
    /**
     * Compromissos já marcados deste contato (issue #512).
     *
     * OPCIONAL pela mesma razão que `projeta`, e ela é externa ao desenho:
     * `tests/invariants/**` é congelado por hook de governança, e torná-lo
     * obrigatório forçaria a editar um invariante existente só para satisfazer
     * o compilador.
     */
    compromissosBlock?: string;
    /**
     * Projetar o contexto (spec 16 §4)? Decidido pelo turno, ver `turnoProjeta`.
     *
     * OPCIONAL no tipo, e a razão é externa ao desenho: `tests/invariants/**` é
     * congelado por hook de governança, e torná-lo obrigatório forçaria a editar
     * um invariante existente só para satisfazer o compilador — o que a catraca
     * proíbe, com razão. `runAgentTurn` SEMPRE o passa; o opcional só existe para
     * quem constrói um ritual à mão (testes).
     *
     * O custo está registrado: um chamador novo que esqueça o campo não projeta,
     * em silêncio. A direção do esquecimento é a segura (comportamento de hoje,
     * com o gate de saída cobrindo), mas é esquecimento mesmo assim.
     */
    projeta?: boolean;
    /** ferramentas que saíram para o Operador — o prompt não pode citá-las. */
    entregues?: readonly string[];
  }) => string;
}

/**
 * Núcleo do run do agente, compartilhado por inbound_turn (F2-09) e followup_turn
 * (F3-03): ritual de abertura, loop de tools, fechamento com checkpoint e veto. Não
 * guarda NADA entre invocações — sessão fresca por job (todo estado no closure). O
 * que varia entre os dois tipos de turno vem em `input` (AgentTurnInput).
 */
/**
 * O aviso de que o agente atendeu SEM as capacidades configuradas.
 *
 * Vai para a Central de avisos (`agent_inbox_items`) porque é lá que o dono do
 * negócio olha — log de worker em VPS não é superfície de nada.
 *
 * Dedup por episódio ABERTO da organização (mesmo padrão do handoff): o defeito
 * é sistêmico, não por conversa, e uma retentativa em rajada viraria dezenas de
 * linhas idênticas — inbox inundado é inbox ignorado. Quem resolver o item e
 * vir o problema voltar recebe um item novo, que é o comportamento certo.
 *
 * Best-effort de propósito: se ATÉ o aviso falhar, o turno continua. Derrubar o
 * atendimento do cliente para reclamar de uma tool extra seria trocar um
 * problema pequeno por um grande.
 */
export async function avisarCapacidadesAusentes(
  db: pg.Pool,
  tenantId: string,
  conversationId: string,
  detalhe: string,
  log: Logger,
): Promise<void> {
  try {
    await db.query(
      `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
       select $1, 'capabilities_missing', 'critical', $2, $3, 'conversation', $4
        where not exists (
          select 1 from agent_inbox_items
           where organization_id = $1 and kind = 'capabilities_missing' and status = 'open'
        )`,
      [
        tenantId,
        'O agente atendeu sem as capacidades que você ligou',
        'As ferramentas configuradas na tela do agente não puderam ser carregadas neste ' +
          'atendimento, e ele respondeu ao cliente sem elas. A conversa não foi interrompida. ' +
          `Motivo técnico: ${detalhe}`,
        conversationId,
      ],
    );
  } catch (err) {
    log.warn('aviso de capacidades ausentes não foi gravado', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }
}

/**
 * O NÚCLEO DO TURNO, SEMPRE SOB A ESCOLTA DO ORÇAMENTO.
 *
 * Esta função é o único ponto do produto por onde os três kinds de turno de
 * lead passam (`inbound_turn`, `followup_turn`, `case_reply_turn` — quatro call
 * sites), e por isso é aqui que a escolta mora. Envolver o turno INTEIRO, e não
 * as chamadas de modelo, é o que faz a proteção alcançar as chamadas indiretas
 * (`classifyStage`, `maybeCompact`/flush) — que são justamente as PRIMEIRAS do
 * turno, e portanto as que estouram primeiro quando o teto acabou. Ver o
 * cabeçalho de `comHandoffSeOrcamentoAcabar` para o defeito medido.
 *
 * `executarTurnoDoAgente` NÃO é exportada de propósito: exportá-la criaria um
 * caminho para o turno rodar desescoltado, e a guarda de artefato
 * (`tests/unit/handoff-por-orcamento.test.ts`) conta exatamente um call site.
 */
export async function runAgentTurn(
  deps: InboundTurnDeps,
  job: JobRow,
  pool: pg.Pool,
  ctx: { workerId: string },
  input: AgentTurnInput,
): Promise<void> {
  const leadIdDoJob = job.contact_id;
  if (leadIdDoJob === null) {
    throw new Error('job de turno sem contact_id — o CHECK da fila deveria impedir');
  }
  const logDaEscolta = withFields(deps.log, {
    job_id: job.id,
    tenant_id: job.organization_id,
    lead_id: leadIdDoJob,
  });
  await comHandoffSeOrcamentoAcabar(
    {
      pool,
      tenantId: job.organization_id,
      leadId: leadIdDoJob,
      conversationId: input.conversationId,
      resumoDoCheckpoint: () =>
        resumoDoCheckpointDuravel(pool, job.organization_id, leadIdDoJob, logDaEscolta),
      // O canal nasce DENTRO da closure: instanciá-lo aqui faria todo turno feliz
      // pagar por um adapter que só o caminho de erro usa. Sem `agentActorId` de
      // propósito — quando o teto estoura antes da primeira chamada, não houve
      // agente resolvido para creditar.
      avisarLead: () =>
        avisarLeadLendoOContato(
          pool,
          {
            tenantId: job.organization_id,
            leadId: leadIdDoJob,
            conversationId: input.conversationId,
            channelSessionId: input.channelSessionId,
            jobId: job.id,
          },
          {
            motivo: 'orcamento_de_ia',
            channel: (deps.channel ?? ((p: pg.Pool) => new WahaChannelAdapter(p, deps.crmCfg)))(pool),
            now: deps.clock?.() ?? new Date(),
            log: logDaEscolta,
            ...(deps.knobs.disclosureMode !== undefined ? { disclosureMode: deps.knobs.disclosureMode } : {}),
            ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
          },
        ),
      log: logDaEscolta,
    },
    () => executarTurnoDoAgente(deps, job, pool, ctx, input),
  );
}

/**
 * Este turno termina em mensagem PARA O LEAD? Só esses são adiados pela janela
 * anti-ban — adiar os outros seria parar trabalho interno por causa de um
 * horário que não é dele.
 *
 *   * `inbound_turn` / `case_reply_turn` — respondem o cliente, sempre.
 *   * `followup_turn` — só com `purpose: 'send_message'`. Os outros dois
 *     propósitos do fluxo (`classify`, `plan_timing`) são leitura e
 *     planejamento: não abrem o WhatsApp de ninguém.
 *   * `operator_turn` — retaguarda (mexe no funil), nunca fala com o lead.
 */
function turnoVaiFalarComOLead(job: JobRow): boolean {
  if (job.kind === 'inbound_turn' || job.kind === 'case_reply_turn') return true;
  if (job.kind !== 'followup_turn') return false;
  const purpose = (job.payload as { purpose?: unknown } | null)?.purpose;
  return purpose === undefined || purpose === 'send_message';
}

async function executarTurnoDoAgente(
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
  // O RELÓGIO, declarado antes de qualquer guarda de janela.
  //
  // Ele já existia — 330 linhas ABAIXO, depois das duas guardas que mais
  // dependem dele. O contrato de `InboundTurnDeps.clock` diz "a janela horária
  // do gate anti-ban é avaliada nele", e as duas guardas chamavam `new Date()`
  // cru: o relógio injetado não alcançava justamente o que ele existe para
  // fixar. Em produção dá no mesmo; no CI, a hora real do runner decidia, e a
  // suíte de invariantes ficava vermelha das 22h às 7h (fuso do tenant) — nove
  // horas por dia em que um PR reprova por causa do relógio de parede.
  const clock = deps.clock ?? ((): Date => new Date());
  const contextKnobs = { historyLimit: deps.knobs.historyLimit, maxTokens: deps.knobs.maxContextTokens };
  // Contexto do RUN em toda linha de log do turno (F2-16): job_id É o run id.
  const runLog = withFields(deps.log, { job_id: job.id, tenant_id: tenantId, lead_id: leadId });

  // AS DUAS CAMADAS QUE CUSTAM DINHEIRO, resolvidas UMA vez por turno.
  //
  // Os knobs (`deps.knobs.jailbreak`, `deps.knobs.promiseSemantic`) nascem no boot
  // do worker e valem para a instalação inteira; a linha em `org_guardrail_layers`
  // é a preferência de QUEM PAGA a consulta. Sem linha, `camadaLigada` devolve o
  // padrão do ambiente — aplicar a migration não muda o comportamento de quem já
  // decidiu no `.env`.
  //
  // Lido aqui, e não em cada ponto de uso: os dois consumidores ficam a ~900
  // linhas de distância um do outro, e duas queries para a mesma pergunta viram,
  // com o tempo, duas respostas.
  const camadas = await lerCamadasDaOrg(pool, tenantId);
  // O fuso da ORGANIZAÇÃO — o que o bloco `## Agora` usa lá embaixo, na montagem
  // da abertura. Lido aqui pela mesma razão da linha acima: uma query por turno,
  // longe do ponto de uso, para não virar duas respostas para a mesma pergunta.
  // Nunca lança e nunca vem vazio (ver `fuso-da-org.ts`).
  const fusoDaOrg = await fusoDaOrganizacao(pool, tenantId, runLog);

  // F4-06 (acceptance 2): lead em handoff humano → NO-OP no INÍCIO do turno, antes de
  // qualquer chamada de modelo/CRM. O bot silenciou (bot_silenced_until='infinity', cache
  // do force_human do CRM) e só o humano/CRM libera — o agente nunca reassume (regra dura 2).
  if (await isLeadInHandoff(pool, tenantId, leadId)) {
    runLog.info('turno pulado — lead em handoff humano (bot silenciado)', { kind: job.kind });
    return;
  }

  // GATE DE ELEGIBILIDADE (opt-in por canal — `metadata.ai_gate = 'allowlist'`).
  // Segunda checagem, defesa em profundidade: o drain já barra antes de
  // enfileirar, mas um job pode ter sido enfileirado quando a conversa ainda
  // estava autorizada e um humano assumiu no meio-tempo, ou o gate do canal
  // mudou. Canal 'open' (default) → `permite:true`, nada muda. NO-OP no início do
  // turno, antes de qualquer chamada de modelo — mesmo lugar e mesmo custo do
  // veto de handoff acima.
  try {
    const elegib = await decidirElegibilidadeDaConversa(pool, {
      organizationId: tenantId,
      conversationId: input.conversationId,
      agora: clock(),
      ttlMs: deps.knobs.allowlistTtlMs ?? ALLOWLIST_TTL_MS_PADRAO,
    });
    if (elegib !== null && !elegib.permite) {
      runLog.info('turno pulado — conversa não elegível para IA', {
        kind: job.kind,
        motivo: elegib.motivo,
      });
      return;
    }
    // KEEP-ALIVE: enquanto a conversa autorizada está viva, renova o carimbo —
    // assim uma negociação de semanas não expira pela janela de validade, mas um
    // contato que veio de uma submissão e sumiu volta a NÃO ser elegível depois
    // da janela. Só no modo 'allowlist' (motivo 'autorizado'); fire-and-forget.
    if (elegib !== null && elegib.motivo === 'autorizado' && job.kind === 'inbound_turn') {
      pool
        .query(
          `update contacts set ai_authorized_at = now()
           where organization_id = $1 and id = $2 and ai_authorized_at is not null`,
          [tenantId, leadId],
        )
        .catch((err: unknown) => {
          runLog.warn('keep-alive da autorização de IA falhou', {
            error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
          });
        });
    }
  } catch (err) {
    runLog.warn('checagem de elegibilidade falhou no turno — seguindo', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
  }

  // JANELA ANTI-BAN (7h–22h por padrão, fuso do tenant): fora dela o turno é
  // ADIADO, não gasto.
  //
  // ⚠️ ISTO CONSERTA UMA MENSAGEM PERDIDA, não um custo. O gate de envio
  // (`pacingGate` em guardrails/before-send.ts) já vetava o envio fora da
  // janela — mas, no caminho do agente, esse veto vira ERRO DE ENSINO devolvido
  // ao modelo dentro do tool `send_message`. O turno terminava `ok`, sem
  // exceção, sem reagendamento e sem mensagem: o lead escrevia 22h e não recebia
  // NADA, nem naquele momento nem às 7h. Medido em produção (2026-08-18): run
  // `agent_turn` com status `ok` às 22:56 e zero outbound na conversa.
  //
  // O caminho determinístico de re-entrada já fazia o certo — "veto por JANELA
  // anti-ban não dropa — re-agenda para a próxima abertura" (followup-turn.ts) —
  // e é essa regra que passa a valer também para a resposta do agente.
  //
  // Só a JANELA adia. Cap diário e warm-up continuam com o gate de envio: eles
  // dependem de quanto já saiu hoje, e antecipá-los aqui adiaria turno que, na
  // hora do envio, teria passado.
  if (turnoVaiFalarComOLead(job)) {
    const { knobs } = await loadChannelKnobs(pool, tenantId, input.channelSessionId, runLog);
    const agora = clock();
    if (!janelaDeEnvioAberta(agora, knobs)) {
      const abertura = proximaAberturaDaJanela(agora, knobs);
      await rescheduleJob(pool, job.id, ctx.workerId, {
        delayMs: Math.max(abertura.getTime() - agora.getTime(), 1_000),
        reason: 'fora da janela anti-ban de envio — turno adiado para a abertura',
      });
      runLog.info('turno adiado — fora da janela anti-ban de envio', {
        janela: `${knobs.windowStartHour}h-${knobs.windowEndHour}h`,
        timezone: knobs.timezone,
        abertura: abertura.toISOString(),
      });
      // O adiamento deixa RASTRO VISÍVEL. Sem isto, o único registro de que o
      // número está calado morre no log do contêiner — e foi assim que uma
      // instalação passou um domingo inteiro muda, com todos os contêineres
      // `healthy` e o dono sem nada para olhar. Um aviso por canal, deduplicado
      // enquanto durar o silêncio; ver o cabeçalho de `aviso-de-janela.ts`.
      //
      // Fire-and-forget: telemetria nunca derruba um turno que já decidiu o que
      // fazer com a mensagem do cliente — e o job JÁ foi reagendado acima.
      try {
        const criados = await avisarJanelaFechada(pool, {
          tenantId,
          channelSessionId: input.channelSessionId,
          abertura,
          janela: `${knobs.windowStartHour}h-${knobs.windowEndHour}h`,
          timezone: knobs.timezone,
          domingoDesligado: !knobs.allowSunday,
        });
        if (criados > 0) {
          runLog.info('aviso de janela fechada aberto na Central', {
            channel_session_id: input.channelSessionId,
          });
        }
      } catch (err) {
        runLog.warn('não consegui abrir o aviso de janela fechada', {
          error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
        });
      }
      throw new JobSettledError('fora da janela anti-ban — job reagendado para a abertura da janela');
    }
    // A janela está ABERTA: se havia aviso de silêncio pendurado, ele morre
    // AQUI — no mesmo ponto que o abriu. Um aviso que só o humano fecha vira
    // dívida: na segunda o número volta a atender e o painel seguiria dizendo
    // que está calado.
    try {
      await resolverAvisoDeJanela(pool, {
        tenantId,
        channelSessionId: input.channelSessionId,
      });
    } catch (err) {
      runLog.warn('não consegui resolver o aviso de janela fechada', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
    }
  }

  // Fase 3: stickiness do router — qual agente já atende esta conversa. Leituras
  // tolerantes a falha (ex.: clone self-host ainda sem a migration 0085 aplicada) —
  // um erro aqui degrada pro fluxo sem router, nunca derruba o turno (review T5).
  let sticky: { active_ai_agent_id: string | null; active_intent: string | null } = {
    active_ai_agent_id: null,
    active_intent: null,
  };
  // Regra 6 do resolver (nunca classifica em follow-up): só busca o sinal em turno
  // inbound de verdade — um follow-up de dias depois não pode reclassificar sobre a
  // mensagem antiga que originou a promessa (review T5, finding 1).
  let routingSignal: string | null = null;
  try {
    const { rows: convRows } = await pool.query<{ active_ai_agent_id: string | null; active_intent: string | null }>(
      'select active_ai_agent_id, active_intent from conversations where organization_id = $1 and id = $2',
      [tenantId, input.conversationId],
    );
    sticky = convRows[0] ?? sticky;
    if (job.kind === 'inbound_turn') {
      // O sinal de roteamento (última inbound) ainda não está disponível aqui —
      // getLeadContext só roda mais abaixo. Leitura direta e barata, só pra alimentar
      // o classificador. Mesma régua de "última inbound" do resto do turno
      // (get-lead-context.ts): sent_at (relógio do WhatsApp), não created_at (now() do
      // insert) — os dois relógios podem divergir (review T5, finding 3).
      const { rows: sigRows } = await pool.query<{ body: string | null }>(
        `select body from messages
         where organization_id = $1 and conversation_id = $2 and direction = 'inbound'
         order by sent_at desc, id desc limit 1`,
        [tenantId, input.conversationId],
      );
      routingSignal = sigRows[0]?.body ?? null;
    }
  } catch (err) {
    runLog.warn('leitura de sticky/sinal do router falhou — turno segue sem router', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
    });
  }

  // Fase 2B/3: config do agente por PONTEIRO PUBLICADO (tela ai/agents) — lida a
  // cada turno, zero cache; org/sessão da row do job (fonte confiável). Sem router
  // ativo pra sessão, o resolver devolve o mesmo fluxo de hoje (outcome 'no_router').
  // null = sem agente publicado p/ esta sessão → fallback (playbook + settings + env).
  const routed = await resolveTurnAgent(
    pool,
    deps.llmCfg,
    {
      tenantId,
      leadId,
      jobId: job.id,
      channelSessionId: input.channelSessionId,
      conversationId: input.conversationId,
      signal: routingSignal,
      stickyAgentId: sticky.active_ai_agent_id,
      stickyIntent: sticky.active_intent,
    },
    { log: runLog },
  );
  const agentConfig = routed.config;
  if (agentConfig !== null) {
    runLog.info('config do agente publicada em uso', {
      agent_id: agentConfig.agentId,
      agent_version_id: agentConfig.versionId,
      model: agentConfig.model,
      router_outcome: routed.outcome,
      intent: routed.intentName,
    });
  }
  // Horário de funcionamento da versão publicada (spec da tela: TriggerEditor).
  // Vale SÓ para o turno inbound: a janela do lojista é sobre QUANDO ele atende
  // quem chega, e adiar por ela um follow-up já prometido ao lead atrasaria uma
  // promessa que não é dele. O que segura o follow-up é a janela anti-ban logo
  // acima (`pacing/engine.ts`), que vale para os dois.
  //
  // Adia, não descarta: o job volta a 'pending' na abertura, SEM consumir
  // attempts (`rescheduleJob`) — quem escreveu 22h é atendido às 8h. O throw é
  // o contrato de `JobSettledError`: o run já dispôs do job, main.ts no-opa.
  if (job.kind === 'inbound_turn' && agentConfig?.janelaDeAtendimento != null) {
    const esperaMs = msAteAJanelaAbrir(agentConfig.janelaDeAtendimento, clock());
    if (esperaMs !== null) {
      await rescheduleJob(pool, job.id, ctx.workerId, {
        delayMs: esperaMs,
        reason: 'fora do horário de funcionamento do agente — turno adiado para a abertura da janela',
      });
      runLog.info('turno adiado — fora do horário de funcionamento configurado na versão publicada', {
        agent_id: agentConfig.agentId,
        espera_ms: esperaMs,
        janela: `${agentConfig.janelaDeAtendimento.start}-${agentConfig.janelaDeAtendimento.end}`,
      });
      throw new JobSettledError(
        'fora do horário de funcionamento — job reagendado para a abertura da janela',
      );
    }
  }

  // Fase 3: grava a decisão de roteamento e a aderência da conversa ao agente.
  // Fire-and-forget — falha de telemetria nunca derruba a resposta ao lead.
  if (routed.routerId !== null) {
    try {
      if (agentConfig !== null) {
        await pool.query(
          `update conversations
           set active_ai_agent_id = $3, active_intent = $4, active_agent_set_at = now()
           where organization_id = $1 and id = $2`,
          [tenantId, input.conversationId, agentConfig.agentId, routed.intentName],
        );
      }
      await pool.query(
        `insert into ai_router_decisions
           (organization_id, router_id, conversation_id, intent_name, confidence, agent_id, outcome, job_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, routed.routerId, input.conversationId, routed.intentName, routed.confidence, agentConfig?.agentId ?? null, routed.outcome, job.id],
      );
    } catch (err) {
      runLog.warn('decisão do router não gravada', { error: (err instanceof Error ? err.message : String(err)).slice(0, 120) });
    }
  }
  // Knobs por-turno: a versão publicada vence o env; sem ela, env (main.ts).
  const maxSteps = agentConfig?.maxSteps ?? deps.knobs.maxSteps;
  // Fallback de modelo das chamadas AUXILIARES (classificadores/compaction/promessa):
  // knob de env → modelo do agente PUBLICADO na tela → organizations.settings.llm.
  // Sem isso, self-host que configurou tudo pela tela (que não preenche default_model)
  // morria no primeiro classificador: "modelo LLM não definido".
  // A regra de ONDE o classificador auxiliar tira modelo + provider + credencial
  // mora em `aux-model-args.ts`, fora daqui, para poder ser exercitada por unit:
  // esta função precisa de banco, job e registry para rodar. Ver o defeito que a
  // originou (PR #151) no cabeçalho de lá.
  const argsAux = (configuredModel: string | undefined): AuxModelArgs =>
    auxModelArgs(configuredModel, agentConfig);

  /**
   * Os DOIS limites do histórico vêm da versão publicada — e o segundo vinha da
   * env, que é o defeito.
   *
   * A tela oferece "Tamanho máximo desse histórico" por agente e grava
   * `history_token_window` (default 8.000). O turno lia `historyMessageWindow`
   * dali e `maxTokens` de `LEAD_CONTEXT_MAX_TOKENS`, uma env com default 1.000
   * que sequer aparece no `.env.example`: quem configurava 8.000 na tela recebia
   * 1.000, sem nada dizer que o número não valia. Metade da versão publicada era
   * lida, metade não.
   *
   * O corte não morde na conversa curta de WhatsApp — ali quem limita é a janela
   * de mensagens (20 por padrão). Ele morde exatamente onde dói: mensagem longa
   * e áudio transcrito, quando o histórico é a única coisa que sustenta o fio da
   * conversa. O ramo sem versão publicada segue com os knobs da instalação, que
   * é o único caso em que ela é a fonte legítima.
   */
  const turnContextKnobs =
    agentConfig !== null
      ? { historyLimit: agentConfig.historyMessageWindow, maxTokens: agentConfig.historyTokenWindow }
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
  // Fase 1 (harness): memória geral da org — prefixo estável, resolvida a cada
  // turno como o playbook (publicar ⇒ próximo turno vale). composeSystemPrompt já
  // encaixa playbook + memória + índice de skills no prefixo cacheável.
  const orgMemory = await loadOrgMemory(pool, tenantId);
  const systemWithMemory = composeSystemPrompt({
    playbookPrompt: playbook.prompt,
    orgMemoryBlock: renderOrgMemory(orgMemory),
    skillIndex,
  });
  // Spec 15 §5.2: bloco das tools de caso SEMPRE residente (não invalida o prefixo
  // cacheável — mesmo espírito do índice de skills) quando a tela habilita. O bloco da
  // Agenda segue o mesmo padrão, condicionado a `crm_book_appointment` estar entre as
  // tools publicadas — ver comentário de `AGENDA_SYSTEM_BLOCK`. `TRANSPARENCIA_SYSTEM_BLOCK`
  // não depende de nenhuma feature — todo agente publicado o recebe.
  const blocosResidentes = [systemWithMemory, TRANSPARENCIA_SYSTEM_BLOCK];
  if (agentConfig !== null && agentConfig.casesEnabled) blocosResidentes.push(CASES_SYSTEM_BLOCK);
  if (agentConfig !== null && agentConfig.toolIds.includes('crm_book_appointment')) {
    blocosResidentes.push(AGENDA_SYSTEM_BLOCK);
  }
  const system = blocosResidentes.join('\n\n');
  const previous = await latestCheckpoint(pool, tenantId, leadId);
  const leadState = await getLeadState(pool, tenantId, leadId);
  const openingContext = await getLeadContext(
    pool,
    deps.crmCfg,
    { tenantId, leadId, conversationId: input.conversationId, fuso: fusoDaOrg },
    turnContextKnobs,
  );
  if (!openingContext.ok) {
    // Sem contexto não há turno: transiente (CRM fora) OU permanente (lead
    // sumiu) — ambos re-tentam pela fila e morrem em 'dead' se persistirem.
    throw new Error(`abertura do turno falhou em get_lead_context (${openingContext.error.code})`);
  }

  // Seam de canal (F2-25): o envio vai SÓ pela interface ChannelAdapter — o
  // default WAHA-via-CRM envolve o sink F2-06. Instanciado por job (o pool é
  // per-job neste codebase); trocar o adapter não muda nada abaixo.
  // Fase 2B: o envio carrega o ai_agents.id REAL como ator (audit/metadata do
  // CRM apontam o agente publicado, não um id genérico).
  //
  // ⚠️ Ele nasce AQUI, e não depois da compactação como antes, porque os dois
  // desvios determinísticos logo abaixo — pedido de humano e suspeita de
  // opt-out — passaram a FALAR com o lead antes de silenciar. Eles rodam antes
  // de qualquer chamada de modelo; o canal precisa existir antes deles.
  const turnCrmCfg =
    agentConfig !== null ? { ...deps.crmCfg, agentActorId: agentConfig.agentId } : deps.crmCfg;
  const channel = (deps.channel ?? ((p: pg.Pool) => new WahaChannelAdapter(p, turnCrmCfg)))(pool);
  // STOP lido no turno (fonte: CRM via get_lead_context) — combinado com o cache
  // durável leads.is_opted_out no gate 1 da cadeia (F2-13).
  const optedOutThisTurn = openingContext.context.contact.is_blocked;
  // LGPD (F4-09): base legal/anonimização do CRM lidas na abertura do turno (fonte confiável,
  // regra dura nº 1) — o gate LGPD da cadeia veta anonimizado (sempre) e 1º toque de prospecção
  // sem base legal. Resposta a inbound (isProspecting=false) não dispara o veto de base legal.
  const lgpd = openingContext.lgpd;

  /** Argumentos fixos do aviso ao lead — os dois desvios abaixo só trocam o motivo. */
  const avisoDaEscalacao = {
    ids: {
      tenantId,
      leadId,
      conversationId: input.conversationId,
      channelSessionId: input.channelSessionId,
      jobId: job.id,
    },
    base: {
      channel,
      optedOutThisTurn,
      now: clock(),
      log: runLog,
      lgpd,
      agentId: agentConfig?.agentId ?? null,
      ...(deps.knobs.disclosureMode !== undefined ? { disclosureMode: deps.knobs.disclosureMode } : {}),
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    },
  };

  // F4-06 (acceptance 1): detecção DETERMINÍSTICA (regex PT-BR, sem LLM) de pedido explícito
  // de atendimento humano na última mensagem do lead. Handoff é cidadão de 1ª classe (exigência
  // Meta fiscalizada, blueprint 5.5) — dispara ANTES do modelo: o bot não gasta LLM.
  // A ação (CRM force_human + cache + cancela crons + inbox) é idempotente.
  //
  // ⚠️ ORDEM: AVISA e SÓ ENTÃO silencia. Não é preferência de redação — é a única
  // ordem que funciona. `performHumanHandoff` grava `contacts.force_human = true`,
  // e o gate 1 da cadeia (`stopGate`) lê `(is_blocked or force_human)` DIRETO da
  // fonte, sob o lock, a cada tentativa de envio. Avisar depois seria avisar
  // ninguém: a própria trava que a passagem acabou de armar veta a mensagem.
  const inboundSignal = latestInboundSignal(openingContext.context.messages);
  if (
    detectHumanHandoffRequest(inboundSignal) ||
    (agentConfig !== null && matchesHandoffKeyword(inboundSignal, agentConfig.handoffKeywords))
  ) {
    const aviso = await avisarLeadDaEscalacao(pool, avisoDaEscalacao.ids, {
      ...avisoDaEscalacao.base,
      motivo: 'pediu_humano',
    });
    await performHumanHandoff(
      pool,
      { tenantId, leadId, conversationId: input.conversationId },
      {
        reason: 'requested_human',
        conversationSummary: buildHandoffSummary(previous),
        avisoAoLead: aviso,
        log: runLog,
      },
    );
    runLog.info('handoff humano acionado por pedido explícito do lead (detecção determinística)', {
      kind: job.kind,
      lead_avisado: aviso.avisado,
    });
    return; // bot silencia: o aviso já saiu, e nada mais sai neste turno
  }

  // F4-07: STOP AMBÍGUO ("para de me mandar isso", "não quero mais receber", "me tira da
  // lista", ou a palavra-chave STOP/PARAR/SAIR sozinha). Detecção CONSERVADORA — na dúvida
  // é STOP: o bot silencia JÁ (sem LLM, sem envio) via o MESMO mecanismo durável do handoff
  // (bot_silenced_until='infinity', que SOBREVIVE à leitura do CRM que sobrescreve o cache
  // is_opted_out) e escala à inbox para o humano confirmar o opt-out real (is_blocked) no
  // CRM. Cancela os follow-ups agendados de tabela. Nada disso reverte (regra dura nº 2).
  if (detectAmbiguousOptOut(latestInboundSignal(openingContext.context.messages))) {
    // O aviso daqui NÃO fala em atendente — quem pediu para parar não quer ouvir
    // sobre atendimento (`textoDoAviso`, motivo `suspeita_de_opt_out`). Ele
    // CONFIRMA a parada, que é o padrão de mensageria para um opt-out, e diz que
    // uma pessoa vai conferir. Sair calado deixaria a pessoa sem saber se o
    // pedido dela foi ouvido — e ela pediu justamente para ser ouvida.
    const aviso = await avisarLeadDaEscalacao(pool, avisoDaEscalacao.ids, {
      ...avisoDaEscalacao.base,
      motivo: 'suspeita_de_opt_out',
    });
    await performHumanHandoff(
      pool,
      { tenantId, leadId, conversationId: input.conversationId },
      {
        reason: 'suspected_optout',
        conversationSummary: buildHandoffSummary(previous),
        inboxTitle: 'Suspeita de opt-out — confirmar bloqueio do contato no CRM',
        avisoAoLead: aviso,
        log: runLog,
      },
    );
    runLog.info('possível opt-out detectado no inbound — bot silenciado e escalado ao humano', {
      kind: job.kind,
      lead_avisado: aviso.avisado,
    });
    return; // bot silencia: a confirmação já saiu, e nada mais sai neste turno
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
        // A compactação é o QUARTO call site da mesma regra, e o #151 só cobriu
        // três: ela também pedia o modelo do agente ao provider default da org.
        // Mesmo 404, mesma morte de turno — só que num caminho que roda quando a
        // conversa já é longa, ou seja, mais tarde e com menos gente olhando.
        knobs: { ...deps.knobs.compaction, ...argsAux(deps.knobs.compaction.model) },
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
          // Este `previous` é sintetizado a partir de histórico IMPORTADO — não
          // houve turno nosso, logo ninguém declarou nada. `null` é o valor
          // honesto; um objeto vazio afirmaria uma avaliação que não aconteceu.
          declaracao: null,
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
  // ⚠️ `leadId` AQUI É O CONTATO (`leadIdDoJob = job.contact_id`, e o comentário
  // de `get-lead-context.ts:193` diz o mesmo). Passar essa variável para um
  // parâmetro chamado `contactId` é correto pelo VALOR; o nome é que mente, e é
  // o que a issue #509 conserta. Não troque por um `lead_id` "mais coerente".
  const compromissosBlock = await buildCompromissosBlock(pool, tenantId, leadId, new Date());
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
  // Teto de mensagens físicas por turno (F2-15b) — `seq` JÁ é a contagem certa: ele só
  // avança quando o envio de fato sai pro canal (send_message + send_template, bolhas
  // incluídas), nunca em veto de gate. Checar `seq` antes de tentar o próximo envio
  // barra o modelo sem gastar uma chamada de before-send à toa.
  const maxSendsPerTurn = deps.knobs.maxSendsPerTurn ?? DEFAULT_MAX_SENDS_PER_TURN;
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
    camadaLigada(camadas.promessa_semantica, deps.knobs.promiseSemantic?.enabled === true)
      ? (candidate: string) =>
          classifyPromise(
            pool,
            deps.llmCfg,
            { tenantId, leadId, jobId: job.id },
            {
              candidate,
              ...argsAux(deps.knobs.promiseSemantic?.model),
            },
            { ...(deps.registry !== undefined ? { registry: deps.registry } : {}), log: runLog },
          )
      : undefined;
  let outOfTablePromiseAttempted = false;
  // Spec 15 (Wave 4 lê este flag): true quando open_human_case abriu um caso NESTE
  // turno — aqui só declara e seta; o consumo (ex.: guardrail de promessa) é da Wave 4.
  let openedCaseThisTurn = false;
  // Wave 4 — contador do fail-safe do guardrail anti-alucinação (case_promise_without_case):
  // 1º veto no turno é erro-de-ensino (o modelo re-tenta); persistir uma 2ª vez aciona o
  // auto-abre-caso (ver send_message.execute). Por turno (closure), nunca cross-turno.
  let casePromiseVetoCount = 0;
  // Contador do fail-safe do gate de vazamento de vocabulário interno
  // (`internal_vocabulary_leak`): 1º veto no turno ensina o modelo a reescrever; persistir
  // solta o envio com registro. Por turno (closure), nunca cross-turno.
  let internalVocabularyVetoCount = 0;
  // Cap de envio (warm-up/diário) vetado neste turno — capturado aqui porque o veto
  // não empurra outcome nenhum a `outcomes` (ver comentário no ponto de captura, mais
  // abaixo). Diferente da janela horária (checada ANTES do modelo rodar, linha ~1233):
  // o cap depende de quanto já saiu HOJE, que muda com o turno concorrente — só dá pra
  // saber com certeza no momento do envio, não antes.
  let pacingCapVeto: { code: string; nextAllowedAt: Date } | null = null;
  // Best-effort: move o lead pra etapa `crm_stages.slug='chamar-humano'` do pipeline
  // dele (se o tenant tiver criado essa etapa — opt-in, ver `lib/leads/handoff-stage-move.ts`)
  // sempre que um caso humano abre neste turno, deliberado (open_human_case) ou pelo
  // fail-safe do `case_promise`. Sem isto, o funil no CRM não refletia o handoff que o
  // PRÓPRIO PROMPT do tenant promete ao lead ("vou verificar/encaminhar com o Fernando")
  // — medido em produção, tenant YADEA: caso aberto, funil parado em "Novo contato".
  // Nunca bloqueia nem derruba o turno — mesma disciplina de `triggerHandoff` (G1-G4),
  // que já chama o mesmo helper para o handoff por palavra-chave do cliente.
  const moverParaHandoffBestEffort = (reason: string): void => {
    moverLeadParaEtapaDeHandoff(createAdminClient(), { organizationId: tenantId, leadId, reason }).catch((err) => {
      runLog.warn('moverLeadParaEtapaDeHandoff falhou (best-effort, caso humano)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
  // Arma o `agendaStallGate` (before-send.ts): true assim que crm_find_free_slots,
  // crm_book_appointment ou crm_reschedule_appointment executar neste turno — marcado no
  // wrapper das tools MCP, mais abaixo. `send_message` lê o valor NO MOMENTO do envio; como
  // as tools do modelo rodam em passos anteriores do mesmo loop, o valor já está certo
  // quando o modelo decide mandar a resposta.
  let agendaToolCalledThisTurn = false;
  const outcomes: ChannelSendResult[] = [];
  // Citações acumuladas por buscas de conhecimento DESTE turno — anexadas à
  // próxima outbound enviada (shape de lib/ai/citations/types, que a UI já lê).
  let pendingCitations: ReturnType<typeof citationsFromHits> = [];
  let runError: Error | null = null;
  const noteRunError = (err: Error): void => {
    runError ??= err;
  };

  // Guideline-matching if-then (F3-09): o SINAL do turno (última mensagem inbound) decide
  // quais skills disparam. Corpos casados vão no SUFIXO da abertura (situacional, por-lead —
  // depois do prefixo cacheável); situação neutra ⇒ nenhum corpo (economia de tokens). Os
  // near-misses (probe sem hard-match) viram candidatos ao golden set, gravados por fs em
  // runtime (não a tool Write) — só se o dir estiver configurado. Calculado AQUI, ANTES de
  // montar rawTools (Fase 2): o gate de read_skill_reference precisa do resultado do match
  // para decidir se a tool entra no turno (mesmo padrão de gate de search_knowledge/
  // request_human_handoff, feito antes do wrapToolsWithBreaker).
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
  // Fase 2: telemetria de ativação de skill (hard match + near-miss probe).
  try {
    const rows: Array<[string, string | null, string]> = [
      ...skillMatch.matched.map((s) => [s.name, s.versionId, 'hard'] as [string, string | null, string]),
      ...skillMatch.missCandidates.map((m) => [m.skill, null, 'probe'] as [string, string | null, string]),
    ];
    if (rows.length > 0) {
      const values: string[] = [];
      const params: unknown[] = [];
      rows.forEach(([name, verId, trig], i) => {
        const b = i * 5;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
        params.push(tenantId, name, verId, trig, job.id);
      });
      await pool.query(
        `insert into skill_activations (organization_id, skill_name, skill_version_id, trigger, job_id) values ${values.join(',')}`,
        params,
      );
    }
  } catch (err) {
    runLog.warn('skill_activations não gravadas', { error: (err instanceof Error ? err.message : String(err)).slice(0, 120) });
  }

  /**
   * Os ids de catálogo que de fato ENTRARAM neste turno — não os que a tela
   * marcou. A diferença importa: quando a montagem falha, o turno segue sem elas,
   * e é o turno REAL que decide se a projeção arma. Ler a config aqui faria a
   * projeção ficar desligada num turno que, por acidente, não recebeu ferramenta
   * nenhuma — justo o turno em que ela é gratuita.
   *
   * Declarado ANTES de `rawTools` de propósito: o `execute` de `get_lead_context`
   * fecha sobre ele e o lê no momento da CHAMADA, quando as ferramentas de
   * catálogo já foram montadas (o `push` acontece bem abaixo, antes do loop do
   * modelo). Deixá-lo declarado depois funcionaria, mas esconderia a ordem de que
   * a correção depende.
   */
  const mcpToolIdsDoTurno: string[] = [];

  const rawTools: ToolSet = {
    get_lead_context: tool({
      ...AGENT_TOOL_DEFS.get_lead_context,
      execute: async (): Promise<
        | LeadContextResult
        // A variante PROJETADA é um tipo próprio, não um `LeadContext` disfarçado
        // por cast: são payloads diferentes, e um `as` aqui faria o compilador
        // parar de vigiar exatamente a fronteira que este código existe para
        // manter. Note que `lgpd` não viaja nela — base legal e anonimização são
        // dado de conformidade que o runtime usa nos gates, e que o modelo nunca
        // precisou ler (no caminho não-projetado ele já ia junto; aqui para).
        | { ok: true; context: ContextoProjetado; tokenCount: number }
        | { ok: false; error: { code: string; message: string } }
      > => {
        try {
          const releitura = await getLeadContext(
            pool,
            deps.crmCfg,
            { tenantId, leadId, conversationId: input.conversationId, fuso: fusoDaOrg },
            turnContextKnobs,
          );
          // Sem esta linha a projeção da abertura seria decorativa: bastaria o
          // modelo chamar esta ferramenta para receber o contexto CRU de volta,
          // com `lead_id`, `conversation_id` e caminho de mídia. A releitura é a
          // mesma superfície da abertura e tem de obedecer à mesma regra —
          // proteger só a porta da frente é não ter protegido.
          if (releitura.ok && turnoProjeta(mcpToolIdsDoTurno)) {
            return {
              ok: true,
              context: projetarContexto(releitura.context),
              tokenCount: releitura.tokenCount,
            };
          }
          return releitura;
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
    send_template: tool({
      ...AGENT_TOOL_DEFS.send_template,
      execute: async ({ template_name, language, values }) => {
        if (seq >= maxSendsPerTurn) {
          return {
            ok: false,
            error: {
              code: 'max_sends_per_turn',
              message:
                `você já enviou ${seq} mensagens neste turno (teto: ${maxSendsPerTurn}). ` +
                'NÃO envie mais nada agora — encerre o turno e espere a resposta do lead.',
            },
          };
        }
        // O texto RENDERIZADO vai como `body` da cadeia: os gates de promessa,
        // spinning e disclosure avaliam exatamente o que o contato vai ler. Sem
        // isso, "usar template" seria a forma de escapar dos guardrails de conteúdo.
        const { rows } = await pool.query<{
          components: unknown;
          parameter_format: string;
          status: string;
        }>(
          `select components, parameter_format, status from meta_templates
            where organization_id = $1 and name = $2 and language = $3`,
          [tenantId, template_name, language],
        );
        const linha = rows[0];
        if (linha === undefined) {
          return {
            ok: false,
            error: {
              code: 'template_desconhecido',
              message:
                `não existe template "${template_name}" em ${language} nesta conta. ` +
                'Encerre o turno; um humano precisa configurá-lo.',
            },
          };
        }
        // "Existe" não é "pode ser disparado". A regra vive em template-binding.ts e
        // o caminho HUMANO já a respeitava (recusa `not_approved` no menu do composer);
        // este caminho não a consultava — e é o que age SEM humano olhando. Um template
        // PENDING ou REJECTED iria à Graph API, voltaria erro genérico, e o modelo
        // trataria como falha de infraestrutura em vez de configuração pendente.
        //
        // Erro SEPARADO de `template_desconhecido` de propósito: as duas causas pedem
        // ações humanas diferentes — criar o template, ou esperar/consertar a análise
        // da Meta. Colapsá-las manda o operador procurar no lugar errado.
        if (!isStatusSendable(linha.status)) {
          return {
            ok: false,
            error: {
              code: 'template_nao_aprovado',
              message:
                `o template "${template_name}" existe mas está ${linha.status} na Meta — ` +
                'só um template APPROVED pode ser disparado. Encerre o turno; ' +
                'um humano precisa resolver a aprovação.',
            },
          };
        }

        const rendered = renderTemplateBody(linha.components, values, {
          name: template_name,
          language,
          parameterFormat: linha.parameter_format,
        });

        const chain = await runBeforeSend({
          pool,
          log: runLog,
          tenantId,
          leadId,
          jobId: job.id,
          channelSessionId: input.channelSessionId,
          body: rendered,
          // Só ESTE gate muda; stop, LGPD e pacing continuam valendo integralmente.
          isTemplate: true,
          optedOutThisTurn,
          crmDailyLimit: null,
          now: clock(),
          sleep: deps.sleep,
          lgpd,
          send: (finalBody: string) => {
            seq += 1;
            return channel.send({
              tenantId,
              leadId,
              jobId: job.id,
              seq,
              conversationId: input.conversationId,
              body: finalBody,
              template: { name: template_name, language, values },
            });
          },
        });

        if (chain.status === 'vetoed') {
          return { ok: false, error: { code: chain.code, message: chain.message } };
        }
        const outcome = chain.outcome;
        outcomes.push(outcome);
        if (outcome.kind === 'sent' || outcome.kind === 'already_sent') {
          return {
            ok: true,
            status: 'enviada',
            message_id: outcome.messageId,
            // Explícito: sem isso o modelo tende a emendar texto livre depois do
            // template — que a janela fechada recusaria.
            message: 'template enviado. Não escreva mais nada neste turno.',
          };
        }
        return { ok: true, status: 'aceita_aguardando_canal' };
      },
    }),
    search_knowledge: tool({
      ...AGENT_TOOL_DEFS.search_knowledge,
      execute: async ({ query }) => {
        const fontes = agentConfig?.knowledgeSourceIds ?? [];
        if (fontes.length === 0 && agentConfig?.activeKbVersionId == null) {
          return {
            ok: false,
            error: { code: 'no_knowledge_base', message: 'este agente não tem material de consulta habilitado — siga sem ele.' },
          };
        }
        const out = await searchKnowledge(pool, {
          organizationId: tenantId,
          knowledgeSourceIds: fontes,
          kbVersionId: agentConfig?.activeKbVersionId ?? null,
          query,
          topK: agentConfig?.ragTopK ?? 5,
          threshold: agentConfig?.ragSimilarityThreshold ?? 0.4,
          jobId: job.id,
          agentId: agentConfig?.agentId ?? null,
        }, { log: runLog });
        if (out.ok && out.results.length > 0) {
          // As citações são montadas AQUI, pelo código, a partir do resultado
          // cru — é por isso que os ids podem sair do que vai ao modelo sem
          // perder nada: quem precisa deles é esta linha, não o modelo.
          pendingCitations = citationsFromHits(out.results);
        }
        // `chunk_id` e `knowledge_source_id` viajavam CRUS para o modelo em toda
        // busca com RAG — dois UUIDs por resultado, sem uso nenhum do lado dele
        // (nenhuma ferramenta os aceita como argumento). UUID cru na resposta ao
        // cliente foi MEDIDO nesta base; esta era uma fonte silenciosa dele.
        return turnoProjeta(mcpToolIdsDoTurno) ? projetarRetornoDeTool(out) : out;
      },
    }),
    send_message: tool({
      ...AGENT_TOOL_DEFS.send_message,
      execute: async ({ body }) => {
        if (seq >= maxSendsPerTurn) {
          return {
            ok: false,
            error: {
              code: 'max_sends_per_turn',
              message:
                `você já enviou ${seq} mensagens neste turno (teto: ${maxSendsPerTurn}). ` +
                'NÃO envie mais nada agora — encerre o turno e espere a resposta do lead.',
            },
          };
        }
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
          // Wave 4 (spec 15 §10.2): estado de caso lido FRESCO a cada tentativa de envio
          // (pode ter mudado dentro deste MESMO turno via open_human_case, chamado antes
          // deste send_message). casesEnabled false (tela não habilita) → sempre false,
          // sem query — o casePromiseGate já é no-op nesse caso de qualquer forma.
          const hasOpenCase =
            agentConfig?.casesEnabled === true
              ? await hasOpenCaseForContact(pool, tenantId, input.conversationId)
              : false;
          // Args reusados EXATAMENTE (mesmo objeto) no re-run do fail-safe abaixo — só
          // hasOpenCase/openedCaseThisTurn mudam depois do auto-abre-caso.
          const beforeSendArgs = {
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
            casesEnabled: agentConfig?.casesEnabled ?? false,
            hasOpenCase,
            openedCaseThisTurn,
            // Nome(s) próprio(s) que o prompt do tenant usa pra retaguarda humana (ex.:
            // "Fernando") — o mesmo vocabulário que `matchesHandoffKeyword` já usa do lado
            // do CLIENTE, agora somado ao alvo genérico do `casePromiseGate` do lado do
            // que o MODELO promete. Ver `GateContext.humanPromiseExtraTargets`.
            humanPromiseExtraTargets: agentConfig?.handoffKeywords ?? [],
            // A rede contra vazamento de vocabulário interno arma AQUI e só aqui: este é
            // o único corpo escrito pelo MODELO, e o único caminho em que o veto vira
            // erro instrutivo que ele pode consertar no turno seguinte. O `send_template`
            // (mais acima) fica desarmado de propósito — o texto lá é do humano e já
            // aprovado pela Meta; vetá-lo devolveria ao modelo a culpa por uma frase que
            // não é dele, e a única saída seria o silêncio. O follow-up determinístico
            // idem (ver GateContext.internalVocabularyEnforced).
            enforceInternalVocabulary: true,
            // Mesmo padrão do vocabulário interno: só o `send_message` arma — é o único
            // corpo escrito pelo modelo. `active` segue a MESMA condição de
            // `AGENDA_SYSTEM_BLOCK` (crm_book_appointment publicado); sem ela o gate
            // vetaria agente que nem tem a ferramenta de agenda.
            agenda: {
              active: agentConfig !== null && agentConfig.toolIds.includes('crm_book_appointment'),
              toolCalledThisTurn: agendaToolCalledThisTurn,
            },
            ...(deps.knobs.disclosureMode !== undefined ? { disclosureMode: deps.knobs.disclosureMode } : {}),
            // Gate 5 (F4-02): classificador semântico roteado pelo MESMO seam agnóstico (budget
            // da org checado nele). Closure com tenant/lead/job da ROW fechados — nunca do payload.
            ...(semanticClassifier !== undefined ? { classifyPromiseSemantic: semanticClassifier } : {}),
            // `finalBody` = corpo após a cadeia (o disclosureGate F4-05 pode prependar o
            // disclosure via inject); é ELE que vai ao canal, não o `body` capturado da tool.
            send: (finalBody: string) =>
              sendInBubbles(finalBody, {
                enabled: agentConfig?.splitMessages ?? false,
                maxChars: agentConfig?.splitMaxChars ?? 600,
                sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
                jitter: () => 1200 + Math.floor(Math.random() * 800), // piso no throttle anti-ban (1.2s) — bolhas são mensagens físicas
                send: (bubble): Promise<ChannelSendResult> => {
                  seq += 1;
                  return channel.send({
                    tenantId,
                    leadId,
                    jobId: job.id,
                    seq,
                    conversationId: input.conversationId,
                    body: bubble,
                  });
                },
              }),
          };
          let chain = await runBeforeSend(beforeSendArgs);
          if (chain.status === 'vetoed' && chain.code === 'case_promise_without_case') {
            // Wave 4 — fail-safe da invariante sagrada: o lead NUNCA recebe promessa-de-
            // humano sem caso aberto. 1ª vez no turno: erro-de-ensino (o modelo re-tenta —
            // abre o caso OU reformula sem prometer humano). Persistiu (2ª vez): o SISTEMA
            // abre um caso mínimo e libera o envio — nunca deixa a promessa passar sem caso.
            casePromiseVetoCount += 1;
            if (casePromiseVetoCount < 2) {
              return { ok: false, error: { code: chain.code, message: chain.message } };
            }
            const auto = await openCase(
              pool,
              { tenantId, conversationId: input.conversationId, agentId: agentConfig?.agentId ?? null },
              {
                title: 'Atendimento que precisa de um humano',
                summary: body, // a mensagem-promessa que a IA tentou enviar
                blocker:
                  'Aberto automaticamente: a IA prometeu envolver um humano e não abriu o caso (fail-safe do guardrail).',
                source: 'guardrail_autofallback',
                contextSnapshot: buildCaseContextSnapshot(),
              },
            );
            if (!auto.ok) {
              // openCase falhou (ex.: já existe outro caso aberto por corrida) — NÃO envie
              // prometendo humano sem caso; mantém a invariante com o erro de ensino original.
              return { ok: false, error: { code: chain.code, message: chain.message } };
            }
            openedCaseThisTurn = true;
            moverParaHandoffBestEffort('case_promise_autofallback');
            // Re-roda a cadeia INTEIRA agora que há caso aberto — o send real acontece
            // DENTRO do runBeforeSend (via args.send); nunca chamamos o canal por fora
            // (perderia pacing/lgpd/stop). ponytail: re-roda a cadeia inteira no fail-safe
            // (raro) — pode reaplicar 1 espera de pacing; aceitável pelo caminho ser
            // excepcional.
            chain = await runBeforeSend({ ...beforeSendArgs, hasOpenCase: true, openedCaseThisTurn: true });
          }
          if (chain.status === 'vetoed' && chain.code === 'internal_vocabulary_leak') {
            // Fail-safe do gate de vazamento — O CLIENTE NUNCA FICA SEM RESPOSTA.
            //
            // Este gate é REDE, não invariante sagrada (ao contrário do case_promise, cuja
            // 2ª camada ABRE o caso antes de liberar). Aqui não há o que o sistema possa
            // fazer no lugar do modelo: ou ele reescreve, ou a escolha é entre uma frase
            // com um termo técnico e o silêncio. Silêncio é pior — some com o atendimento
            // sem sintoma, que é o oposto do invariante 4 do sistema vivo. Então: 1º veto
            // ensina (o modelo re-tenta); persistiu, o envio sai DESARMANDO só este gate —
            // todos os outros continuam valendo, porque o re-run passa pela cadeia inteira.
            //
            // O veto da 1ª tentativa já virou linha em `before_send_traces` (com a
            // categoria do vazamento) e atividade na timeline: a liberação não apaga a
            // medição, que é o produto deste gate.
            internalVocabularyVetoCount += 1;
            if (internalVocabularyVetoCount < MAX_VETOS_DE_VOCABULARIO_INTERNO) {
              return { ok: false, error: { code: chain.code, message: chain.message } };
            }
            runLog.warn('fail-safe do gate de vocabulário interno: envio liberado após vetos seguidos', {
              vetos: internalVocabularyVetoCount,
            });
            // `openedCaseThisTurn` vai pelo valor VIVO (o fail-safe de casos acima pode
            // tê-lo mudado); reusar o do objeto capturado re-vetaria no case_promise.
            chain = await runBeforeSend({
              ...beforeSendArgs,
              openedCaseThisTurn,
              hasOpenCase: hasOpenCase || openedCaseThisTurn,
              enforceInternalVocabulary: false,
            });
          }
          if (chain.status === 'vetoed') {
            // Cap de warm-up/diário: reescrever o texto não resolve (é rate limit, não
            // conteúdo) — ensinar o modelo a "tentar de novo" só gasta passo. Guardamos
            // pra reagendar o JOB inteiro depois que o turno terminar (mesmo padrão de
            // `rescheduleJob` já usado pra janela horária), em vez de deixar o lead sem
            // resposta até a próxima mensagem dele chegar (ou nunca).
            if (
              (chain.code === 'warmup_cap' || chain.code === 'daily_cap') &&
              chain.nextAllowedAt !== undefined
            ) {
              pacingCapVeto = { code: chain.code, nextAllowedAt: chain.nextAllowedAt };
            }
            // Erro de ENSINO pt-br (mesmo shape de get_lead_context/breaker): o
            // modelo o vê no turno seguinte. NÃO é exceção — não derruba o run.
            return { ok: false, error: { code: chain.code, message: chain.message } };
          }
          const outcome = chain.outcome;
          outcomes.push(outcome);
          if (outcome.kind === 'sent' && pendingCitations.length > 0) {
            try {
              await pool.query(
                `update messages
                 set metadata = coalesce(metadata, '{}'::jsonb)
                   || jsonb_build_object('citations', $3::jsonb, 'ai_generated', true)
                 where organization_id = $1 and id = $2`,
                [tenantId, outcome.messageId, JSON.stringify(pendingCitations)],
              );
            } catch (err) {
              // citação é enriquecimento, não invariante — falha só loga.
              runLog.warn('citações não anexadas à outbound', {
                message_id: outcome.messageId,
                error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
              });
            }
            pendingCitations = [];
          }
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
            // Espelho no CRM. Falha NUNCA reverte o harness (fonte da verdade do
            // funil) nem falha o job: humano resolve via inbox_items. Os motivos
            // de MIRROR_WARN_ONLY (tenant sem mapa; humano moveu o card antes) são
            // só warn — estado legítimo do produto não é incidente.
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
              if (mirror.reason === 'fora_do_escopo') {
                // Aviso PRÓPRIO, e não o de falha: nada quebrou — a regra
                // funcionou. Dizer "falhou" aqui mandaria o dono procurar um
                // defeito que não existe, e "reconcilie manualmente" seria
                // instrução errada: ele não deve mover o card, deve decidir se
                // libera o funil para este assistente.
                await insertInboxItem(pool, tenantId, {
                  kind: 'other',
                  title: 'O assistente quis organizar um negócio de um funil que não é dele',
                  body:
                    `O assistente concluiu que este negócio deveria ir para "${update.transition.to}", ` +
                    `mas ele não cuida do funil onde o negócio está (${mirror.detail}). ` +
                    `Ninguém mexeu no card. Se ele deveria cuidar desse funil, marque isso na ` +
                    `configuração do assistente; se não, não há nada a fazer.`,
                  refKind: 'lead',
                  refId: leadId,
                });
              } else if (!MIRROR_WARN_ONLY.has(mirror.reason)) {
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
          // ═══ O PISO: se o modelo não falou, o sistema fala ═══
          //
          // A descrição da tool manda avisar o lead ANTES de chamá-la, e a
          // mensagem de retorno repete. Mas capacidade que depende de o modelo
          // LEMBRAR é capacidade que não existe metade das vezes — a mesma
          // conclusão que fez `expectativaDeAtendimento` parar de esperar que
          // ele consultasse a disponibilidade sozinho.
          //
          // `seq` é o contador de mensagens FÍSICAS já enviadas neste turno. Zero
          // significa: o modelo decidiu passar a conversa sem dizer nada a
          // ninguém — e depois desta tool ele não consegue mais falar, porque
          // `force_human` arma o `stopGate`. Então o aviso determinístico sai
          // AGORA, antes do handoff.
          //
          // `seq > 0` significa que ele JÁ falou neste turno; mandar o aviso ali
          // em cima seria o robô dizendo duas vezes a mesma coisa, com palavras
          // diferentes. Confiamos na fala dele e registramos que o piso não foi
          // preciso.
          const aviso =
            seq === 0
              ? await avisarLeadDaEscalacao(pool, avisoDaEscalacao.ids, {
                  ...avisoDaEscalacao.base,
                  motivo: 'pediu_humano',
                })
              : ({ avisado: true } as const);
          const res = await applyRequestHumanHandoff(
            pool,
            { tenantId, leadId, conversationId: input.conversationId },
            { conversationSummary: buildHandoffSummary(previous), avisoAoLead: aviso, log: runLog },
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
          // agentId vai junto para a atividade da timeline nascer com AUTORIA: sem
          // ele a linha entra como "Sistema" e o humano não sabe qual agente
          // prometeu voltar — numa org com três agentes isso não responde nada.
          const res = await applyScheduleFollowup(
            pool,
            { clock, knobs: followupKnobs },
            { tenantId, leadId, agentId: agentConfig?.agentId ?? null },
            raw,
          );
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

  // Fase 2 (Task 6): read_skill_reference só entra quando alguma skill CASADA neste
  // turno carrega references no manifesto (Task 3) — sem isso oferecer a tool seria
  // ruído. Read-only (tool-breaker.ts); tenant/matched skills vêm do closure
  // (skillMatch, calculado acima), nunca do payload do modelo.
  if (skillMatch.matched.some((s) => skillHasReferences(s))) {
    rawTools.read_skill_reference = tool({
      ...AGENT_TOOL_DEFS.read_skill_reference,
      execute: async ({ skill_name, ref_path }) => {
        try {
          return await readSkillReference(
            { admin: deps.crmCfg.supabase },
            { organizationId: tenantId, matchedSkills: skillMatch.matched, skillName: skill_name, refPath: ref_path },
          );
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao ler a reference da skill — encerre o turno agora.' },
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

  // Spec 15: snapshot mínimo do contexto disponível pro humano que for atender o
  // caso — campo de CONVENIÊNCIA pra UI, não load-bearing (nada aqui é relido pelo
  // agente). ponytail: snapshot mínimo; enriquecer se a UI precisar de mais.
  const buildCaseContextSnapshot = (): Record<string, unknown> => ({
    contact_name: effectiveContext.contact.name,
    last_messages: effectiveContext.messages.slice(-5).map((m) => ({ direction: m.direction, body: m.body })),
  });

  // Spec 15 (Wave 3a): tools de caso humano (open_human_case/provide_case_update) só
  // entram quando a tela habilita (cases_enabled) — mesmo padrão do handoff acima.
  // Ids do closure (row do job), nunca do payload; payload inválido é erro de ENSINO
  // ({ok:false}), exceção real vira internal_error (mesma disciplina dos irmãos).
  if (agentConfig !== null && agentConfig.casesEnabled) {
    rawTools.open_human_case = tool({
      ...AGENT_TOOL_DEFS.open_human_case,
      execute: async (raw) => {
        const parsed = openHumanCaseInputSchema.safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false,
            error: {
              code: 'invalid_payload',
              message: 'campos do caso inválidos — informe title, summary e blocker (texto).',
            },
          };
        }
        try {
          const res = await openCase(
            pool,
            { tenantId, conversationId: input.conversationId, agentId: agentConfig.agentId },
            { ...parsed.data, contextSnapshot: buildCaseContextSnapshot() },
          );
          if (!res.ok) return res;
          openedCaseThisTurn = true;
          moverParaHandoffBestEffort('open_human_case');
          // ACH-03: a expectativa vai junto com a confirmação. Medido num turno
          // real: o agente abria o caso e prometia ao cliente que "alguém entra
          // em contato" sem nunca ter olhado se havia alguém — a capacidade de
          // consultar existia, estava ligada e montada no turno, e ele não a
          // usou. Capacidade que depende de o modelo lembrar não existe metade
          // das vezes; esta o sistema garante.
          const { frase } = await expectativaDeAtendimento(pool, tenantId, new Date());
          return {
            ok: true,
            case_id: res.caseId,
            message: `caso aberto; continue a conversa com o lead normalmente. ${frase}`,
          };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao abrir o caso — encerre o turno.' },
          };
        }
      },
    });
    rawTools.provide_case_update = tool({
      ...AGENT_TOOL_DEFS.provide_case_update,
      execute: async (raw) => {
        const parsed = provideCaseUpdateInputSchema.safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false,
            error: { code: 'invalid_payload', message: 'informe case_id e info (texto).' },
          };
        }
        try {
          const res = await provideCaseUpdate(
            pool,
            { tenantId, conversationId: input.conversationId },
            { caseId: parsed.data.case_id, info: parsed.data.info },
          );
          if (!res.ok) return res;
          return { ok: true, message: 'informação enviada ao responsável; aguarde o retorno pelo caso.' };
        } catch (err) {
          noteRunError(err instanceof Error ? err : new Error(String(err)));
          return {
            ok: false,
            error: { code: 'internal_error', message: 'erro interno ao atualizar o caso — encerre o turno.' },
          };
        }
      },
    });
  }

  // A tool de conhecimento só entra quando o agente publicado tem material para
  // consultar. Desde a 0181 isso é a lista de materiais escolhida na tela; o
  // ponteiro legado (`activeKbVersionId`) segue valendo para o clone que ainda
  // não aplicou a migration. Ferramenta que só sabe responder "não tenho base"
  // não é neutra: gasta contexto e degrada a escolha do modelo.
  if ((agentConfig?.knowledgeSourceIds?.length ?? 0) === 0 && agentConfig?.activeKbVersionId == null) {
    delete rawTools.search_knowledge;
  }

  // A ferramenta de template só entra em canal que EXIGE template fora da janela.
  // Num canal que fala livre a qualquer hora ela nunca teria uso — e tool inútil no
  // prompt não é neutra: gasta contexto e degrada a escolha do modelo.
  {
    const provider = await loadChannelProvider(pool, tenantId, input.channelSessionId);
    if (!capabilitiesOf(provider).requiresTemplates) {
      delete rawTools.send_template;
    }
  }

  // 2B-tools: tools do catálogo MCP habilitadas NA TELA entram no run (audit +
  // role/scope da ponte nativa; envio e handoff do catálogo são bloqueados —
  // ver edge/crm/mcp-tools.ts). As 8 tools do engine têm precedência de nome.
  let mcpCleanup: (() => Promise<void>) | null = null;
  if (agentConfig !== null && agentConfig.toolIds.length > 0) {
    try {
      // As de OPERAÇÃO saem antes de serem montadas, quando o Operador as tem.
      // Medido: são elas que carregavam 2 dos 3 vazamentos (o DADO que devolvem),
      // e tirá-las levou a taxa de 30% para 10% — ver RELATORIO-passo6.md.
      const catalogoEntregue = catalogoEntregueAoOperador({
        operadorLigado: agentConfig.operatorEnabled,
        ferramentasDoOperador: agentConfig.operatorToolIds,
        ferramentasDoConversador: agentConfig.toolIds,
      });
      const configDoTurno =
        catalogoEntregue.length === 0
          ? agentConfig
          : { ...agentConfig, toolIds: agentConfig.toolIds.filter((t) => !catalogoEntregue.includes(t)) };
      if (catalogoEntregue.length > 0) {
        runLog.info('capacidades de catálogo entregues ao operador', { entregues: catalogoEntregue });
      }
      const mcp = await buildMcpTurnTools(deps.crmCfg, { organizationId: tenantId, jobId: job.id }, configDoTurno, runLog);
      if (mcp !== null) {
        mcpCleanup = mcp.cleanup;
        for (const [name, mcpTool] of Object.entries(mcp.tools)) {
          if (name in rawTools) continue;
          // Marca a EXECUÇÃO (não só a decisão de chamar) — é isso que o agendaStallGate
          // precisa saber para não vetar um turno que já checou a agenda de verdade.
          if (AGENDA_TOOL_NAMES.has(name) && typeof mcpTool.execute === 'function') {
            const executeOriginal = mcpTool.execute.bind(mcpTool);
            rawTools[name] = {
              ...mcpTool,
              execute: (async (...args: Parameters<typeof executeOriginal>) => {
                agendaToolCalledThisTurn = true;
                return executeOriginal(...args);
              }) as typeof mcpTool.execute,
            };
          } else {
            rawTools[name] = mcpTool;
          }
        }
        mcpToolIdsDoTurno.push(...mcp.toolIds);
        runLog.info('tools MCP da tela montadas no turno', { mcp_tool_ids: mcp.toolIds });
      }
    } catch (err) {
      // Tool extra é privilégio, não invariante: falha no mint/montagem NÃO
      // derruba o turno — a conversa do cliente não pode morrer porque uma tool
      // extra falhou. Isso continua certo.
      //
      // O que estava errado era o DEPOIS. A versão anterior deste comentário
      // dizia "o humano vê o log". Não vê: o log sai no stdout do worker, num
      // contêiner de VPS que o dono do negócio nunca abre. Medido num turno
      // real — o agente atendeu sem NENHUMA das capacidades que o humano tinha
      // ligado na tela, e a única pista existia num log que ninguém lê. É
      // falha-em-verde: anunciada na tela, ausente na execução, nada contando.
      const detalhe = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      runLog.error('tools MCP da tela não montadas — turno segue sem elas', { error: detalhe });
      await avisarCapacidadesAusentes(pool, tenantId, input.conversationId, detalhe, runLog);
    }
  }

  // ── A CURA (spec 16, passo 6) ───────────────────────────────────────────────
  //
  // As ferramentas de escrita saem do Conversador quando o Operador as assumiu.
  // O gate de vazamento é rede — barra na saída e ensina; isto é a cura: o
  // modelo não pode repetir o nome de uma ferramenta que nunca viu, e foi pelo
  // NOME que o vazamento voltou depois de a descrição ser limpa.
  //
  // A remoção é CONDICIONAL a o novo dono existir (ver entrega-de-capacidade):
  // tirar de um lado sem garantir o outro não separa papéis, perde capacidade.
  const entregues = capacidadesEntreguesAoOperador({
    operadorLigado: agentConfig?.operatorEnabled ?? false,
    ferramentasDoOperador: agentConfig?.operatorToolIds ?? [],
  });
  for (const nome of entregues) delete rawTools[nome];
  if (entregues.length > 0) {
    runLog.info('capacidades entregues ao operador — fora do turno do conversador', {
      entregues,
    });
  }

  // Circuit breaker de tools (F2-15): estado no closure DESTA invocação — zera
  // entre runs por construção (mesma garantia de isolamento do resto do run).
  const tools = wrapToolsWithBreaker(rawTools, {
    thresholds: deps.knobs.breaker,
    readOnlyTools: READ_ONLY_TOOLS,
    log: runLog, // os warns dos gates do breaker saem carimbados com o run
  });

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
        ...argsAux(deps.knobs.stageClassifier.model),
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
  if (camadaLigada(camadas.jailbreak, deps.knobs.jailbreak !== undefined)) {
    const verdict = await classifyJailbreak(
      pool,
      deps.llmCfg,
      { tenantId, leadId, jobId: job.id },
      {
        message: skillSignal,
        // Knob ausente + organização ligando = roda com o modelo padrão dela,
        // que é a convenção já usada pelo stageClassifier.
        ...argsAux(deps.knobs.jailbreak?.model),
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

  // Spec 16 §4: a projeção arma quando NENHUMA ferramenta de catálogo entrou —
  // é exatamente o turno em que os ids do contexto não têm uso, e portanto o
  // único em que removê-los não custa nada. Logado porque "por que o prompt
  // deste turno é diferente do daquele?" precisa ter resposta no trace.
  const projetaContexto = turnoProjeta(mcpToolIdsDoTurno);
  runLog.info('projeção do contexto do turno', {
    projeta: projetaContexto,
    mcp_tools_no_turno: mcpToolIdsDoTurno.length,
  });
  const openingBase = input.buildOpening({
    previous: effectivePrevious,
    leadState,
    context: effectiveContext,
    notesIndexBlock,
    projeta: projetaContexto,
    entregues,
    compromissosBlock,
  });
  // Sufixos por-lead (situacionais, voláteis — depois do prefixo cacheável F2-17): corpos de
  // skill casadas (F3-09) + hint do classificador (F3-11) + instrução de split (F4-xx, quando
  // split_messages está on — Onda 4). Vazios são omitidos.
  const splitHint = (agentConfig?.splitMessages ?? false)
    ? 'Responda em mensagens curtas e naturais, uma ideia por mensagem — como uma pessoa digitando no WhatsApp. Prefira várias mensagens curtas a um texto único e longo.'
    : '';
  // Spec 15: o `case_id` real do caso 'awaiting_lead' desta conversa, se houver — sem
  // isso o modelo nunca consegue chamar provide_case_update quando o lead simplesmente
  // responde (o caminho comum; case_reply_turn só cobre a AÇÃO do humano). Sufixo
  // por-lead (volátil) — nunca no prefixo cacheável (o case_id muda a cada caso).
  const caseAwaitingLead =
    agentConfig !== null && agentConfig.casesEnabled
      ? await getCaseAwaitingLead(pool, tenantId, input.conversationId)
      : null;
  const caseAwaitingLeadBlock =
    caseAwaitingLead !== null
      ? `## Caso aguardando resposta deste cliente\n` +
        `Há um caso aberto (case_id: ${caseAwaitingLead.id}) esperando uma informação dele: "${caseAwaitingLead.ask}". ` +
        `Se a mensagem dele responde a isso, chame provide_case_update com este case_id e a informação recebida — ` +
        `NÃO diga que já repassou/avisou o responsável sem chamar a tool.`
      : '';
  // ── O RELÓGIO DO TURNO ────────────────────────────────────────────────────
  //
  // Entra AQUI, e o lugar é a metade do conserto.
  //
  // No `system` (o prefixo estável org-wide, F2-17) ele invalidaria o cache de
  // prompt de TODOS os leads a cada turno, porque muda a cada segundo — é o que
  // `stable-prefix.ts` proíbe em letra. No sufixo por-lead ele é volátil entre
  // iguais, e custa os ~50 tokens dele.
  //
  // PRIMEIRO da lista de propósito: a âncora temporal precede o material que o
  // modelo vai usar para decidir data — corpo de skill, hint do classificador,
  // caso pendente. E `executarTurnoDoAgente` é o ponto por onde passam os TRÊS
  // turnos conversacionais (inbound, follow-up e resposta a caso), então um
  // ponto só cobre os três — e alcança de carona a chamada de fechamento, que
  // reusa `openingTextOnly` e é onde nasce o `prazo` ISO da declaração.
  const agoraBlock = renderAgora(clock(), fusoDaOrg);
  const openingSuffixes = [
    agoraBlock,
    matchedSkillsBlock,
    stageHintBlock,
    splitHint,
    caseAwaitingLeadBlock,
  ].filter((b) => b !== '');
  const openingText =
    openingSuffixes.length === 0 ? openingBase : `${openingBase}\n\n${openingSuffixes.join('\n\n')}`;
  // Onda 3 (aprimoramento): mídia inbound recente vira part nativa (image/file) SÓ para
  // provider+modelo capazes (T2 modelCapabilities) — modelo incapaz/desconhecido → [] e o
  // derivado textual (já embutido em openingText via LeadContextMessage) cobre sozinho.
  const nativeParts = await buildNativeMediaParts({
    messages: effectiveContext.messages,
    provider: agentConfig?.provider ?? 'anthropic',
    model: agentConfig?.model ?? '',
    multimodalInput: agentConfig?.multimodalInput ?? false,
    admin: deps.crmCfg.supabase,
  });
  const openingTextOnly: ModelMessage[] = [{ role: 'user', content: openingText }];
  const openingMessages: ModelMessage[] =
    nativeParts.length === 0
      ? openingTextOnly
      : [{ role: 'user', content: [{ type: 'text', text: openingText }, ...nativeParts] }];

  // O modelo decide tools livremente dentro do teto de steps (knob AGENT_MAX_STEPS).
  //
  // Sem escolta LOCAL: quem cobre o teto de gasto é `runAgentTurn`, que envolve
  // este corpo inteiro. Escoltar aqui deixaria de fora as chamadas de modelo dos
  // auxiliares (`classifyStage`, `maybeCompact`), que rodam ANTES desta e por
  // isso são as que estouram primeiro.
  const turn = await runModelCall(
    pool,
    deps.llmCfg,
    {
      tenantId,
      leadId,
      jobId: job.id,
      // De quem é esta execução. Vai para `llm_calls.agent_id` e é o que permite
      // a aba "Execuções" da tela do agente mostrar o que ELE fez — antes ela
      // lia `ai_agent_runs`, tabela que motor nenhum vivo escreve, e dizia
      // "Nenhuma execução ainda" com o agente respondendo no WhatsApp.
      agentId: agentConfig?.agentId ?? null,
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
  //
  // Também sob o handoff (o do turno inteiro, em `runAgentTurn`): o teto pode
  // ser cruzado ENTRE as duas chamadas — a primeira é que gasta o grosso do
  // turno. Aqui o lead já recebeu resposta, mas a conversa ficaria sem
  // checkpoint e sem dono, e o próximo inbound cairia no mesmo bloqueio, agora
  // sem nada tendo mudado no meio.
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
        // prune: o checkpoint reusa a abertura só como texto — a mídia nativa (cara) já
        // fez seu trabalho na 1ª chamada e não precisa ir de novo.
        ...openingTextOnly,
        ...responseMessages,
        { role: 'user', content: CHECKPOINT_INSTRUCTION },
      ],
    },
    { registry: deps.registry, log: runLog },
  );
  const content = parseCheckpointText(closing.result.text);

  // Wave 3 (2.4): o checkpoint anterior é lido ANTES de gravar o novo — a
  // timeline recebe o DIFF, nunca o snapshot. Emitir a cada turno encheria a
  // tela com "a IA pensou" e enterraria a única linha que muda o que alguém
  // faria a seguir.
  const checkpointAnterior = await latestCheckpoint(pool, tenantId, leadId);
  await insertCheckpoint(pool, { tenantId, leadId, jobId: job.id, content });

  // ── O TURNO DO OPERADOR (spec 16 §3.2) ─────────────────────────────────────
  //
  // Enfileirado AQUI, pelo RUNTIME, logo depois de o checkpoint existir — nunca
  // por decisão do modelo. Um Conversador que "chama" o Operador devolveria o
  // problema inteiro: voltaria a depender de o modelo lembrar, e o turno em que
  // ele não achasse necessário seria um lead parado no funil, em silêncio.
  //
  // Depois do checkpoint porque a declaração É o insumo do Operador; enfileirar
  // antes criaria uma corrida em que ele leria o checkpoint do turno ANTERIOR e
  // agiria sobre um turno que não é o seu.
  //
  // Fire-and-forget: falha ao enfileirar NÃO derruba um turno que já respondeu
  // ao cliente. O `sourceEventId` é o job do Conversador, então o retry da fila
  // não gera um segundo Operador para o mesmo turno.
  const disparo = decidirSeEnfileiraOperador({
    temAgentePublicado: agentConfig !== null,
    papelLigado: agentConfig?.operatorEnabled ?? false,
  });
  if (!disparo.enfileira) {
    runLog.info('turno do operador não enfileirado', { porque: disparo.porque });
  } else {
    try {
      const { deduped } = await enqueueJob(pool, tenantId, {
        kind: 'operator_turn',
        leadId,
        sourceEventId: job.id,
        payload: {
          conversation_id: input.conversationId,
          origin_job_id: job.id,
          agent_id: agentConfig?.agentId ?? null,
        },
      });
      runLog.info('turno do operador enfileirado', { deduped });
    } catch (err) {
      runLog.error('turno do operador NÃO foi enfileirado (o turno segue)', {
        error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      });
      // O CATCH TINHA A DOUTRINA CERTA E A CONCLUSÃO ERRADA.
      //
      // "O aviso não pode derrubar o turno que já respondeu ao cliente" está certo.
      // "Então basta um log" não: o enfileiramento é o ÚNICO mecanismo que garante o
      // disparo do papel, e falhar aqui significa que a promessa que o Conversador
      // acabou de fazer não terá dono e ninguém vai saber.
      //
      // É a mesma lição que este arquivo já aplicou no catch das capacidades MCP,
      // onde o comentário diz que a versão anterior "dizia 'o humano vê o log'. Não
      // vê." Lição aplicada numa ocorrência e não na irmã.
      //
      // Só quando HÁ promessa: sem ela o Operador teria decidido "nada a fazer", e
      // item sem ação é ruído — ruído ensina a ignorar a Central.
      const promessas = promessasEmAberto(content.declaracao ?? null);
      if (promessas.length > 0) {
        try {
          await insertInboxItem(
            pool,
            tenantId,
            {
              kind: 'promise_unfulfilled',
              severity: 'warn',
              title: 'Um retorno prometido a um cliente ficou sem dono',
              body:
                'O assistente prometeu algo a esta pessoa nesta conversa e o passo que registra ' +
                'o cumprimento não chegou a ser agendado. Abra a conversa, veja o que foi ' +
                'combinado e cumpra você mesmo.',
              refKind: 'conversation',
              refId: input.conversationId,
            },
            'kind_e_ref',
          );
        } catch (erroDoAviso) {
          runLog.error('aviso de promessa sem dono não foi gravado', {
            error: (erroDoAviso instanceof Error ? erroDoAviso.message : String(erroDoAviso)).slice(0, 120),
          });
        }
      }
    }
  }

  const mudanca = diffCheckpoint(
    checkpointAnterior
      ? {
          commitments: (checkpointAnterior.commitments ?? []) as string[],
          objections: (checkpointAnterior.objections ?? []) as string[],
          next_action: checkpointAnterior.next_action ?? null,
          rolling_summary: checkpointAnterior.rolling_summary ?? null,
        }
      : null,
    content,
  );

  if (mudanca.emit) {
    try {
      const r = await emitAgentActivityForContact({
        pool,
        organizationId: tenantId,
        contactId: leadId,
        type: "ai_turn",
        sourceModule: "agent",
        sourceId: job.id,
        // O lastro é a chamada de modelo que PRODUZIU este checkpoint
        // (llm_calls.id). Sem ele a linha entraria como 'system' e perderia a
        // autoria justamente no evento mais "de IA" que existe.
        ...(closing.callId ? { evidence: { llm_call_ids: [closing.callId] } } : {}),
        ...(agentConfig?.agentId ? { agentId: agentConfig.agentId } : {}),
        reason: mudanca.reason,
        payload: {
          added_commitments: mudanca.addedCommitments,
          added_objections: mudanca.addedObjections,
          next_action_changed: mudanca.nextActionChanged,
        },
      });
      if (!r.routed) {
        runLog.info('checkpoint sem negócio para pendurar: registrado no event_log', {
          reason: r.reason,
        });
      }
    } catch (err) {
      // A timeline do turno não pode derrubar o turno.
      runLog.error('falha ao registrar atividade de checkpoint (segue)', {
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  // ── A NOTA DO NEGÓCIO ──────────────────────────────────────────────────────
  //
  // O turno acabou de mexer em TUDO que a fórmula lê: compromissos e objeções
  // (o checkpoint acima) e a qualificação BANT (`lead_state`, escrita pelo
  // update_lead_state do modelo). Recalcular aqui é recalcular no instante em
  // que os sinais mudaram — não há evento melhor.
  //
  // ⚠️ POR QUE ISTO EXISTE: `recalculaScoreDoLead` estava escrita, testada e
  // com constraint no banco exigindo o `reason` — e SEM UM ÚNICO CHAMADOR no
  // repositório inteiro. Nenhuma nota jamais foi calculada. O modo de falha era
  // mudo: o card simplesmente não mostrava número, e "não tem nota ainda" é
  // indistinguível de "ninguém nunca calcula".
  //
  // Fora do `if (mudanca.emit)` DE PROPÓSITO: o BANT muda em turnos que não
  // mexem no checkpoint, e esses turnos também mudam a nota. Amarrar o cálculo
  // à emissão da atividade faria a nota envelhecer em silêncio — o mesmo
  // defeito, um andar acima.
  //
  // Falha aqui não derruba o turno: nota é derivado, e o próximo turno
  // recalcula. O que não pode é o cliente ficar sem resposta por causa dela.
  try {
    const alvo = await resolveActiveLeadForContact(
      (
        await pool.query<LeadCandidate>(
          `select l.id, l.organization_id, l.pipeline_id, l.status,
                  l.last_activity_at, l.created_at
             from crm_leads l
            where l.organization_id = $1 and l.contact_id = $2`,
          [tenantId, leadId],
        )
      ).rows,
    );
    if (alvo.routed) {
      const r = await recalculaScoreDoLead(pool, tenantId, alvo.leadId);
      runLog.info('score do negócio recalculado', {
        lead_id: alvo.leadId,
        gravou: r.gravou,
        ...(r.motivo !== undefined ? { motivo: r.motivo } : {}),
      });
    }
  } catch (err) {
    runLog.error('falha ao recalcular score (segue)', {
      error: err instanceof Error ? err.name : 'unknown',
    });
  }

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

  // Cap de warm-up/diário vetou toda tentativa de envio deste turno e nada saiu: sem
  // isto, o job terminava 'ok' com `messages_sent: 0` e o lead ficava sem resposta até
  // escrever de novo por conta própria (ou nunca) — medido em produção, 2026-08-29
  // (número no dia 0 de warm-up, cap batido pelo volume da própria conversa de teste).
  // Mesmo contrato da janela anti-ban (linha ~1233): adia sem gastar `attempts`, o job
  // volta a 'pending' na hora certa e o mesmo turno roda de novo, com o mesmo contexto.
  if (pacingCapVeto !== null && outcomes.length === 0) {
    // Capturado num `const`: `pacingCapVeto` é reatribuído numa closure em outro ponto do
    // turno, e o TS reabre a união (perde o `!== null`) depois de qualquer chamada — o
    // valor JÁ CHECADO não muda, só a inferência precisa de um nome que não reatribui.
    const veto = pacingCapVeto;
    await rescheduleJob(pool, job.id, ctx.workerId, {
      delayMs: Math.max(veto.nextAllowedAt.getTime() - clock().getTime(), 1_000),
      reason: `cap de envio (${veto.code}) atingido — turno adiado para a próxima abertura`,
    });
    runLog.info('turno adiado — cap de envio atingido antes de qualquer mensagem sair', {
      code: veto.code,
      proxima_abertura: veto.nextAllowedAt.toISOString(),
    });
    // O reagendamento acima trata toda mensagem represada igual — um lead relatando
    // risco de segurança (freio, fumaça, bateria esquentando) esperaria a mesma janela
    // que um "bom dia" qualquer, às vezes horas (medido em produção, tenant YADEA:
    // 20h+ represado num relato de bateria superaquecendo). Sem furar o cap de
    // warm-up/diário em si (proteção anti-banimento — mexer nisso é decisão de
    // produto, não deste guardrail), abre um alerta CRÍTICO na Central agora, pra um
    // humano poder responder manualmente pelo próprio WhatsApp enquanto o número
    // aquece. Dedupe por (kind, ref) — não reabre um já aberto pra esta conversa.
    if (detectUrgencySignal(inboundSignal)) {
      await insertInboxItem(
        pool,
        tenantId,
        {
          kind: 'handoff',
          severity: 'critical',
          title: 'Lead com sinal de urgência represado pelo cap de envio do número',
          body:
            `Mensagem do lead parece relatar risco/urgência, mas o número está em ` +
            `warm-up/bateu o cap diário (${veto.code}) — a resposta automática só sai em ` +
            `${veto.nextAllowedAt.toISOString()}. Considere responder manualmente pelo ` +
            `WhatsApp enquanto o número aquece.`,
          refKind: 'conversation',
          refId: input.conversationId,
        },
        'kind_e_ref',
      ).catch((err) => {
        runLog.warn('alerta de urgência represada por warmup_cap falhou (best-effort)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    throw new JobSettledError(
      'cap de envio atingido — job reagendado para a próxima abertura, sem mensagem enviada',
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
      buildOpening: ({
        previous,
        leadState,
        context,
        notesIndexBlock,
        projeta,
        entregues,
        compromissosBlock,
      }) =>
        buildOpeningMessage(
          previous,
          leadState,
          context,
          notesIndexBlock,
          projeta,
          entregues,
          compromissosBlock,
        ),
    });
  };
}
