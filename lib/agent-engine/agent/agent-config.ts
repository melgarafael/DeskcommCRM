/**
 * Config do agente por PONTEIRO PUBLICADO (Fase 2B da fusão) — a tela
 * app/app/ai/agents/[id] é a fonte de verdade da config do agente.
 *
 * Contrato:
 *   - resolvida no início de CADA turno (zero cache de processo): publicar na
 *     tela ⇒ o PRÓXIMO turno já usa a versão nova;
 *   - a versão publicada é imutável no banco (trigger da 0051) — mesma garantia
 *     versões-imutáveis+ponteiro do harness (0050);
 *   - seleção espelha o dispatcher do CRM: org + não-arquivado + published_version_id
 *     preenchido + binding da channel_session do job, ordenado por priority desc;
 *   - org e channel_session vêm de fonte confiável (row do job), nunca de payload;
 *   - sem agente publicado para a sessão ⇒ null (o turno cai no comportamento
 *     de fallback: playbook por ponteiro + settings.llm da org + knobs de env).
 */
import type pg from 'pg';

import { lerJanelaDeAtendimento, type JanelaDeAtendimento } from './janela-de-atendimento';
import { lerTextoDoAvisoForaDoHorario } from './aviso-fora-do-horario';
import { lerFiltroDePalavraChave } from './palavra-chave-do-gatilho';
import {
  carregarFatosDoContato,
  lerPublicoDoGatilho,
  passaNoPublico,
} from './publico-do-gatilho';

