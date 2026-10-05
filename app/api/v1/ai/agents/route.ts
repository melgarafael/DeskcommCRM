import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/ai/agents  — list agents da org ativa (manager+).
 *                            Inclui kind, priority, published_version_id, paused_at, operation_mode, operation_revision, archived_at,
 *                            e o provider/model da VERSÃO PUBLICADA (ver abaixo).
 *                            Filtro `?include_archived=true` opcional.
 * POST /api/v1/ai/agents  — create agent (admin). UM caminho de escrita.
 *                            Mode A (corpo legado, Spec 05 / EPIC-06): body sem
 *                              `version` → o corpo é CONVERTIDO num `version`
 *                              (ver `corpoLegadoComoCorpoDeCriacao`) e segue o
 *                              mesmo bloco
 *                              do Mode B. Nascia `kind='rag_bot'` SEM nenhuma
 *                              linha em `ai_agent_versions` — invisível para os
 *                              dois runtimes, que resolvem o agente pelo join de
 *                              `published_version_id` (#1357). Continua aceito,
 *                              continua devolvendo a linha do agente.
 *                            Mode B (mcp_agent S-13.06): body com `version` → cria
 *                              agent kind='mcp_agent' + ai_agent_versions v1 draft
 *                              numa sequência ordenada (rollback se versão falhar).
 *
 * Auth: sessão de navegador OU Bearer `dsk_...` (api_tokens), resolvidos por
 * `lib/api/auth-dual.ts`. `organization_id` sai do JWT (sessão) ou da LINHA DO
 * TOKEN — nunca do body.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { mcpAgentDraftRecords } from "@/lib/ai/agents/create-draft";
import { mensagemDoEscopo, validarEscopoDaVersao } from "@/lib/ai/agents/escopo";
import { agentCreateSchema } from "@/lib/ai/guardrails-schema";
import { corpoLegadoComoCorpoDeCriacao } from "@/lib/ai/agents/legado-para-versao";
import { agentMcpCreateSchema } from "@/lib/ai/agents/validation";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const AGENT_COLUMNS =
  "id, organization_id, name, description, model, system_prompt, is_active, is_default, kind, priority, published_version_id, paused_at, operation_mode, operation_revision, archived_at, config, guardrails, active_kb_version_id, created_at, updated_at";

/**
 * As mesmas colunas MAIS o join da versão publicada — só para a LISTAGEM.
 *
 * Existe porque `useAgentsList` refaz a busca por esta rota depois da primeira
 * pintura: sem o join aqui, o "modelo em vigor" do cartão voltava a ser o id do
 * CADASTRO no primeiro refetch, e o conserto durava um instante. Duas fontes para
 * a mesma lista têm de pedir as mesmas colunas.
 *
 * NÃO entra no POST de propósito: agente recém-criado tem
 * `published_version_id = null` por construção, o embed seria sempre nulo, e
 * pedi-lo ali faz o tipo gerado da linha inserida deixar de resolver (`GenericStringError`).
 */
const AGENT_COLUMNS_COM_VERSAO =
  AGENT_COLUMNS +
  ", versao_publicada:ai_agent_versions!ai_agents_published_version_id_fkey(provider, model)";

const VERSION_COLUMNS =
  "id, organization_id, agent_id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, proposal_ai_draft_enabled, cases_enabled, split_messages, split_max_chars, followup, operator_enabled, operator_model, operator_tool_ids, status, published_at, superseded_at, created_at, created_by,pipeline_ids,knowledge_source_ids,provisioning_origin,inbound_debounce_ms";

// ---------------------------------------------------------------------------
// GET — list
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_agents",
    role: "manager",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const { organizationId, supabase } = authz;

  const includeArchived = req.nextUrl.searchParams.get("include_archived") === "true";

  let query = supabase
    .from("ai_agents")
    .select(AGENT_COLUMNS_COM_VERSAO)
    .eq("organization_id", organizationId);

  if (!includeArchived) {
    query = query.is("archived_at", null);
  }

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) return fail("internal_error", "Erro ao listar agents.", 500, { requestId });

  return ok(data ?? [], { requestId });
}

