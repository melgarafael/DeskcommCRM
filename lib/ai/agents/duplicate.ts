/**
 * Duplicação de agente — UMA implementação para os dois chamadores.
 *
 * Existiam duas: `POST /api/v1/ai/agents/:id/duplicate` clonava agente + versão
 * (Spec 10 §4.3), e `duplicateAgentAction` (o botão "Duplicar" da lista) fazia
 * cópia rasa só da linha de `ai_agents`. Para `mcp_agent` isso entrega uma casca:
 * prompt, ferramentas, credencial, canal, palavras de handoff, budgets e vínculo
 * de follow-up vivem TODOS em `ai_agent_versions`. O usuário duplicava e recebia
 * um agente em branco — e a UI é o caminho que as pessoas realmente usam.
 *
 * A escolha da versão de origem é a da rota: draft mais recente; sem draft, a
 * published. A cópia nasce sempre como draft v1 — duplicar não publica nada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  MENSAGEM_PROVEDOR_DESLIGADO,
  provedorDesligadoNaInstalacao,
} from "@/lib/ai/pontos/provedores-oferecidos";
import { nomeDaCopia } from "@/lib/followup/nome-da-copia";

import { mcpAgentDraftRecords } from "./create-draft";
import { corpoLegadoComoCorpoDeCriacao } from "./legado-para-versao";
import { agentMcpCreateSchema } from "./validation";

export const DUPLICATE_AGENT_COLUMNS =
  "id, organization_id, name, description, model, system_prompt, is_active, is_default, kind, priority, published_version_id, archived_at, config, guardrails, active_kb_version_id, created_at, updated_at";

/**
 * Uma das cópias da lista de colunas de `ai_agent_versions` vigiadas por
 * `tests/unit/agent-version-columns-drift.test.ts` — antes desta extração ela
 * vivia inline em `duplicate/route.ts`, e o teste aponta para cá desde então.
 * Coluna nova entra aqui E em `versionPayloadFrom`: o SELECT trazer a coluna não
 * basta, se o INSERT não a escreve a cópia nasce com o default do banco.
 */
export const DUPLICATE_VERSION_COLUMNS =
  "id, organization_id, agent_id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, handoff_legal_enabled, proposal_ai_draft_enabled, cases_enabled, split_messages, split_max_chars, followup, voz_enabled, voz_quando, operator_enabled, operator_model, operator_tool_ids, status, published_at, superseded_at, created_at, created_by,pipeline_ids,knowledge_source_ids,skill_names,image_vision_enabled,provisioning_origin,inbound_debounce_ms,reply_min_interval_ms";

export type DuplicateAgentError =
  | "not_found"
  | "no_version_to_duplicate"
  | "agent_insert_failed"
  | "version_insert_failed"
  | "provedor_desligado";

export type DuplicateAgentResult =
  | {
      ok: true;
      agent: Record<string, unknown>;
      version: Record<string, unknown> | null;
      /**
       * Versão de ORIGEM que foi clonada — não a nova. Existe para o audit poder
       * responder "cópia de qual versão?", que `version` (a nova) não responde.
       *
       * `null` quando a origem era legada SEM versão nenhuma: a cópia nasceu
       * pelo caminho da criação (#1357), então não há versão de origem que citar.
       */
      sourceVersionId: string | null;
    }
  | { ok: false; error: DuplicateAgentError; message?: string };

/**
 * Campos da versão que são copiados. Lista explícita (e não spread do row) porque
 * `id`, `version_number`, `status`, `published_at` e `superseded_at` NÃO podem
 * vazar da origem — a cópia é sempre uma draft nova.
 *
 * Exportada porque é a MESMA cópia que `lib/ai/apply-proposal.ts` faz ao aplicar
 * uma proposta (#2126): lá também se cria uma draft nova a partir da publicada,
 * e uma lista à mão lá perdia 11 chaves de `versionShapeSchema`. Quem grava
 * versão copiando de outra versão usa este helper — a cerca
 * (`tests/unit/agent-version-columns-drift.test.ts`) cobra o corpo dele.
 */