export interface PublishedAgentConfig {
  operationMode?: 'automatic' | 'assisted';
  pausedAt?: string | null;
  operationRevision?: string;
  agentId: string;
  versionId: string;
  agentName: string;
  systemPrompt: string;
  provider: string;
  model: string;
  credentialId: string | null;
  maxSteps: number;
  historyMessageWindow: number;
  historyTokenWindow: number;
  handoffKeywords: string[];
  handoffToolEnabled: boolean;
  /**
   * A versão publicada passa a conversa para uma pessoa por ASSUNTO JURÍDICO
   * (#2097, #2156)? Coluna `ai_agent_versions.handoff_legal_enabled`, padrão
   * LIGADO — quem não mexer fica com o resultado de antes.
   *
   * Opcional na interface porque nasce depois das fixtures que montam este
   * tipo à mão (`avisoForaDoHorario` é o precedente); quem consome lê com
   * `?? true`, que é o lado seguro: sem o campo, o comportamento é o de hoje.
   * Consumidor: `inbound-turn.ts` (a descrição da ferramenta de passagem).
   */
  handoffLegalEnabled?: boolean;
  proposalAiDraftEnabled: boolean;
  splitMessages: boolean;
  splitMaxChars: number;
  /** Janela de rajada inbound (ms) configurada na versão. `null` = usa a env. */
  inboundDebounceMs: number | null;
  /** input multimodal (imagem/áudio/pdf) habilitado no turno (Onda 3). */
  multimodalInput: boolean;
  /** tools open_human_case/provide_case_update habilitadas no turno (spec 15). */
  casesEnabled: boolean;
  /** JSON versionado com `followup.callback_enabled` e os fluxos normais. */
  followup?: unknown;
  /** tool_ids do catálogo MCP habilitadas na tela (2B-tools). */
  toolIds: string[];
  /**
   * Materiais que ESTE agente consulta (`ai_agent_versions.knowledge_source_ids`).
   * Vazio = NENHUM: a ferramenta de busca some do turno.
   */
  knowledgeSourceIds: string[];
  /**
   * LEGADO: a KB ativa do agente (`ai_agents.active_kb_version_id`).
   *
   * Só é usada quando `knowledgeSourceIds` vem vazio — o clone que ainda não
   * aplicou a 0181. A direção segura aqui é continuar respondendo com o acervo
   * antigo em vez de emudecer a busca por causa de um schema desatualizado.
   */
  activeKbVersionId: string | null;
  /** knobs de RAG do ai_agents.config (defaults calibrados na 0097: 5 / 0.40). */
  ragTopK: number;
  ragSimilarityThreshold: number;
  /**
   * O papel OPERADOR está ligado nesta versão (spec 16 §3.2)?
   *
   * Default do banco é FALSE: um papel que gasta uma chamada de modelo por turno
   * na chave do self-hoster não se liga por migration, se liga na tela.
   */
  operatorEnabled: boolean;
  /** modelo do papel Operador. `null` = herda `model` (o do Conversador). */
  operatorModel: string | null;
  /**
   * Capacidades do papel Operador — INDEPENDENTES de `toolIds` (do Conversador).
   * Vazio = o papel roda sem mão, que é estado legítimo e observável: ele ainda
   * registra promessa em aberto. Herdar as do Conversador daria 20 capacidades a
   * quem não escolheu nenhuma.
   */
  operatorToolIds: string[];
  /**
   * Funis em que o agente pode ESCREVER (spec 17 passo 3). Vazio = NENHUM.
   * Lido pelo gate em `lib/leads/escopo-de-funil.ts`.
   */
  pipelineIds: string[];
  /**
   * Horário de funcionamento declarado na tela (`trigger_config.filters.business_hours`).
   * `null` = atende a qualquer hora. Quem obedece é o turno inbound, adiando o
   * job para a abertura — ver `janela-de-atendimento.ts` para o defeito que isto
   * conserta (o campo existia na tela e nenhum leitor vivo o consultava).
   */
  janelaDeAtendimento: JanelaDeAtendimento | null;
  /**
   * Filtro "Só responder quando a mensagem falar de algo específico"
   * (`trigger_config.filters.keyword_regex`, #2679). `null` = sem filtro (o
   * agente entra em tudo). Quem obedece é o turno inbound, que encerra o job
   * sem resposta quando a mensagem não casa — ver `palavra-chave-do-gatilho.ts`
   * para o defeito que isto conserta e a direção da falha aberta.
   * Opcional porque nasce depois das fixtures que montam esta interface à mão.
   */
  filtroDePalavraChave?: RegExp | null;
  /**
   * Texto do aviso de fora do horário (#1926), lido do mesmo `trigger_config`
   * (`filters.business_hours.notice`). `null` = sem aviso configurado: quem
   * escreve fora da janela só espera a resposta na abertura, como antes.
   * Opcional porque nasce depois das fixtures que montam esta interface à mão.
   */
  avisoForaDoHorario?: string | null;
  /**
   * `ai_agents.config.mcp_externo_no_atendimento` (#2147): o servidor MCP
   * externo também carrega em turno com contato, com a identidade dele em
   * cabeçalho. Opcional porque nasce depois das fixtures; ausente = desligado.
   */
  mcpExternoNoAtendimento?: boolean;
  /** criadores (p/ mint do token efêmero de audit — padrão do runtime nativo). */
  versionCreatedBy: string | null;
  agentCreatedBy: string | null;
  /**
   * A resposta pode saír como nota de voz nesta versão (Fase 6b do plano de
   * voz). Default do banco é FALSE — mesma doutrina de `operatorEnabled`:
   * feature que gasta não se liga por migration, se liga na tela (que ainda
   * não existe — Fase 7).
   */
  vozEnabled: boolean;
  /** `'nunca' | 'espelhar' | 'sempre'` — decidido em `voz-do-turno.ts`. */
  vozQuando: 'nunca' | 'espelhar' | 'sempre';
}

interface Row {
  operation_mode: 'automatic' | 'assisted';
  paused_at: string | null;
  operation_revision: string;
  agent_id: string;
  version_id: string;
  agent_name: string;
  system_prompt: string;
  provider: string;
  model: string;
  credential_id: string | null;
  max_steps: number;
  history_message_window: number;
  history_token_window: number;
  handoff_keywords: string[] | null;
  handoff_tool_enabled: boolean;
  handoff_legal_enabled: boolean;
  proposal_ai_draft_enabled: boolean;
  split_messages: boolean;
  split_max_chars: number;
  inbound_debounce_ms: number | null;
  multimodal_input: boolean;
  cases_enabled: boolean;
  followup: unknown;
  tool_ids: string[] | null;
  active_kb_version_id: string | null;
  config: Record<string, unknown> | null;
  operator_enabled: boolean | null;
  operator_model: string | null;
  operator_tool_ids: string[] | null;
  pipeline_ids: string[] | null;
  knowledge_source_ids: string[] | null;
  trigger_config: unknown;
  version_created_by: string | null;
  agent_created_by: string | null;
  voz_enabled: boolean | null;
  voz_quando: string | null;
}

