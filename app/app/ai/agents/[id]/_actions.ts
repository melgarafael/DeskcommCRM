"use server";
/**
 * Server actions para o editor de agent (Spec 12 §3 / S-13.11).
 *
 * `saveAgentDraftAction`  — admin. Cria/atualiza version draft.
 *   Estratégia: se já existir uma draft pro agent, PATCH nela (evita explosão
 *   de versões para edits incrementais). Senão, POST cria nova draft com
 *   version_number = max+1.
 *
 * `publishAgentAction`    — admin. Publica via `fn_publish_ai_agent_version`.
 *
 * `createMcpAgentAction`  — admin. Cria agent kind=mcp_agent + v1 draft (rota
 *   POST /api/v1/ai/agents Modo B).
 *
 * Todos os actions devolvem o objeto de resultado simples `{ ok, data?, error?, message? }`
 * porque a UI consome direto. Audit é emitido pelas rotas REST onde aplicável;
 * aqui chamamos os handlers internos para reusar a lógica.
 */
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { codigoDoEscopo, mensagemDoEscopo, validarEscopoDaVersao } from "@/lib/ai/agents/escopo";
import {
  CODIGO_NOME_DE_AGENTE_EM_USO,
  NOME_DE_AGENTE_EM_USO,
  RASCUNHO_SALVO_NOME_NAO_MUDOU,
  ehNomeDeAgenteRepetido,
} from "@/lib/ai/agents/nome-repetido";
import {
  agentMcpCreateSchema,
  agentMcpPatchSchema,
  versionCreateSchema,
} from "@/lib/ai/agents/validation";
import { publicarVersao, reverterParaVersao, salvarRascunhoDaVersao } from "@/lib/ai/agents/edicao";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ActionResult<T = void> =
  | { ok: true; data?: T }
  | { ok: false; error: string; message?: string; details?: unknown };

async function ensureAdmin() {
  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false as const, error: "unauthenticated" };
  const activeOrg = await resolveActiveOrg(authUser);
  if (!activeOrg) return { ok: false as const, error: "forbidden_tenant" };
  if (ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    return { ok: false as const, error: "forbidden_role" };
  }
  return { ok: true as const, authUser, activeOrg };
}

// ---------------------------------------------------------------------------
// saveAgentDraftAction
// ---------------------------------------------------------------------------

/**
 * Grava as colunas de cadastro em `ai_agents` — e só quando alguma mudou.
 *
 * Uma rodada que não mudou nada não é mutação, e auditar todo "Salvar rascunho"
 * encheria `api_audit_log` de linha sem efeito. A comparação é contra a linha
 * lida no mesmo request.
 */
async function gravarCadastroDoAgente(
  admin: ReturnType<typeof createAdminClient>,
  args: {
    agentId: string;
    orgId: string;
    actorUserId: string;
    requestId: string;
    atual: { name?: unknown; description?: unknown; priority?: unknown };
    pedido: { name?: string; description?: string | null; priority?: number };
  },
): Promise<{ erro: string; doBanco: unknown } | { mudou: string[] }> {
  const patch: Record<string, unknown> = {};
  for (const campo of ["name", "description", "priority"] as const) {
    const novo = args.pedido[campo];
    if (novo === undefined) continue;
    if ((args.atual[campo] ?? null) === (novo ?? null)) continue;
    patch[campo] = novo ?? null;
  }
  if (Object.keys(patch).length === 0) return { mudou: [] };

  // Service role bypassa RLS: o filtro de organização é manual e obrigatório.
  const { error } = await admin
    .from("ai_agents")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", args.agentId)
    .eq("organization_id", args.orgId);
  if (error) return { erro: error.message, doBanco: error };

  void audit({
    action: "ai_agent.updated",
    actorUserId: args.actorUserId,
    organizationId: args.orgId,
    resourceType: "ai_agent",
    resourceId: args.agentId,
    requestId: args.requestId,
    metadata: { fields: Object.keys(patch) },
  });
  return { mudou: Object.keys(patch) };
}