export function versionPayloadFrom(src: Record<string, unknown>) {
  return {
    system_prompt: src.system_prompt,
    provider: src.provider,
    model: src.model,
    credential_id: src.credential_id,
    tool_ids: src.tool_ids,
    trigger_config: src.trigger_config,
    channel_session_id: src.channel_session_id,
    max_steps: src.max_steps,
    token_budget: src.token_budget,
    cost_budget_cents: src.cost_budget_cents,
    history_message_window: src.history_message_window,
    history_token_window: src.history_token_window,
    handoff_keywords: src.handoff_keywords,
    handoff_tool_enabled: src.handoff_tool_enabled,
    // A chave por ASSUNTO JURÍDICO acompanha a cópia junto (#2156): sem ela
    // aqui, duplicar o agente ou aplicar uma proposta religaria a passagem em
    // silêncio, e o dono só descobriria no atendimento seguinte.
    handoff_legal_enabled: src.handoff_legal_enabled,
    // Ver as fotos (9108): a cópia vê o que a origem via; `?? true` é a versão de
    // antes da coluna, que via.
    image_vision_enabled: src.image_vision_enabled ?? true,
    proposal_ai_draft_enabled: src.proposal_ai_draft_enabled,
    cases_enabled: src.cases_enabled,
    // Papel Operador (spec 16). Duplicar um agente tem de duplicar o papel
    // inteiro: sem estas três, a cópia nasce com o Operador desligado e o dono
    // descobre isso quando o clone não organiza nada.
    operator_enabled: src.operator_enabled,
    operator_model: src.operator_model,
    operator_tool_ids: src.operator_tool_ids,
    split_messages: src.split_messages,
    split_max_chars: src.split_max_chars,
    inbound_debounce_ms: src.inbound_debounce_ms ?? null,
    reply_min_interval_ms: src.reply_min_interval_ms ?? null,
    followup: src.followup,
    voz_enabled: src.voz_enabled,
    voz_quando: src.voz_quando,
    // ESCOPO. As duas faltavam — `pipeline_ids` desde a 0125, e o cabeçalho
    // deste arquivo já mandava ("coluna nova entra aqui E em
    // versionPayloadFrom"). O SELECT trazia a coluna e o INSERT não a escrevia:
    // a cópia nascia com o default do banco, que é VAZIO. Duplicar um assistente
    // produzia um clone que não mexe em funil nenhum e não conhece material
    // nenhum — e o dono descobria isso no primeiro atendimento do clone.
    pipeline_ids: src.pipeline_ids ?? [],
    knowledge_source_ids: src.knowledge_source_ids ?? [],
    // Skills (9107): copia SEM conferir, a mesma regra dos dois escopos acima. Um
    // nome que não existe mais aparece sinalizado na tela do agente, e a próxima
    // gravação pela tela ou pela API o recusa.
    skill_names: src.skill_names ?? null,
  };
}

/** Versão de origem: draft mais recente; sem draft, a published. `null` = agente sem versão. */
export async function pickSourceVersion(
  admin: SupabaseClient,
  orgId: string,
  agentId: string,
): Promise<Record<string, unknown> | null> {
  const { data: draft } = await admin
    .from("ai_agent_versions")
    .select(DUPLICATE_VERSION_COLUMNS)
    .eq("organization_id", orgId)
    .eq("agent_id", agentId)
    .eq("status", "draft")
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (draft) return draft as Record<string, unknown>;

  const { data: published } = await admin
    .from("ai_agent_versions")
    .select(DUPLICATE_VERSION_COLUMNS)
    .eq("organization_id", orgId)
    .eq("agent_id", agentId)
    .eq("status", "published")
    .limit(1)
    .maybeSingle();
  return (published as Record<string, unknown> | null) ?? null;
}

/** Teto de `ai_agents.name` — o mesmo de `agentMcpCreateSchema` (`validation.ts`). */
const TETO_NOME_DO_AGENTE = 120;