const SELECT_AGENT_CONFIG_COLUMNS = `a.operation_mode,a.paused_at,a.operation_revision::text,a.id as agent_id,
            v.id as version_id,
            a.name as agent_name,
            v.system_prompt,
            v.provider,
            v.model,
            v.credential_id,
            v.max_steps,
            v.history_message_window,
            v.history_token_window,
            v.handoff_keywords,
            v.handoff_tool_enabled,
            v.handoff_legal_enabled,
            v.proposal_ai_draft_enabled,
            v.split_messages,
            v.split_max_chars,
            v.inbound_debounce_ms,
            v.multimodal_input,
            v.cases_enabled,
            v.followup,
            v.tool_ids,
            a.active_kb_version_id,
            a.config,
            v.operator_enabled,
            v.operator_model,
            v.operator_tool_ids,
            v.pipeline_ids,
            v.knowledge_source_ids,
            v.voz_enabled,
            v.voz_quando,
            v.trigger_config,
            v.created_by as version_created_by,
            a.created_by as agent_created_by`;

/** Mapeamento Row (snake_case do banco) → PublishedAgentConfig, compartilhado
 * pelas duas variantes de loader (por channel_session e por agent id). */
function mapAgentConfigRow(r: Row): PublishedAgentConfig {
  const cfg = (r.config ?? {}) as {
    rag_top_k?: unknown;
    rag_similarity_threshold?: unknown;
    mcp_externo_no_atendimento?: unknown;
  };
  const ragTopK =
    typeof cfg.rag_top_k === 'number' &&
    Number.isInteger(cfg.rag_top_k) &&
    cfg.rag_top_k >= 1 &&
    cfg.rag_top_k <= 20
      ? cfg.rag_top_k
      : 5;
  const ragSimilarityThreshold =
    typeof cfg.rag_similarity_threshold === 'number' &&
    cfg.rag_similarity_threshold >= 0 &&
    cfg.rag_similarity_threshold <= 1
      ? cfg.rag_similarity_threshold
      : // 0.40 e nao 0.72: o valor foi CALIBRADO com medicao na migration 0097 (pergunta literal 0.849, parafrase 0.49-0.65, irrelevante 0.27).
        // Com 0.72 toda parafrase — que e como o cliente escreve — era descartada, e o RAG parecia quebrado funcionando.
        // O banco moveu o default; estes tres sitios de codigo ficaram para tras e venciam o banco, porque quem corta pelo limiar e o TypeScript.
        0.4;

  return {
    operationMode: r.operation_mode,
    pausedAt: r.paused_at,
    operationRevision: r.operation_revision,
    agentId: r.agent_id,
    versionId: r.version_id,
    agentName: r.agent_name,
    systemPrompt: r.system_prompt,
    provider: r.provider,
    model: r.model,
    credentialId: r.credential_id,
    maxSteps: r.max_steps,
    historyMessageWindow: r.history_message_window,
    historyTokenWindow: r.history_token_window,
    handoffKeywords: palavrasDePassagem(r.handoff_keywords),
    handoffToolEnabled: r.handoff_tool_enabled,
    handoffLegalEnabled: r.handoff_legal_enabled,
    proposalAiDraftEnabled: r.proposal_ai_draft_enabled,
    splitMessages: r.split_messages,
    splitMaxChars: r.split_max_chars,
    inboundDebounceMs: r.inbound_debounce_ms ?? null,
    multimodalInput: r.multimodal_input,
    casesEnabled: r.cases_enabled,
    followup: r.followup,
    toolIds: r.tool_ids ?? [],
    // `?? []` cobre o clone sem a 0181: sem a coluna, o agente cai no ponteiro
    // legado abaixo em vez de ficar sem material nenhum.
    knowledgeSourceIds: r.knowledge_source_ids ?? [],
    activeKbVersionId: r.active_kb_version_id,
    ragTopK,
    ragSimilarityThreshold,
    // `?? false` cobre o clone que ainda não aplicou a 0111: coluna ausente vem
    // como null/undefined, e a direção segura é o papel DESLIGADO — nunca gastar
    // modelo por causa de um schema desatualizado.
    operatorEnabled: r.operator_enabled ?? false,
    operatorModel: r.operator_model,
    // `?? []` cobre o clone sem a 0112: sem coluna, o papel roda sem mão em vez
    // de herdar a lista do Conversador — a direção segura é agir de menos.
    operatorToolIds: r.operator_tool_ids ?? [],
    // `?? []` = NENHUM funil. O clone que ainda não aplicou a 0125 nasce
    // fechado — a direção segura é agir de menos (mesma decisão da linha acima).
    pipelineIds: r.pipeline_ids ?? [],
    // Leitura DEFENSIVA e que falha ABERTA: jsonb livre com shape estranho vira
    // `null` (sem janela ⇒ atende sempre), nunca uma mordaça acidental.
    janelaDeAtendimento: lerJanelaDeAtendimento(r.trigger_config),
    avisoForaDoHorario: lerTextoDoAvisoForaDoHorario(r.trigger_config),
    // `=== true`: jsonb ausente ou com outro tipo é DESLIGADO, o lado seguro.
    mcpExternoNoAtendimento: cfg.mcp_externo_no_atendimento === true,
    // Mesma leitura defensiva da linha acima: regex torta/valor vazio ⇒ `null`
    // (sem filtro ⇒ entra em tudo), nunca uma mordaça acidental (#2679).
    filtroDePalavraChave: lerFiltroDePalavraChave(r.trigger_config),
    versionCreatedBy: r.version_created_by,
    agentCreatedBy: r.agent_created_by,
    // `?? false`: mesma direção segura de `operatorEnabled` — gasto novo nasce
    // desligado, nunca ligado por acidente.
    vozEnabled: r.voz_enabled ?? false,
    // `?? 'espelhar'` é o default do BANCO, repetido aqui só por simetria com
    // o resto do mapeamento — nunca deveria faltar (coluna NOT NULL), e um
    // valor fora do vocabulário (CHECK do banco impede, mas TS não confia
    // cegamente num texto livre) cai no mesmo default seguro.
    vozQuando:
      r.voz_quando === 'nunca' || r.voz_quando === 'sempre' ? r.voz_quando : 'espelhar',
  };
}