export async function saveAgentDraftAction(
  agentId: string,
  payload: unknown,
  /**
   * Nome, descrição e ordem de preferência — as três colunas que moram em
   * `ai_agents` e que `ai_agent_versions` NÃO tem. Elas viajavam só na criação;
   * em modo edição, `toVersionPayload` era o único construtor do envio e não as
   * incluía. A pessoa digitava o nome, via "Rascunho vN salvo.", publicava com
   * sucesso — e o cartão da lista seguia com o nome antigo, porque nada daquilo
   * era mentira: tudo se referia à VERSÃO, a única coisa realmente gravada.
   * (issue #463)
   */
  cadastro?: unknown,
): Promise<ActionResult<{ version_id: string; version_number: number }>> {
  if (!UUID_RX.test(agentId)) return { ok: false, error: "invalid_request" };
  const guard = await ensureAdmin();
  if (!guard.ok) return guard;
  const { authUser, activeOrg } = guard;

  const parsed = versionCreateSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: "validation_failed",
      details: parsed.error.flatten(),
    };
  }
  // Validado ANTES de qualquer escrita, junto do resto. Se o cadastro fosse
  // conferido depois, uma ordem inválida devolveria erro com a versão já
  // gravada; se fosse GRAVADO antes, um escopo inválido devolveria erro com o
  // nome já trocado — a lista mostrando o novo e o editor o velho.
  // `agentMcpPatchSchema` NÃO é a régua da rota REST (essa é `agentPatchSchema`,
  // em lib/ai/guardrails-schema.ts — mais estrita em name/description). É a régua
  // do cadastro do editor MCP, a mesma do formulário (AgentForm.tsx) e alinhada de
  // propósito com `agentMcpCreateSchema`, para criar e editar terem a mesma régua.
  // A afirmação de equivalência com o REST era falsa e ficou parada aqui até o
  // achado #532 medir a divergência.
  const cadastroParsed =
    cadastro === undefined ? null : agentMcpPatchSchema.safeParse(cadastro);
  if (cadastroParsed && !cadastroParsed.success) {
    return { ok: false, error: "validation_failed", details: cadastroParsed.error.flatten() };
  }

  const requestId = randomUUID();
  const admin = createAdminClient();

  // A regra inteira (agente da organização, escopo, QUAL rascunho recebe a
  // escrita, PATCH ou INSERT, auditoria) mora em `lib/ai/agents/edicao.ts` — a
  // mesma que o MCP do CRM usa. Aqui só sobra o que é da tela: o cadastro do
  // agente (nome, descrição, ordem) e o revalidate.
  const salvo = await salvarRascunhoDaVersao(admin, {
    orgId: activeOrg.orgId,
    agentId,
    payload,
    ator: { userId: authUser.id, apiTokenId: null, requestId },
  });
  if (!salvo.ok) return salvo;
  const { agente } = salvo.data;

  if (cadastroParsed?.success) {
    const r = await gravarCadastroDoAgente(admin, {
      agentId,
      orgId: activeOrg.orgId,
      actorUserId: authUser.id,
      requestId,
      atual: agente,
      pedido: cadastroParsed.data,
    });
    // As duas escritas não são atômicas. O desfecho tem de dizer o que
    // gravou: um toast verde genérico aqui reproduz o defeito com outra cara.
    if ("erro" in r) {
      if (ehNomeDeAgenteRepetido(r.doBanco)) {
        // O rascunho FOI salvo — o que não entrou foi o nome do cadastro. Dizer
        // só "já existe um agente com esse nome" faria a pessoa achar que
        // perdeu o trabalho; dizer só "o cadastro não" mandaria procurar
        // defeito onde há um nome para trocar.
        return {
          ok: false,
          error: CODIGO_NOME_DE_AGENTE_EM_USO,
          message: `${NOME_DE_AGENTE_EM_USO} ${RASCUNHO_SALVO_NOME_NAO_MUDOU}`,
        };
      }
      return {
        ok: false,
        error: "internal_error",
        message: `O rascunho foi salvo, mas o cadastro do agente não: ${r.erro}`,
      };
    }
    if (r.mudou.length > 0) revalidatePath("/app/ai/agents");
  }

  revalidatePath(`/app/ai/agents/${agentId}`);
  return {
    ok: true,
    data: { version_id: salvo.data.version_id, version_number: salvo.data.version_number },
  };
}