/**
 * Nome da cópia, LIVRE na organização. `ai_agents` tem
 * `unique (organization_id, name)`: duplicar o mesmo agente duas vezes com o
 * nome fixo " (cópia)" fazia o segundo INSERT bater no índice, e a rota
 * devolvia 500. A segunda cópia vira "X (cópia 2)", a terceira "X (cópia 3)".
 *
 * A régua é a de `lib/followup/nome-da-copia` (o mesmo problema em
 * `followup_flow_pointers`): primeiro sufixo livre, e nome que já é cópia
 * continua a mesma linhagem. Aqui só muda o teto — 120 do schema do agente,
 * não os 80 do fluxo — e o nome do agente NUNCA é reusado, porque a lista
 * `ocupados` chega com o original e com todas as cópias anteriores.
 */
export function nomeLivreDoAgente(original: string, ocupados: Iterable<string>): string {
  return nomeDaCopia(original, ocupados, { teto: TETO_NOME_DO_AGENTE, raizVazia: "Agente" });
}

/**
 * `ai_agents.model` da cópia: `provedor/modelo` da versão copiada quando ela
 * diz os dois; sem isso, o cadastro da origem (o comportamento de antes).
 */
export function modeloDoCadastroDaCopia(
  srcAgent: Record<string, unknown>,
  srcVersion: Record<string, unknown> | null,
): unknown {
  const provedor = typeof srcVersion?.provider === "string" ? srcVersion.provider.trim() : "";
  const modelo = typeof srcVersion?.model === "string" ? srcVersion.model.trim() : "";
  if (provedor && modelo) return `${provedor}/${modelo}`;
  return srcAgent.model;
}

/** O 23505 do índice de nome — e só dele: outra violação única não é corrida de nome. */
function ehNomeRepetido(erro: { code?: string; message?: string } | null): boolean {
  return erro?.code === "23505" && (erro.message ?? "").includes("ai_agents_name_unique");
}