/** Por que a seleção devolveu este agente (ou nenhum). Vai para o log do turno. */
export type MotivoDaEscolha =
  /** Nenhum agente publicado neste número. */
  | 'sem_agente'
  /** Nenhum candidato declarou público: o primeiro da ordem de sempre atende. */
  | 'primeiro_da_fila'
  /** Havia público e este foi o primeiro candidato que o contato cumpre. */
  | 'publico_liberou'
  /** Havia público e NENHUM candidato aceitou este contato. */
  | 'publico_barrou'
  /** Havia público e o chamador não trouxe o contato — a régua não foi aplicada. */
  | 'sem_contato';

export interface EscolhaDoNumero {
  config: PublishedAgentConfig | null;
  motivo: MotivoDaEscolha;
}

/**
 * QUAL agente do número atende este contato — o ponto único da escolha (#3722).
 *
 * Até esta entrega a resposta era uma linha de SQL (`limit 1`): o agente de
 * maior prioridade do número atendia todo mundo, e o segundo publicado no mesmo
 * número NUNCA era escolhido. Agora a mesma consulta traz TODOS os candidatos,
 * na MESMA ordem de sempre (`pausado por último, priority desc, created_at
 * asc`), e a escolha passa a ser o primeiro cujo PÚBLICO o contato cumpre.
 *
 * ## Precedência — quem ganha quando dois públicos se sobrepõem
 *
 * **O primeiro elegível na ordem de sempre.** Não existe pontuação de
 * especificidade: um agente com `include_tags: [cliente]` e outro sem público
 * nenhum, ambos no número, são resolvidos pela ordem (não-pausado, prioridade
 * maior, mais antigo). Quem quiser que o agente de cliente vença põe
 * prioridade maior nele — a tela já mostra esse campo. É a régua que o
 * operador já conhece para desempatar dois agentes no mesmo número, estendida
 * ao público; inventar uma segunda (especificidade, quantidade de critérios)
 * seria uma regra que ninguém vê na tela.
 *
 * O pausado continua vindo por último, como antes: um pausado de prioridade
 * maior não cala o número inteiro (`agente-pausado-nao-sequestra-o-numero`).
 * E se o primeiro elegível for justamente um pausado, o turno para no
 * `pausedAt` dele — o comportamento de antes, preservado de propósito: pausar
 * significa "este agente não responde agora", não "passe para o próximo".
 *
 * ## Nenhum elegível = silêncio (e o genérico NÃO assume)
 *
 * `motivo: 'publico_barrou'` com `config: null`. Quem chama trata como
 * silêncio — o turno termina sem modelo, sem caso e sem aviso, com o motivo no
 * log, e a mensagem continua na caixa de entrada (mesma defesa do filtro de
 * palavra-chave). O agente genérico não assume porque ele não tem público
 * nenhum: assumir seria justamente o defeito da issue, agora com outro nome.
 *
 * ## Custo
 *
 * Os dados do contato só são lidos se ALGUM candidato declarou público. Quem
 * não usa o recurso não paga consulta extra por turno.
 */