// ---------------------------------------------------------------------------
// publishAgentAction
// ---------------------------------------------------------------------------

export async function publishAgentAction(
  agentId: string,
  versionId: string,
): Promise<ActionResult<{ version_id: string; previous_version_id: string | null }>> {
  if (!UUID_RX.test(agentId) || !UUID_RX.test(versionId)) {
    return { ok: false, error: "invalid_request" };
  }
  const guard = await ensureAdmin();
  if (!guard.ok) return guard;
  const { authUser, activeOrg } = guard;

  const requestId = randomUUID();
  const admin = createAdminClient();

  // Ferramentas aceitas, `fn_publish_ai_agent_version`, `event_log` e a
  // auditoria `ai_agent.published`: `lib/ai/agents/edicao.ts`, a mesma do MCP.
  const r = await publicarVersao(admin, {
    orgId: activeOrg.orgId,
    agentId,
    versionId,
    ator: { userId: authUser.id, apiTokenId: null, requestId },
  });
  if (!r.ok) return r;

  revalidatePath(`/app/ai/agents/${agentId}`);
  revalidatePath("/app/ai/agents");
  return {
    ok: true,
    data: { version_id: r.data.version_id, previous_version_id: r.data.previous_version_id },
  };
}

// ---------------------------------------------------------------------------
// revertToVersionAction
// ---------------------------------------------------------------------------
//
// Cria uma nova draft idêntica a `versionId` e a publica imediatamente. O
// fluxo é: clone → INSERT draft v(max+1) → publishAgentVersion. Audit
// `ai_agent.reverted` registra a ponta original. Mesma validação de tools do
// publish original (espelha publish/route.ts).

export async function revertToVersionAction(
  agentId: string,
  versionId: string,
): Promise<
  ActionResult<{
    new_version_id: string;
    new_version_number: number;
    previous_version_id: string | null;
  }>
> {
  if (!UUID_RX.test(agentId) || !UUID_RX.test(versionId)) {
    return { ok: false, error: "invalid_request" };
  }
  const guard = await ensureAdmin();
  if (!guard.ok) return guard;
  const { authUser, activeOrg } = guard;

  const requestId = randomUUID();
  const admin = createAdminClient();

  // Clonar a origem num rascunho novo, publicar, apagar o clone se a
  // publicação recusar, `ai_agent.reverted`: `lib/ai/agents/edicao.ts`.
  const r = await reverterParaVersao(admin, {
    orgId: activeOrg.orgId,
    agentId,
    versionId,
    ator: { userId: authUser.id, apiTokenId: null, requestId },
  });
  if (!r.ok) return r;

  revalidatePath(`/app/ai/agents/${agentId}`);
  revalidatePath("/app/ai/agents");
  return { ok: true, data: r.data };
}

// ---------------------------------------------------------------------------
// createMcpAgentAction (página /ai/agents/new)
// ---------------------------------------------------------------------------