export async function duplicateAgentWithVersion(
  admin: SupabaseClient,
  // `actorUserId` é `null` quando quem duplica é um token de integração: a
  // coluna `created_by` das duas tabelas aceita nulo, e id de token nunca vai
  // para coluna de pessoa.
  input: { orgId: string; agentId: string; actorUserId: string | null; requireVersion: boolean },
): Promise<DuplicateAgentResult> {
  const { orgId, agentId, actorUserId, requireVersion } = input;

  const { data: srcAgent } = await admin
    .from("ai_agents")
    .select(DUPLICATE_AGENT_COLUMNS)
    .eq("id", agentId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!srcAgent) return { ok: false, error: "not_found" };

  const src = srcAgent as Record<string, unknown>;
  const isMcp = src.kind === "mcp_agent";

  // A escolha da versão é por VERSÃO, não por `kind` (#1357): um `rag_bot` que
  // já passou pela recuperação legada TEM versão e ela é a fonte da cópia.
  const srcVersion = await pickSourceVersion(admin, orgId, agentId);

  // Origem legada SEM versão nenhuma: era o único caso que copiava a CASCA —
  // `kind: src.kind ?? "rag_bot"`, `is_active: false` e nenhuma linha em
  // `ai_agent_versions`, isto é, um clone que os dois runtimes não enxergam
  // (ambos resolvem o agente por `published_version_id`). Ele nasce agora pelo
  // MESMO caminho de criar: mcp_agent + v1 draft montada das colunas legadas.
  const origemLegadaSemVersao = !isMcp && !srcVersion;

  // A rota da API trata "mcp_agent sem versão" como conflito: a verdade de um
  // mcp_agent vive nas versões, e uma sem nenhuma é estado quebrado — não tem
  // o que clonar. O legado não cai aqui porque dele ainda dá para montar a v1.
  if (!srcVersion && !origemLegadaSemVersao && requireVersion) {
    return { ok: false, error: "no_version_to_duplicate" };
  }

  // Nomes já usados NESTA organização: o índice é `unique (organization_id,
  // name)`, então outra organização com o mesmo nome não concorre. Sem esta
  // lista a segunda duplicação do mesmo agente tentava "X (cópia)" de novo.
  // Leitura que falha não inventa nome livre: cai na lista vazia e o INSERT
  // decide — é o comportamento de antes, sem esconder erro de banco atrás de
  // um sufixo.
  const nomeLivre = async (tambemOcupados: string[] = []): Promise<string> => {
    const { data: nomesOcupados } = await admin
      .from("ai_agents")
      .select("name")
      .eq("organization_id", orgId);
    return nomeLivreDoAgente(String(src.name), [
      ...(nomesOcupados ?? []).map((linha) => String((linha as { name: unknown }).name)),
      ...tambemOcupados,
    ]);
  };
  let nome = await nomeLivre();

  // Para a origem legada a RECEITA é a da criação canônica (`mcpAgentDraftRecords`),
  // não uma reimplementação: os defaults de budgets/handoff/follow-up/operador
  // saem do MESMO `versionShapeSchema` pelo qual a tela cria uma v1. O resultado
  // é emendado com o que duplicar copia de verdade (config, guardrails, acervo).
  // `safeParse` antes da receita: `mcpAgentDraftRecords` usa `parse`, que LANÇA,
  // e uma linha legada escrita direto no banco (prompt com menos de 10
  // caracteres) faria a duplicação estourar ZodError em vez de recusar.
  const corpoLegado = origemLegadaSemVersao
    ? agentMcpCreateSchema.safeParse(
        corpoLegadoComoCorpoDeCriacao({
          system_prompt: (src.system_prompt as string | null) ?? null,
          model: (src.model as string | null) ?? null,
          name: nome,
          description: (src.description as string | null) ?? null,
          priority: (src.priority as number | null) ?? 0,
        }),
      )
    : null;
  if (corpoLegado && !corpoLegado.success) {
    return { ok: false, error: "agent_insert_failed", message: corpoLegado.error.message };
  }
  const receitaLegada = corpoLegado
    ? mcpAgentDraftRecords({ orgId, userId: actorUserId ?? "" }, corpoLegado.data)
    : null;

  // A cópia GRAVA o provedor da origem, e gravar passa pela mesma régua do
  // editor (#2458): com o módulo `login_codex` desligado, a assinatura do
  // ChatGPT não volta por aqui. Recusar, e não trocar de provedor em silêncio:
  // quem duplica espera uma cópia, e uma cópia que fala com outra IA seria
  // surpresa descoberta no primeiro atendimento. Antes do primeiro insert, para
  // a recusa não deixar agente órfão.
  if (await provedorDesligadoNaInstalacao(admin, srcVersion?.provider as string | undefined)) {
    return { ok: false, error: "provedor_desligado", message: MENSAGEM_PROVEDOR_DESLIGADO };
  }

  // Duas duplicações SIMULTÂNEAS leem a mesma lista e escolhem o mesmo nome:
  // a perdedora bate no índice. Ela relê a lista e tenta o próximo livre —
  // o INSERT do agente é a primeira escrita, então repetir não deixa resto.
  const inserirAgente = (nomeTentado: string) =>
    admin
      .from("ai_agents")
      .insert({
        organization_id: orgId,
        // O nome é o da TENTATIVA, não `receitaLegada.agent.name`: depois de uma
        // colisão o nome livre muda, e a receita guardou o da primeira leitura.
        name: nomeTentado,
        description: receitaLegada ? receitaLegada.agent.description : src.description,
        // O modelo do cadastro sai da VERSÃO copiada, na mesma forma da criação
        // (`create-draft.ts`: `provedor/modelo`). `src.model` é o modelo do dia
        // em que a ORIGEM foi criada — publicar ou editar a versão não o
        // sincroniza —, e a cópia nasce sem versão publicada: o cartão da lista
        // lê justamente esta coluna e anunciava o modelo padrão (ex.: anthropic ·
        // claude-sonnet-4-6) para uma cópia que fala com a OpenAI.
        model: receitaLegada ? receitaLegada.agent.model : modeloDoCadastroDaCopia(src, srcVersion),
        system_prompt: receitaLegada ? receitaLegada.agent.system_prompt : src.system_prompt,
        // A origem legada SEM versão vira `mcp_agent` junto com a v1 que a
        // acompanha (#1357): um `rag_bot` sem versão é invisível para o CRM e para
        // o agent-engine — copiar esse estado era clonar um mudo. Um `rag_bot` que
        // JÁ TEM versão continua sendo copiado como `rag_bot`, com a v1 rascunho.
        kind: receitaLegada ? "mcp_agent" : (src.kind ?? "rag_bot"),
        priority: src.priority ?? 0,
        // Cópia nasce fora do ar: sem published_version_id, nenhum runtime a enxerga.
        // Para a origem legada vale o mesmo — a v1 nasce como DRAFT, não publicada.
        is_active: isMcp ? true : false,
        is_default: false,
        config: src.config ?? {},
        guardrails: src.guardrails ?? null,
        active_kb_version_id: src.active_kb_version_id,
        created_by: actorUserId,
      })
      .select(DUPLICATE_AGENT_COLUMNS)
      .single();

  let { data: newAgent, error: agentErr } = await inserirAgente(nome);
  // ponytail: 3 tentativas cobrem o clique duplo; corrida maior vira o 500 de antes.
  for (let tentativa = 1; tentativa < 3 && ehNomeRepetido(agentErr); tentativa++) {
    nome = await nomeLivre([nome]);
    ({ data: newAgent, error: agentErr } = await inserirAgente(nome));
  }

  if (agentErr || !newAgent) {
    return { ok: false, error: "agent_insert_failed", message: agentErr?.message };
  }

  // Origem legada: a v1 nasce da RECEITA da criação canônica. Origem com versão:
  // a v1 é a cópia da versão de origem (draft mais recente; sem draft, a publicada).
  // Nos DOIS casos há versão — o branch que devolvia casca sem `ai_agent_versions`
  // saiu (#1357).
  // Uma só origem de conteúdo, dois casos: a RECEITA da criação canônica
  // (origem legada sem versão, montada pelo `versionShapeSchema`) e a versão
  // de origem (cópia). Nos dois o payload sai de `versionPayloadFrom` — a
  // lista explícita de colunas de conteúdo — então a cerca de
  // `tests/unit/agent-version-columns-drift.test.ts` cobra o MESMO alvo dos
  // dois casos, como cobrava antes de #1357. `id`, `organization_id`,
  // `agent_id`, `version_number`, `status` e `created_by` não vêm daqui: são
  // do objeto literal do insert logo abaixo.
  const origemDaVersao: Record<string, unknown> = receitaLegada
    ? (receitaLegada.version as Record<string, unknown>)
    : (srcVersion as Record<string, unknown>);

  const { data: newVersion, error: versionErr } = await admin
    .from("ai_agent_versions")
    .insert({
      ...versionPayloadFrom(origemDaVersao),
      organization_id: orgId,
      agent_id: (newAgent as { id: string }).id,
      version_number: 1,
      status: "draft",
      created_by: actorUserId,
    })
    .select(DUPLICATE_VERSION_COLUMNS)
    .single();

  if (versionErr || !newVersion) {
    // Sem a versão, a cópia é a casca que este módulo existe para não produzir.
    await admin
      .from("ai_agents")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", (newAgent as { id: string }).id)
      .eq("organization_id", orgId);
    return { ok: false, error: "version_insert_failed", message: versionErr?.message };
  }

  return {
    ok: true,
    agent: newAgent as Record<string, unknown>,
    version: newVersion as Record<string, unknown>,
    sourceVersionId: srcVersion ? (srcVersion as { id: string }).id : null,
  };
}