export async function escolherAgenteDoNumero(
  db: pg.Pool,
  organizationId: string,
  channelSessionId: string,
  contactId?: string | null,
): Promise<EscolhaDoNumero> {
  const { rows } = await db.query<Row>(
    `select ${SELECT_AGENT_CONFIG_COLUMNS}
     from ai_agents a
     join ai_agent_versions v on v.id = a.published_version_id
     where a.organization_id = $1
       and a.archived_at is null
       -- is_active é semântica do rag_bot legado; para mcp_agent "ativo" =
       -- published_version_id preenchido + não arquivado. Pausar NÃO despublica
       -- (grava só paused_at): o pausado vem aqui, e o turno sai no pausedAt.
       and v.status = 'published'
       and v.channel_session_id = $2
     -- Quem está NO AR vem antes de qualquer pausado: sem isto um pausado de
     -- prioridade maior calava o número inteiro, com outro agente publicado nele
     -- (produção, 2026-10-05). O pausado segue vindo quando é o único: null
     -- aqui vira o agente genérico, e pausar faria o número voltar a responder.
     order by (a.paused_at is not null) asc, a.priority desc, a.created_at asc`,
    [organizationId, channelSessionId],
  );
  // O público (#3722) é lido da linha crua, ao lado da config: quem o consome é
  // só esta seleção, então ele não entra em `PublishedAgentConfig` (o turno não
  // tem o que fazer com ele). Lista torta ⇒ `null` ⇒ atende todo mundo.
  const candidatos = rows.map((r) => ({
    config: mapAgentConfigRow(r),
    publico: lerPublicoDoGatilho(r.trigger_config),
  }));
  const primeiro = candidatos[0];
  if (primeiro === undefined) return { config: null, motivo: 'sem_agente' };

  // Ninguém declarou público: comportamento de antes, sem tocar em `contacts`.
  if (!candidatos.some((c) => c.publico !== null)) {
    return { config: primeiro.config, motivo: 'primeiro_da_fila' };
  }

  // Público configurado mas sem contato no chamador: a régua não pode ser
  // aplicada, e chutar "barrou" calaria o número por um erro de fiação. Cai no
  // primeiro da fila e o motivo fica registrado.
  if (contactId == null) {
    return { config: primeiro.config, motivo: 'sem_contato' };
  }

  // Erro de leitura sobe de propósito: a fila re-tenta o job.
  const fatos = await carregarFatosDoContato(db, organizationId, contactId);
  for (const candidato of candidatos) {
    if (candidato.publico === null || passaNoPublico(candidato.publico, fatos)) {
      return { config: candidato.config, motivo: 'publico_liberou' };
    }
  }
  return { config: null, motivo: 'publico_barrou' };
}

