/**
 * Stage-classifier por turno (F3-11; padrão SalesGPT — blueprint 7.1/7.6). Um
 * classificador BARATO roda por turno (via o seam agnóstico F2-23 — modelo auxiliar,
 * budget checado ANTES da chamada dentro de runModelCall; NÃO é roteamento do modelo do
 * agente) e SUGERE em que estágio do funil a conversa está agora. A sugestão entra como
 * HINT no sufixo por-lead do prompt (volátil — regra de cache 15/F2-17, nunca no prefixo
 * estável); o MODELO do agente decide e, se concordar, confirma o avanço via
 * update_lead_state (a máquina de estados F2-10 continua a ÚNICA porta do lead_state).
 *
 * Este módulo NÃO tem caminho de escrita no estado do funil: não importa nem chama o
 * aplicador da máquina de estados (F2-10), não roda SQL de escrita na tabela do estado —
 * só LÊ o enum LEAD_STAGES para validar a sugestão. Prova em
 * daemon/test/stage-classifier.test.ts (whitelist do fonte). O classificador SUGERE; quem
 * grava é a F2-10.
 *
 * Divergência classificador×modelo (o classifier sugeriu X, o modelo confirmou Y≠X via
 * update_lead_state) vira candidato ao golden set — LINHA em `golden_candidates`
 * (migration 0428, issue #1695), mesmo destino da F3-09. A linha leva SÓ os dois estágios
 * e os ponteiros (lead_id, job_id): o sinal do turno (texto do lead — PII) não vai nem a
 * disco nem ao banco aqui, e log só leva os NOMES dos estágios (regra dura 8).
 *
 * tenant_id/lead_id vêm da ROW do job (closure do run), nunca do payload (regra dura 1).
 */
import type pg from 'pg';

import type { Logger } from '../obs/logger';
import type { Queryable } from '../queue/queue';
import type { ProviderRegistry } from '../edge/llm/providers';
import { LlmBudgetExceededError, runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import type { LlmResolveOverride } from '../edge/llm/credentials';
import type { LeadContext } from '../edge/crm/get-lead-context';
import { LEAD_STAGES, type LeadStage } from './lead-state';

/** Knobs do classificador (env STAGE_CLASSIFIER_*; defaults conservadores no .env.example). */
export interface StageClassifierKnobs {
  /**
   * modelo auxiliar BARATO do classificador (STAGE_CLASSIFIER_MODEL). Resolvido pela camada
   * agnóstica (override de `model` no seam F2-23) — NUNCA um id hardcoded; sujeito a
   * enabled_models da org quando a lista não é vazia. Ausente = usa o defaultModel da org.
   */
  model?: string;
}

/** Instrução FIXA do classificador — marcador estável (como CHECKPOINT_INSTRUCTION) p/ os testes. */
export const STAGE_CLASSIFIER_INSTRUCTION =
  'Você é um classificador auxiliar de estágio de funil de vendas (NÃO responde ao lead). ' +
  'Com base na conversa acima e no estágio atual, indique em que estágio a conversa está AGORA. ' +
  'Definições dos estágios:\n' +
  '- new: lead recém-chegado, ainda sem diálogo real (só um primeiro "oi"/pergunta genérica, sem contexto).\n' +
  '- contacted: já houve troca inicial e rapport, mas o lead ainda não revelou necessidade ou dor concreta.\n' +
  '- qualifying: o lead está revelando necessidade, contexto, dores ou tamanho da operação (descoberta em curso).\n' +
  '- qualified: orçamento, autoridade de decisão, necessidade e prazo (BANT) já confirmados — pronto para proposta.\n' +
  '- negotiating: há proposta/preço/condições na mesa e o lead está discutindo valor, desconto, parcelamento.\n' +
  '- won: o lead fechou/aceitou explicitamente (vai assinar, pagar, emitir nota).\n' +
  '- lost: o lead recusou, desistiu ou pediu para parar de ser contatado.\n' +
  'Responda SOMENTE com uma palavra — o nome exato do estágio, em inglês. Sem explicação, sem pontuação.';

function buildClassifierMessage(context: LeadContext, currentStage: LeadStage): string {
  return [
    '## Estágio atual do funil (registro)',
    currentStage,
    '',
    '## Conversa a classificar (transcript)',
    JSON.stringify(context),
    '',
    STAGE_CLASSIFIER_INSTRUCTION,
  ].join('\n');
}

/**
 * Extrai o estágio sugerido do texto do modelo (tolerante a prosa/pontuação em volta):
 * o PRIMEIRO estágio de LEAD_STAGES que aparece como palavra. Sem estágio reconhecível →
 * null (sem sugestão neste turno) — SEM ecoar o texto do modelo (pode carregar PII).
 */
export function parseStageSuggestion(text: string): LeadStage | null {
  const norm = text.toLowerCase();
  for (const stage of LEAD_STAGES) {
    if (new RegExp(`\\b${stage}\\b`).test(norm)) {
      return stage;
    }
  }
  return null;
}

/**
 * Roda o classificador auxiliar pelo seam agnóstico (purpose 'stage_classifier'; budget
 * da org checado ANTES da chamada dentro de runModelCall). Devolve o estágio SUGERIDO ou
 * null (saída sem estágio reconhecível → degrada sem sugestão; o turno segue normal).
 *
 * ═══ FALHA DO FORNECEDOR TAMBÉM DEGRADA PARA `null` ═══
 *
 * A sugestão é uma DICA para o conversador, não uma condição para atender o
 * cliente. Enquanto a exceção de `runModelCall` subia daqui, o turno inteiro
 * morria por causa do auxiliar: provedor fora do ar, modelo do ponto
 * `stage_classifier` apagado do painel, chave da empresa revogada — qualquer um
 * desses fazia o agente PARAR DE RESPONDER, embora o modelo do agente estivesse
 * de pé. O caminho dominante é o do ponto mal configurado, porque o classificador
 * roda em TODO turno (`main.ts` monta `stageClassifier` como literal, sempre
 * definido) e costuma apontar para um modelo barato diferente do modelo do agente.
 *
 * Degradar aqui não esconde a falha: `runModelCall` grava a chamada falha em
 * `llm_calls` (purpose `stage_classifier`) ANTES de relançar, e o warn abaixo
 * carimba o run. O que some é só a dica do turno.
 *
 * A EXCEÇÃO É O ORÇAMENTO. `LlmBudgetExceededError` continua subindo, porque quem
 * a espera é a escolta `comHandoffSeOrcamentoAcabar` (`inbound-turn.ts`), que passa
 * a conversa para uma pessoa em vez de deixar o lead no vácuo. Engoli-la aqui
 * trocaria o handoff por um turno que segue gastando até estourar mais adiante.
 */
export async function classifyStage(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId: string | null; jobId?: string },
  args: {
    context: LeadContext;
    currentStage: LeadStage;
    model?: string;
    llmOverride?: LlmResolveOverride;
  },
  deps: { registry?: ProviderRegistry; log: Logger },
): Promise<LeadStage | null> {
  let call: Awaited<ReturnType<typeof runModelCall>>;
  try {
    call = await runModelCall(
      db,
      cfg,
      {
        tenantId: ids.tenantId,
        leadId: ids.leadId,
        ...(ids.jobId !== undefined ? { jobId: ids.jobId } : {}),
        purpose: 'stage_classifier',
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.llmOverride !== undefined ? { llmOverride: args.llmOverride } : {}),
        messages: [
          { role: 'user', content: buildClassifierMessage(args.context, args.currentStage) },
        ],
      },
      { registry: deps.registry, log: deps.log },
    );
  } catch (err) {
    // Ver a nota do cabeçalho: dica não é condição de atendimento — menos o orçamento,
    // que a escolta do turno precisa receber para passar a conversa a uma pessoa.
    if (err instanceof LlmBudgetExceededError) throw err;
    // Sem PII: a mensagem do erro é do fornecedor/config, nunca o texto do lead.
    deps.log.warn('stage-classifier falhou — turno segue sem sugestão de estágio', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
    return null;
  }
  const suggestion = parseStageSuggestion(call.result.text);
  if (suggestion === null) {
    // aux batch sem estágio reconhecível NÃO é incidente do turno: sem PII, só o aviso.
    deps.log.warn(
      'stage-classifier: saída do modelo auxiliar sem estágio reconhecível — turno segue sem hint',
    );
  }
  return suggestion;
}