// ---------------------------------------------------------------------------
// POST — create
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_agents",
    role: "admin",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const { organizationId, actor } = authz;

  const teto = await tetoDeEscritaDoToken(authz, "ai_agents", requestId);
  if (teto) return teto;

  const authUserId = actor.type === "user" ? actor.id : null;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const wantsMcp =
    typeof rawBody === "object" &&
    rawBody !== null &&
    ("version" in rawBody || (rawBody as { kind?: unknown }).kind === "mcp_agent");

  const admin = createAdminClient();

  // Dois formatos de corpo, UM caminho de escrita (issue #1357).
  //
  // O corpo legado — sem `version` — gravava `kind='rag_bot'` direto em
  // `ai_agents`, sem NENHUMA linha em `ai_agent_versions`. Era o formato que só
  // o editor antigo abria, e que os dois runtimes atuais nem enxergam: o
  // dispatcher do CRM e o agent-engine resolvem o agente por
  // `join ai_agent_versions v on v.id = a.published_version_id`
  // (`lib/agent-engine/agent/agent-config.ts:252`) — o agente nascia mudo, e a
  // única saída era a recuperação legada da tela. Ele agora deriva o payload de
  // versão a partir do próprio corpo e cai no MESMO bloco de quem já manda
  // `version`: criar passa a rascunhar v1, como fazem a tela e o onboarding.
  let corpo: unknown = rawBody;
  let veioDoCorpoLegado = false;
  if (!wantsMcp) {
    const parseLegado = agentCreateSchema.safeParse(rawBody);
    if (!parseLegado.success) {
      return fail("validation_failed", t("Campos inválidos."), 422, {
        requestId,
        details: parseLegado.error.flatten(),
      });
    }
    // `model` omitido mantém o default que o Modo A sempre gravou — não o
    // DEFAULT da coluna, que é outro (`claude-sonnet-4-6`).
    corpo = corpoLegadoComoCorpoDeCriacao({
      ...parseLegado.data,
      model: parseLegado.data.model ?? "anthropic/claude-sonnet-5",
    });
    veioDoCorpoLegado = true;
  }
  const parsed = agentMcpCreateSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;

  // Validate scope before the first write; a rejected form leaves no orphan.
  const escopo = await validarEscopoDaVersao(admin, organizationId, input.version);
  if (!escopo.ok) return fail("validation_failed", mensagemDoEscopo(escopo), 422, { requestId });
  const records = mcpAgentDraftRecords({ orgId: organizationId, userId: authUserId ?? "" }, input);
  const { data: agentRow, error: agentError } = await admin
    .from("ai_agents")
    .insert({ ...records.agent, created_by: authUserId })
    .select(AGENT_COLUMNS)
    .single();
  if (agentError || !agentRow)
    return fail("internal_error", "Erro ao criar agent.", 500, { requestId });
  const { data: versionRow, error: versionError } = await admin
    .from("ai_agent_versions")
    .insert({ ...records.version, created_by: authUserId })
    .select(VERSION_COLUMNS)
    .single();
  if (versionError || !versionRow) {
    await admin
      .from("ai_agents")
      .update({ archived_at: new Date().toISOString() })
      .eq("organization_id", organizationId)
      .eq("id", agentRow.id);
    return fail("internal_error", t("Erro ao criar versão inicial."), 500, { requestId });
  }

  void audit({
    action: "ai_agent.created",
    actorUserId: authUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId,
    resourceType: "ai_agent",
    resourceId: agentRow.id,
    requestId,
    metadata: {
      kind: "mcp_agent",
      first_version_id: versionRow.id,
      priority: input.priority,
      // De onde veio o corpo. Continua sendo uma criação de mcp_agent nos DOIS
      // casos — o rótulo é para saber quem ainda manda o formato de 2026-04.
      formato: veioDoCorpoLegado ? "legado" : "version",
    },
  });

  // O contrato de resposta de cada formato se mantém: o corpo legado pedia a
  // LINHA do agente e continua recebendo-a (agora com `kind = "mcp_agent"`; a v1
  // nasce RASCUNHO, então `published_version_id` fica null até publicar); o corpo
  // com `version` segue devolvendo `{ agent, version }`. Mudar o formato que
  // integrador já consome seria trocar o defeito por outro.
  return ok(veioDoCorpoLegado ? (agentRow as unknown) : { agent: agentRow, version: versionRow }, {
    status: 201,
    requestId,
  });
}