/**
 * Agente publicado do número, ou `null`.
 *
 * Delega para `escolherAgenteDoNumero` — a régua do público é UMA, no mesmo
 * ponto da escolha. `contactId` é opcional porque há chamadores que não falam
 * de um contato (checagem de vínculo da campanha, leitura de configuração);
 * sem ele, o público não é aplicado e o motivo `sem_contato` fica no caminho
 * com resultado.
 */
export async function loadPublishedAgentConfig(
  db: pg.Pool,
  organizationId: string,
  channelSessionId: string,
  contactId?: string | null,
): Promise<PublishedAgentConfig | null> {
  return (await escolherAgenteDoNumero(db, organizationId, channelSessionId, contactId)).config;
}

/**
 * Variante por agent_id — usada pelo Intent Router (Fase 3): membros de
 * router (`ai_router_members.agent_id`) apontam pro agente diretamente, sem
 * vínculo com a channel_session do turno (quem tem o vínculo é o ROUTER, não
 * o agente-membro). `id` é único, então sem order/limit.
 */
export async function loadPublishedAgentConfigById(
  db: pg.Pool,
  organizationId: string,
  agentId: string,
): Promise<PublishedAgentConfig | null> {
  const { rows } = await db.query<Row>(
    `select ${SELECT_AGENT_CONFIG_COLUMNS}
     from ai_agents a
     join ai_agent_versions v on v.id = a.published_version_id
     where a.organization_id = $1
       and a.archived_at is null
       and v.status = 'published'
       and a.id = $2`,
    [organizationId, agentId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return mapAgentConfigRow(r);
}

/**
 * `ai_agent_versions.handoff_keywords` como `matchesHandoffKeyword` as espera:
 * minúsculas, sem espaço de borda, sem vazias. Exportada para quem lê a versão
 * por outro caminho (o worker de clima, pelo cliente admin) casar igual ao turno.
 */
export function palavrasDePassagem(brutas: readonly string[] | null | undefined): string[] {
  return (brutas ?? []).map((k) => k.toLowerCase().trim()).filter((k) => k !== '');
}

/**
 * Detecção de handoff por keywords CONFIGURADAS na tela (soma-se à detecção
 * determinística regex do engine — nunca a substitui). Case-insensitive,
 * substring simples: a semântica do EPIC-13 (sentinel de handoff_keywords).
 */
export function matchesHandoffKeyword(signal: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false;
  const lower = signal.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

/** Exact authenticated version, including a draft: uses the production projection. */
export async function loadAgentVersionConfig(
  db: pg.Pool,
  organizationId: string,
  agentId: string,
  versionId: string,
): Promise<PublishedAgentConfig | null> {
  const { rows } = await db.query<Row>(
    `select ${SELECT_AGENT_CONFIG_COLUMNS} from ai_agents a
 join ai_agent_versions v on v.organization_id=a.organization_id and v.agent_id=a.id
 where a.organization_id=$1 and a.id=$2 and v.id=$3 and a.archived_at is null`,
    [organizationId, agentId, versionId],
  );
  return rows[0] ? mapAgentConfigRow(rows[0]) : null;
}

/** Read-only selection for assistance: honor an existing conversation owner. */
export async function loadConversationAgentConfig(
  pool: pg.Pool,
  organizationId: string,
  conversationId: string,
  channelId: string,
) {
  const { rows } = await pool.query<{ active_ai_agent_id: string | null; contact_id: string | null }>(
    'select active_ai_agent_id,contact_id from conversations where organization_id=$1 and id=$2 and channel_session_id=$3',
    [organizationId, conversationId, channelId],
  );
  return rows[0]?.active_ai_agent_id
    ? loadPublishedAgentConfigById(pool, organizationId, rows[0].active_ai_agent_id)
    : // #3722: o público do agente do número é do CONTATO desta conversa.
      loadPublishedAgentConfig(pool, organizationId, channelId, rows[0]?.contact_id ?? null);
}