export async function createMcpAgentAction(
  payload: unknown,
): Promise<ActionResult<{ agent_id: string }>> {
  const guard = await ensureAdmin();
  if (!guard.ok) return guard;
  const { authUser, activeOrg } = guard;

  const parsed = agentMcpCreateSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: "validation_failed", details: parsed.error.flatten() };
  }

  const requestId = randomUUID();
  const admin = createAdminClient();

  // Antes da primeira escrita: recusado aqui, não sobra agente órfão.
  const escopo = await validarEscopoDaVersao(admin, activeOrg.orgId, parsed.data.version);
  if (!escopo.ok) {
    return { ok: false, error: codigoDoEscopo(escopo), message: mensagemDoEscopo(escopo) };
  }

  // Cria agent kind='mcp_agent' + v1 draft. Compensa rollback se versão falhar.
  const { data: agentRow, error: agentErr } = await admin
    .from("ai_agents")
    .insert({
      organization_id: activeOrg.orgId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      model: parsed.data.version.model,
      system_prompt: parsed.data.version.system_prompt,
      kind: "mcp_agent",
      priority: parsed.data.priority,
      is_active: false,
      is_default: false,
      created_by: authUser.id,
    })
    .select("id")
    .single();

  if (agentErr || !agentRow) {
    // Nome repetido na organização (#3952): o índice `ai_agents_name_unique` é
    // `(organization_id, name)`. A tela marca o campo de nome com a frase, então
    // a Action devolve o CÓDIGO e não a mensagem: quem traduz é o cliente, que
    // sabe o idioma de quem está logado (`useT`), e o toast genérico não é o
    // lugar de um erro que mora num campo.
    if (ehNomeDeAgenteRepetido(agentErr)) {
      return { ok: false, error: CODIGO_NOME_DE_AGENTE_EM_USO };
    }
    return { ok: false, error: "internal_error", message: agentErr?.message };
  }

  const v = parsed.data.version;
  const { error: versionErr } = await admin.from("ai_agent_versions").insert({
    organization_id: activeOrg.orgId,
    agent_id: agentRow.id,
    version_number: 1,
    system_prompt: v.system_prompt,
    provider: v.provider,
    model: v.model,
    credential_id: v.credential_id,
    tool_ids: v.tool_ids,
    trigger_config: v.trigger_config ?? undefined,
    channel_session_id: v.channel_session_id,
    max_steps: v.max_steps,
    token_budget: v.token_budget,
    cost_budget_cents: v.cost_budget_cents,
    history_message_window: v.history_message_window,
    history_token_window: v.history_token_window,
    handoff_keywords: v.handoff_keywords,
    handoff_tool_enabled: v.handoff_tool_enabled,
    handoff_legal_enabled: v.handoff_legal_enabled,
    image_vision_enabled: v.image_vision_enabled,
    proposal_ai_draft_enabled: v.proposal_ai_draft_enabled,
    cases_enabled: v.cases_enabled,
    split_messages: v.split_messages,
    split_max_chars: v.split_max_chars,
    inbound_debounce_ms: v.inbound_debounce_ms ?? null,
    reply_min_interval_ms: v.reply_min_interval_ms ?? null,
    followup: v.followup,
    voz_enabled: v.voz_enabled,
    voz_quando: v.voz_quando,
    // O corpo ACEITAVA estes cinco e o INSERT os descartava: criar o assistente
    // pela tela com papel Operador, escopo de funil ou material marcado produzia
    // uma versão com tudo no default do banco — desligado e vazio.
    operator_enabled: v.operator_enabled,
    operator_model: v.operator_model,
    operator_tool_ids: v.operator_tool_ids,
    pipeline_ids: v.pipeline_ids,
    knowledge_source_ids: v.knowledge_source_ids,
    skill_names: v.skill_names,
    status: "draft",
    created_by: authUser.id,
  });

  if (versionErr) {
    // Compensação — archiva o agent recém criado para evitar lixo.
    await admin
      .from("ai_agents")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", agentRow.id)
      .eq("organization_id", activeOrg.orgId);
    return { ok: false, error: "internal_error", message: versionErr.message };
  }

  void audit({
    action: "ai_agent.created",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_agent",
    resourceId: agentRow.id,
    requestId,
    metadata: { kind: "mcp_agent" },
  });

  revalidatePath("/app/ai/agents");
  return { ok: true, data: { agent_id: agentRow.id } };
}