/**
 * Bloco de HINT do classificador para o SUFIXO por-lead do prompt (situacional, volátil —
 * depois do prefixo cacheável F2-17). É explicitamente uma DICA: o modelo decide e confirma
 * via update_lead_state (a máquina F2-10). Nunca instrui a gravar direto.
 */
export function renderStageHint(suggestion: LeadStage, currentStage: LeadStage): string {
  return [
    '## Sugestão automática de estágio (classificador auxiliar — apenas uma DICA)',
    `Um classificador barato estima que a conversa está no estágio "${suggestion}" ` +
      `(o registro atual do funil é "${currentStage}"). Isso é só uma sugestão: VOCÊ decide. ` +
      'Se concordar que houve avanço REAL, confirme com a tool update_lead_state (só o próximo ' +
      'estágio válido, com evidência). Se não houve avanço, ignore a sugestão.',
  ].join('\n');
}

export interface StageDivergence {
  /** estágio que o classificador auxiliar sugeriu neste turno. */
  suggested: LeadStage;
  /** estágio que o MODELO confirmou via update_lead_state neste turno. */
  confirmed: LeadStage;
}

/**
 * Grava a divergência classificador×modelo como candidato ao golden set
 * (SalesGPT/blueprint 7.6) — LINHA em `golden_candidates` (migration 0428, issue
 * #1695), não arquivo no disco do contêiner: o JSON era lido por nenhuma tela,
 * morria a cada atualização da imagem e ficava fora da cascata de anonimização.
 *
 * A linha é para CURADORIA HUMANA e guarda os dois ESTÁGIOS mais os ponteiros —
 * quem quiser ler o sinal do turno abre a conversa pela ficha, que já está no
 * alcance da cascata. Nunca é logado o sinal (regra dura 8): só os nomes dos
 * estágios. Um registro por job (`on conflict do nothing` no índice parcial):
 * retry regravou, não duplica. Falha de banco não derruba o turno.
 */
export async function recordStageDivergenceCandidate(
  db: Queryable,
  trace: {
    tenantId: string;
    leadId: string;
    jobId: string;
    divergence: StageDivergence;
  },
  log: Logger,
): Promise<void> {
  const { suggested, confirmed } = trace.divergence;
  try {
    await db.query(
      `insert into public.golden_candidates
         (organization_id, lead_id, job_id, fonte, estagio_sugerido, estagio_confirmado)
       values ($1, $2, $3, 'stage_classifier_divergence', $4, $5)
       on conflict do nothing`,
      [trace.tenantId, trace.leadId, trace.jobId, suggested, confirmed],
    );
  } catch (erro) {
    log.warn('candidato ao golden set não gravado (divergência de estágio)', {
      suggested,
      confirmed,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return;
  }
  // PII fora do log: só os nomes dos estágios (nunca o sinal).
  log.info('candidato ao golden set registrado (divergência de estágio classificador×modelo)', {
    suggested,
    confirmed,
  });
}
