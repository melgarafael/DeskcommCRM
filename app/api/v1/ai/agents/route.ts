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
import { codigoDoEscopo, mensagemDoEscopo, validarEscopoDaVersao } from "@/lib/ai/agents/escopo";
import { agentCreateSchema } from "@/lib/ai/guardrails-schema";
import { corpoLegadoComoCorpoDeCriacao } from "@/lib/ai/agents/legado-para-versao";
import { escolherModeloNoCatalogo } from "@/lib/ai/agents/escolher-modelo";
import { agentMcpCreateSchema } from "@/lib/ai/agents/validation";
import {
  logarResolucaoDeModelo,
  resolverParEfetivo,
  type LlmDaOrganizacao,
} from "@/lib/ai/par-provedor-modelo";
import { logger } from "@/lib/logger";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

/**
 * O `settings.llm` da organização — o provedor e o modelo que o produto usa
 * quando ninguém escolheu outro.
 *
 * Nunca lança: leitura que falha devolve `null` com o motivo no log, e a
 * resolução segue para a compatibilidade explícita do produto. Mesma doutrina
 * de `llmDaOrganizacao` em `lib/ai/gateway-binding.ts` — um clone sem o baseline
 * aplicado não pode deixar de criar agente por causa de uma consulta a mais.
 *
 * O client é o ADMIN (service role) com filtro programático por organização:
 * `organizations` só aceita escrita de platform admin, e a leitura por client de
 * sessão casaria zero linhas devolvendo SUCESSO (a armadilha medida em
 * `lib/ai/pontos/padrao-da-organizacao.ts`).
 */
async function lerLlmDaOrganizacao(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<LlmDaOrganizacao | null> {
  try {
    const { data, error } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) {
      logger.warn("[ai/agents] não consegui ler o provedor da organização", {
        organization_id: organizationId,
        motivo: error.message,
      });
      return null;
    }
    return ((data?.settings as { llm?: LlmDaOrganizacao } | null)?.llm ?? null) as
      | LlmDaOrganizacao
      | null;
  } catch (erro) {
    logger.warn("[ai/agents] falha ao ler o provedor da organização", {
      organization_id: organizationId,
      motivo: erro instanceof Error ? erro.name : typeof erro,
    });
    return null;
  }
}

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
  "id, organization_id, agent_id, version_number, system_prompt, provider, model, credential_id, tool_ids, trigger_config, channel_session_id, max_steps, token_budget, cost_budget_cents, history_message_window, history_token_window, handoff_keywords, handoff_tool_enabled, handoff_legal_enabled, proposal_ai_draft_enabled, cases_enabled, split_messages, split_max_chars, followup, operator_enabled, operator_model, operator_tool_ids, status, published_at, superseded_at, created_at, created_by,pipeline_ids,knowledge_source_ids,provisioning_origin,inbound_debounce_ms";

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
    // ═══ O PAR (PROVEDOR, MODELO) DESTE AGENTE — issue #2377 ═══
    //
    // O corpo legado pode OMITIR `model`, e até aqui omitir injetava
    // `anthropic/claude-sonnet-5` fixo. Numa instalação cujo provedor efetivo é
    // OpenAI (ou OpenRouter, ou Google), o agente nascia com um id que aquele
    // endereço não executa — o par cruzado nascia na ESCRITA, ficava gravado em
    // `ai_agent_versions` e só aparecia no turno, longe da tela que mostra o
    // provedor geral. Agora o par sai do MESMO ponto único que confere a
    // execução (`lib/ai/par-provedor-modelo.ts`): o padrão da organização
    // quando ele se sustenta, a compatibilidade EXPLÍCITA do provedor depois
    // (a Anthropic do legado, e só ela), o catálogo do provedor efetivo em
    // seguida — e, sem par sustentável, a criação é RECUSADA aqui, antes de
    // qualquer insert.
    const par = await resolverParEfetivo({
      modeloInformado: parseLegado.data.model,
      llmDaOrganizacao: await lerLlmDaOrganizacao(admin, organizationId),
      lerModeloDoCatalogo: async (provider) => {
        const escolha = await escolherModeloNoCatalogo(admin, provider);
        return escolha !== null && escolha.escolhido ? escolha.modelId : null;
      },
    });
    // O log estruturado da resolução: provedor, modelo, propósito e origem da
    // configuração — nunca chave, prompt, telefone ou conteúdo de conversa. O
    // propósito é `agent_turn` porque é ele que o modelo da versão executa
    // (`lib/agent-engine/agent/agent-config.ts` lê o da versão publicada): um
    // rótulo novo seria ponto oculto para o registro de IA.
    logarResolucaoDeModelo(logger, {
      organization_id: organizationId,
      purpose: "agent_turn",
      provider: par.provider,
      model: par.model,
      origem: par.ok ? par.origem : "sem_par_sustentavel",
      ...(par.ok ? {} : { motivo: par.motivo }),
    });
    if (!par.ok) {
      // A frase da recusa é LITERAL — chave montada em runtime não entra em
      // dicionário nenhum e o `t()` com template é reprovado por
      // `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`. O motivo, que é
      // diagnóstico e varia com a instalação, vai concatenado.
      return fail(
        "validation_failed",
        `${t("Não foi possível definir o provedor e o modelo deste agente.")} ${par.motivo}. Nada foi criado.`,
        422,
        { requestId },
      );
    }
    corpo = corpoLegadoComoCorpoDeCriacao({
      ...parseLegado.data,
      // O par vai INTEIRO (`provedor/modelo`): a ponte do legado reparte na
      // primeira barra, então um modelo de outro provedor deixa de cair no
      // provedor padrão dela por omissão.
      model: `${par.provider}/${par.model}`,
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
  if (!escopo.ok) return fail(codigoDoEscopo(escopo), mensagemDoEscopo(escopo), 422, { requestId });
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

