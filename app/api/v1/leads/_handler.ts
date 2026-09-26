import { observeServiceOrigin } from "@/lib/atendimento/origem";
import { createAdminClient } from "@/lib/supabase/admin";
/**
 * Core handlers para /api/v1/leads.
 *
 * REST cobre: createLeadHandler (POST), updateLeadHandler (PATCH).
 * MCP usa: listLeadsHandler, getLeadHandler além dos acima (S-13.04).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import { traduzir } from "@/lib/i18n/dicionario";
import { resolveOwnerPatch, type OwnerPatch, type OwnerPatchInput } from "@/lib/leads/owner-patch";
import { emitLeadActivity, stageChangeReason } from "@/lib/leads/activity-emitter";
import { listaLegivel } from "@/lib/leads/activity-vocabulary";
import { camposAlterados } from "@/lib/leads/campos-alterados";
import { RECUSA_DE_TROCA_DE_FUNIL } from "@/lib/leads/clonar-para-funil";
import {
  RECUSA_RETOMADA_ETAPA_INDISPONIVEL,
  RECUSA_RETOMADA_LEAD_ABERTO,
  RECUSA_RETOMADA_SEM_ETAPA,
  camposCopiadosNaRetomada,
  modoDeReabertura,
  recusaReabertura,
} from "@/lib/leads/reabertura";
import {
  recusaDeCamposObrigatorios,
  recusaDeMotivoDoGanho,
  settingsDoFunil,
  validaCamposExigidos,
} from "@/lib/leads/campos-exigidos";
import { ORIGEM_DA_PLANILHA } from "@/lib/leads/planilha";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import {
  decideMotivoDaPerda,
  recusaDeMotivoDaPerdaPeloBanco,
} from "@/lib/leads/motivo-da-perda";
import { motivosDaCategoria } from "@/lib/leads/motivos-de-perda-do-funil";
import type { CreateLeadInput, UpdateLeadInput } from "@/lib/schemas";
import { ehCorrecaoDeMovimentoDaIa } from "@/lib/leads/correcao-humana";

type SB = SupabaseClient;

const LEAD_COLS = "*";

/**
 * Aplica a regra de posse (0070) e valida a tenancy do agente.
 *
 * A FK garante que o agente EXISTE, não que é da MESMA org — sem este check um
 * id vazado atribuiria o negócio a um agente de outro tenant. `null` de retorno
 * = o chamador não mencionou dono.
 */
async function ownerPatchOrThrow(
  supabase: SB,
  ctx: HandlerCtx,
  input: OwnerPatchInput,
  /** Na edição, o responsável que o lead JÁ tem: reenviá-lo não é atribuir. */
  responsavelAtual: string | null = null,
): Promise<OwnerPatch | null> {
  const result = resolveOwnerPatch(input);
  if (!result.ok) {
    throw new ApiError(
      422,
      "validation_failed",
      undefined,
      ctx.requestId,
      traduzir("Um lead tem um dono: informe owner_user_id OU owner_agent_id.", ctx.idioma ?? "pt-BR"),
    );
  }
  if (!result.patch) return null;

  if (result.patch.owner_agent_id !== null) {
    const { data: agent, error: agentErr } = await supabase
      .from("ai_agents")
      .select("id")
      .eq("id", result.patch.owner_agent_id)
      .eq("organization_id", ctx.organization_id)
      .is("archived_at", null)
      .maybeSingle();

    if (agentErr) {
      throw new ApiError(500, "internal_error", undefined, ctx.requestId, agentErr.message);
    }
    if (!agent) {
      throw new ApiError(
        422,
        "validation_failed",
        undefined,
        ctx.requestId,
        traduzir("Agente não encontrado nesta organização.", ctx.idioma ?? "pt-BR"),
      );
    }
  }

  // O responsável humano passa pela mesma pergunta que o agente acima: é desta
  // organização? A FK de `owner_user_id` só garante que a pessoa EXISTE — sem
  // isto, um id de outra empresa (ou de quem foi desligado) virava dono do
  // negócio. Régua G3-04, a mesma do bulk-assign e da automação `assign_owner`:
  // vínculo não revogado e papel acima de viewer.
  //
  // Cliente ADMIN, filtrado pela org do contexto: a RLS de `user_organizations`
  // só mostra a um `agent` a própria linha, e o cliente de sessão recusaria
  // todo colega legítimo.
  //
  // Reenviar o responsável que o lead já tem não é atribuir: sem esta exceção,
  // um lead cujo dono foi desligado não poderia mais ser editado por quem manda
  // o formulário inteiro.
  const responsavel = result.patch.owner_user_id;
  if (responsavel !== null && responsavel !== responsavelAtual) {
    const { data: membro, error: membroErr } = await createAdminClient()
      .from("user_organizations")
      .select("role")
      .eq("organization_id", ctx.organization_id)
      .eq("user_id", responsavel)
      .is("revoked_at", null)
      .maybeSingle();

    if (membroErr) {
      throw new ApiError(500, "internal_error", undefined, ctx.requestId, membroErr.message);
    }
    if (!membro || membro.role === "viewer") {
      throw new ApiError(
        422,
        "validation_failed",
        undefined,
        ctx.requestId,
        traduzir("Responsável não é um atendente ativo desta organização.", ctx.idioma ?? "pt-BR"),
      );
    }
  }

  return result.patch;
}

/**
 * O contato do lead tem de ser DESTA organização.
 *
 * A FK `crm_leads_contact_id_fkey` referencia só `contacts(id)`: ela aceita o
 * contato de qualquer empresa. Todo escritor de lead — tela, MCP, token de
 * servidor, automação, importação, webhook de entrada, prospecção, clone —
 * passa por `createLeadHandler`/`updateLeadHandler`, então a pergunta mora aqui.
 *
 * 404 igual para "não existe" e "é de outra organização" (molde de
 * `app/api/v1/agenda/agendamentos/_handler.ts`): a resposta não pode confirmar
 * que o id existe noutro lugar. E responde ANTES do INSERT, para que um uuid
 * inexistente não vire 500 com a mensagem da FK.
 */
async function contatoDaOrgOrThrow(supabase: SB, ctx: HandlerCtx, contactId: string): Promise<void> {
  const { data: contato, error: contatoErr } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();

  if (contatoErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, contatoErr.message);
  }
  if (!contato) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Contato não encontrado.", ctx.idioma ?? "pt-BR"),
    );
  }
}

/**
 * O gatilho `trg_lead_so_liga_a_propria_empresa` (migration 0403) recusa com
 * SQLSTATE `PT404`/`PT422` o contato ou responsável de fora da organização. As
 * guardas acima respondem antes; isto cobre a janela entre conferir e gravar
 * (um vínculo revogado nesse meio) com a MESMA resposta, e não um 500.
 */
function recusaDaGuardaDoBanco(
  ctx: HandlerCtx,
  erro: { code?: string } | null,
): ApiError | null {
  if (erro?.code === "PT404") {
    return new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Contato não encontrado.", ctx.idioma ?? "pt-BR"),
    );
  }
  if (erro?.code === "PT422") {
    return new ApiError(
      422,
      "validation_failed",
      undefined,
      ctx.requestId,
      traduzir("Responsável não é um atendente ativo desta organização.", ctx.idioma ?? "pt-BR"),
    );
  }
  return null;
}

function actorAuditPayload(actor: Actor): {
  actorUserId: string | null;
  metadataActor: Record<string, unknown>;
} {
  if (actor.type === "user") {
    return { actorUserId: actor.id, metadataActor: { actor_type: "user" } };
  }
  if (actor.type === "webhook_source") {
    return {
      actorUserId: null,
      metadataActor: { actor_type: "webhook_source", actor_id: actor.id },
    };
  }
  // TOKEN DE SERVIDOR é caso próprio, e não o `else` de `ai_agent`: sem esta
  // linha ele seria auditado como agente de IA, e o audit passaria a afirmar que
  // uma integração é um agente — a única coisa que o audit não pode fazer é
  // mentir sobre quem agiu.
  if (actor.type === "api_token") {
    return {
      actorUserId: null,
      metadataActor: { actor_type: "api_token", actor_api_token_id: actor.id },
    };
  }
  return {
    actorUserId: null,
    metadataActor: {
      actor_type: "ai_agent",
      actor_id: actor.id,
      ...(actor.api_token_id ? { actor_api_token_id: actor.api_token_id } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// list (MCP-only por enquanto; sem GET REST nesta wave)
// ---------------------------------------------------------------------------

export interface ListLeadsQuery {
  pipeline_id?: string;
  stage_id?: string;
  status?: "open" | "won" | "lost";
  owner_user_id?: string;
  /** `lost_reason` exato (issue #1537) — o filtro de perda por motivo. */
  lost_reason?: string;
  /** Categoria do motivo de perda (issue #1537), resolvida no funil. */
  lost_reason_category?: string;
  limit?: number;
  cursor?: string | null;
}

export interface ListLeadsResult {
  leads: Array<Record<string, unknown>>;
  cursor: string | null;
  has_more: boolean;
}

interface LeadCursor {
  created_at: string;
  id: string;
}
function encLeadCursor(p: LeadCursor): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}
function decLeadCursor(raw: string): LeadCursor | null {
  try {
    const p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as LeadCursor;
    if (typeof p.id !== "string" || typeof p.created_at !== "string") return null;
    return p;
  } catch {
    return null;
  }
}

export async function listLeadsHandler(
  supabase: SB,
  ctx: HandlerCtx,
  q: ListLeadsQuery,
): Promise<ListLeadsResult> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  // ⚠️ O filtro de organização é a PRIMEIRA cláusula, e não uma opcional entre
  // as de baixo. Pelo MCP o client é service-role e a RLS não vale: sem ele, a
  // listagem entregava ao modelo os negócios de TODAS as organizações do banco.
  //
  // Foi o terceiro furo da mesma família neste arquivo, e o mais silencioso —
  // ler não devolve erro, então nada quebrava; o agente só passava a "saber"
  // coisas que não são da casa dele. Escopo de funil montado por cima de um
  // caminho que vaza ORG seria porta trancada em casa sem parede.
  let query = supabase
    .from("crm_leads")
    .select(LEAD_COLS)
    .eq("organization_id", ctx.organization_id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (q.pipeline_id) query = query.eq("pipeline_id", q.pipeline_id);
  if (q.stage_id) query = query.eq("stage_id", q.stage_id);
  if (q.status) query = query.eq("status", q.status);
  if (q.owner_user_id) query = query.eq("owner_user_id", q.owner_user_id);
  // #1537 — perda por motivo e por categoria. A categoria NÃO é coluna: ela
  // sai do `settings.lost_reasons` do funil, então o caminho é achar os rótulos
  // da categoria e filtrar por eles. Só os PERDIDOS têm motivo que valha; um
  // filtro de categoria sozinho não força status (quem quer "Cliente" pode
  // querer em qualquer aba), mas `lost_reason` em lead aberto não existe.
  if (q.lost_reason) query = query.eq("lost_reason", q.lost_reason);
  if (q.lost_reason_category) {
    const { data: funis, error: funisErr } = await supabase
      .from("crm_pipelines")
      .select("id, settings")
      .eq("organization_id", ctx.organization_id);
    if (funisErr) throw new ApiError(500, "internal_error", undefined, ctx.requestId, funisErr.message);
    const escopados = q.pipeline_id
      ? (funis ?? []).filter((f) => f.id === q.pipeline_id)
      : (funis ?? []);
    const permitidos = motivosDaCategoria(
      escopados.map((f) => ({ settings: f.settings })),
      q.lost_reason_category,
    );
    if (permitidos.length === 0) return { leads: [], cursor: null, has_more: false };
    query = query.in("lost_reason", permitidos);
  }

  if (q.cursor) {
    const c = decLeadCursor(q.cursor);
    if (!c) {
      throw new ApiError(
        400,
        "invalid_cursor",
        undefined,
        ctx.requestId,
        traduzir("Cursor inválido.", ctx.idioma ?? "pt-BR"),
      );
    }
    query = query.or(
      `created_at.lt.${c.created_at},and(created_at.eq.${c.created_at},id.lt.${c.id})`,
    );
  }

  const { data, error } = await query;
  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const cursor =
    hasMore && last
      ? encLeadCursor({ created_at: String(last.created_at), id: String(last.id) })
      : null;
  return { leads: page, cursor, has_more: hasMore };
}

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

export async function getLeadHandler(
  supabase: SB,
  ctx: HandlerCtx,
  leadId: string,
): Promise<Record<string, unknown>> {
  // ⚠️ `.eq("organization_id")` NÃO é redundante com a RLS — é o que segura o
  // caminho do AGENTE. Esta função é chamada por dois lados com garantias
  // opostas: pela rota HTTP com client de sessão (a RLS protege sozinha) e pelas
  // ferramentas MCP com `createAdminClient()` (lib/mcp/server.ts:39), que
  // **bypassa RLS**. Sem esta linha, o agente de uma organização LIA o negócio
  // de outra — medido, não suposto: `tests/invariants/mcp-nao-alcanca-outro-tenant.test.ts`
  // reprovava aqui antes deste filtro. É o anti-pattern 10 do CLAUDE.md.
  const { data, error } = await supabase
    .from("crm_leads")
    .select(LEAD_COLS)
    .eq("organization_id", ctx.organization_id)
    .eq("id", leadId)
    .maybeSingle();
  if (error) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
  }
  if (!data) {
    // 404, e não 403: dizer "existe, mas não é seu" confirmaria a existência de
    // um recurso alheio a quem tentou adivinhar o id.
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Lead não encontrado.", ctx.idioma ?? "pt-BR"),
    );
  }
  return data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export async function createLeadHandler(
  supabase: SB,
  ctx: HandlerCtx,
  input: CreateLeadInput & {
    custom_fields?: Record<string, unknown>;
    source_metadata?: Record<string, unknown>;
    /** Interno (webhook inbound) — idempotência via uniq_crm_leads_org_source_external. */
    external_id?: string;
    /**
     * Interno (importação de planilha). Marca o `lead.created` com
     * `metadata.via`, e o gatilho de follow-up "Lead criado" não inscreve em
     * lote quem entrou por planilha. Não vem do corpo da requisição.
     */
    via_planilha?: boolean;
    /**
     * Interno (clone para outro funil, pela tela ou pela automação). O dono veio
     * do negócio de ORIGEM, não de quem pediu: se ele não pode mais ser dono
     * (desligado, virou viewer, agente arquivado), o clone nasce sem dono e a
     * linha do tempo diz por quê — mover o negócio de funil não pode falhar
     * porque alguém saiu da empresa. Não vem do corpo da requisição.
     */
    dono_herdado?: boolean;
    /**
     * Interno (retomada de negócio perdido, issue #1538). O NOVO negócio aponta
     * para o encerrado que ele tenta de novo: é a coluna `retomado_de_lead_id`
     * (migration 0425) por onde "tentativas até ganhar" é derivado. Não vem do
     * corpo da requisição — quem cria a retomada é a rota `/retomar` (ou a tool
     * MCP `crm_retomar_lead`), nunca o POST genérico.
     */
    retomado_de_lead_id?: string | null;
  },
): Promise<Record<string, unknown>> {
  // Validate stage belongs to pipeline within active org.
  const { data: stage, error: stageErr } = await supabase
    .from("crm_stages")
    .select("id, pipeline_id, organization_id")
    .eq("id", input.stage_id)
    .maybeSingle();

  if (stageErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, stageErr.message);
  }
  if (!stage || stage.organization_id !== ctx.organization_id) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Stage não encontrado.", ctx.idioma ?? "pt-BR"),
    );
  }
  if (stage.pipeline_id !== input.pipeline_id) {
    throw new ApiError(
      422,
      "stage_pipeline_mismatch",
      undefined,
      ctx.requestId,
      traduzir("Stage não pertence ao pipeline informado.", ctx.idioma ?? "pt-BR"),
    );
  }

  if (input.contact_id) await contatoDaOrgOrThrow(supabase, ctx, input.contact_id);

  // next position_in_stage = MAX + 1000.
  const { data: maxRow, error: maxErr } = await supabase
    .from("crm_leads")
    .select("position_in_stage")
    .eq("stage_id", input.stage_id)
    .order("position_in_stage", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (maxErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, maxErr.message);
  }
  const nextPos = maxRow?.position_in_stage ? Number(maxRow.position_in_stage) + 1000 : 1000;

  // Nascer com dono e sem owner_kind é drift silencioso (o CHECK aceita kind
  // null): o lead teria dono e sumiria do filtro e das métricas por kind.
  const semDono = { owner_user_id: null, owner_agent_id: null, owner_kind: null } satisfies OwnerPatch;
  let donoHerdadoDescartado = false;
  let ownerPatch: OwnerPatch;
  try {
    ownerPatch = (await ownerPatchOrThrow(supabase, ctx, input)) ?? semDono;
  } catch (erro) {
    if (!(input.dono_herdado && erro instanceof ApiError && erro.status === 422)) throw erro;
    ownerPatch = semDono;
    donoHerdadoDescartado = true;
  }

  // A moeda de um lead novo é a que a ORGANIZAÇÃO declarou, não um literal.
  // `"BRL"` aqui (e o `.default("BRL")` que saiu de `createLeadSchema`) fazia
  // toda organização em peso ou dólar cadastrar lead em real: o valor certo com
  // o símbolo errado, que é o defeito que a migration 0208 já tinha consertado
  // no catálogo de produtos. Mesma função daquele conserto, pelo mesmo motivo
  // (uma leitura só, que não diverge entre caminhos de escrita).
  //
  // A leitura extra só acontece quando quem chamou NÃO mandou moeda: a REST com
  // `currency` no corpo passa direto. O import por planilha e o webhook de
  // captação NÃO mandam — mandavam `"BRL"` em duro, e o lead de uma organização
  // em euro nascia em real — e caem aqui. Ela não pode derrubar a criação:
  // `moedaDaOrganizacao` degrada para o padrão e deixa rastro (console.error +
  // Sentry) em vez de lançar.
  const currency = input.currency ?? (await moedaDaOrganizacao(supabase, ctx.organization_id));

  const serviceOrigin = ctx.serviceOrigin ?? await observeServiceOrigin(createAdminClient(), ctx.organization_id, input.contact_id ?? null);
  const { data: lead, error: insErr } = await supabase
    .from("crm_leads")
    .insert({
      organization_id: ctx.organization_id,
      pipeline_id: input.pipeline_id,
      stage_id: input.stage_id,
      title: input.title,
      description: input.description ?? null,
      contact_id: input.contact_id ?? null,
      value_cents: input.value_cents ?? null,
      currency,
      ...ownerPatch,
      assigned_at:
        ownerPatch.owner_kind === null ? null : new Date().toISOString(),
      expected_close_date: input.expected_close_date ?? null,
      tags: input.tags ?? [],
      source: input.source,
      source_metadata: input.source_metadata ?? {},
      external_id: input.external_id ?? null,
      custom_fields: input.custom_fields ?? {},
      retomado_de_lead_id: input.retomado_de_lead_id ?? null,
      status: "open",
      position_in_stage: nextPos,
      created_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
    })
    .select(LEAD_COLS)
    .single();

  const recusaNoInsert = recusaDaGuardaDoBanco(ctx, insErr);
  if (recusaNoInsert) throw recusaNoInsert;
  if (insErr || !lead) {
    throw new ApiError(
      500,
      "internal_error",
      undefined,
      ctx.requestId,
      insErr?.message ?? traduzir("Falha ao criar lead.", ctx.idioma ?? "pt-BR"),
    );
  }

  if (donoHerdadoDescartado) {
    const leadId = (lead as { id: string }).id;
    const atividade = await emitLeadActivity(supabase, {
      organizationId: ctx.organization_id,
      leadId,
      contactId: input.contact_id ?? null,
      type: "lead_edited",
      sourceModule: "crm",
      sourceId: leadId,
      actor: ctx.actor,
      reason: "Nasceu sem responsável: quem cuidava do negócio de origem não atende mais nesta empresa",
      payload: { fields: ["owner_user_id", "owner_agent_id"], motivo: "dono_da_origem_inativo" },
    });
    if (!atividade.ok) {
      await registraFalhaDeAtividade(supabase, {
        organizationId: ctx.organization_id,
        leadId,
        tipo: "lead_edited",
        origem: "leads/_handler.createLeadHandler",
        erro: atividade.error,
        requestId: ctx.requestId,
      });
    }
  }

  const a = actorAuditPayload(ctx.actor);
  await createAdminClient()
    .rpc("emit_event", {
      p_event_type: "lead.created",
      p_entity_kind: "crm_lead",
      p_entity_id: (lead as { id: string }).id,
      p_payload: {
        service_origin: serviceOrigin,
        pipeline_id: (lead as { pipeline_id: string }).pipeline_id,
        stage_id: (lead as { stage_id: string }).stage_id,
        title: (lead as { title: string }).title,
      },
      p_metadata: {
        request_id: ctx.requestId,
        ...a.metadataActor,
        ...(input.via_planilha ? { via: ORIGEM_DA_PLANILHA } : {}),
      },
      p_organization_id: ctx.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[lead.create] emit_event failed", error.message);
    });

  await audit({
    action: "lead.created",
    actorUserId: a.actorUserId,
    organizationId: ctx.organization_id,
    resourceType: "crm_lead",
    resourceId: (lead as { id: string }).id,
    requestId: ctx.requestId,
    metadata: {
      ...a.metadataActor,
      pipeline_id: (lead as { pipeline_id: string }).pipeline_id,
      stage_id: (lead as { stage_id: string }).stage_id,
      title: (lead as { title: string }).title,
    },
  });

  return lead as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

export async function updateLeadHandler(
  supabase: SB,
  ctx: HandlerCtx,
  leadId: string,
  input: UpdateLeadInput,
): Promise<Record<string, unknown>> {
  // `*` e nao lista explicita DE PROPOSITO: `camposAlterados` compara o patch
  // contra isto, e uma lista fixa faria todo campo NOVO do patch cair contra
  // `undefined` e ser marcado como alterado em toda edicao — o mesmo defeito
  // que este select conserta, reaparecendo por outra porta em seis meses.
  // ⚠️ Mesmo motivo do `getLeadHandler`: pelo MCP o client é service-role e a
  // RLS não vale. Sem este filtro, o agente de uma organização REESCREVIA o
  // negócio de outra — o teste de cross-tenant provou a escrita comparando o
  // título depois. Pior: o audit era gravado sob `existing.organization_id`,
  // ou seja, no log da VÍTIMA.
  const { data: existing, error: selErr } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("organization_id", ctx.organization_id)
    .eq("id", leadId)
    .maybeSingle();

  if (selErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, selErr.message);
  }
  if (!existing) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Lead não encontrado.", ctx.idioma ?? "pt-BR"),
    );
  }

  // Reenviar o contato que o lead já tem não é ligar a um contato novo.
  if (input.contact_id && input.contact_id !== existing.contact_id) {
    await contatoDaOrgOrThrow(supabase, ctx, input.contact_id);
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.contact_id !== undefined) patch.contact_id = input.contact_id;
  if (input.value_cents !== undefined) patch.value_cents = input.value_cents;
  if (input.currency !== undefined) patch.currency = input.currency;
  // Dono do negócio (0070): regra em lib/leads/owner-patch.ts, compartilhada
  // com create, bulk e MCP. owner_kind é DERIVADO — nunca lido do body.
  const ownerPatch = await ownerPatchOrThrow(
    supabase,
    ctx,
    input,
    (existing.owner_user_id as string | null) ?? null,
  );
  if (ownerPatch) {
    Object.assign(patch, ownerPatch);
    if (ownerPatch.owner_user_id !== null || ownerPatch.owner_agent_id !== null) {
      patch.assigned_at = new Date().toISOString();
    }
  }
  if (input.expected_close_date !== undefined) {
    patch.expected_close_date = input.expected_close_date;
  }
  if (input.tags !== undefined) patch.tags = input.tags;
  if (input.custom_fields !== undefined) {
    const prev =
      existing.custom_fields && typeof existing.custom_fields === "object" && !Array.isArray(existing.custom_fields)
        ? (existing.custom_fields as Record<string, unknown>)
        : {};
    patch.custom_fields = { ...prev, ...input.custom_fields };
  }

  // O filtro entra AQUI TAMBÉM, e não só no SELECT acima: entre ler e escrever
  // há uma janela, e defesa que depende de uma leitura anterior é defesa que
  // some quando alguém reordena o código.
  const tagServiceOrigin = input.tags !== undefined
    ? ctx.serviceOrigin ?? await observeServiceOrigin(createAdminClient(), ctx.organization_id, input.contact_id ?? existing.contact_id)
    : null;
  const { data: updated, error: updErr } = await supabase
    .from("crm_leads")
    .update(patch)
    .eq("organization_id", ctx.organization_id)
    .eq("id", leadId)
    .select(LEAD_COLS)
    .maybeSingle();

  const recusaNoUpdate = recusaDaGuardaDoBanco(ctx, updErr);
  if (recusaNoUpdate) throw recusaNoUpdate;
  if (updErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, updErr.message);
  }
  if (!updated) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Lead não encontrado.", ctx.idioma ?? "pt-BR"),
    );
  }

  const a = actorAuditPayload(ctx.actor);
  // O QUE MUDOU, nao o que foi enviado: o formulario do dossie manda o form
  // inteiro a cada salvamento, entao `Object.keys(input)` acusava cinco campos
  // quando a pessoa mexeu em um. Detalhe em lib/leads/campos-alterados.ts.
  const fields = camposAlterados(patch, existing as Record<string, unknown>);

  // A EDIÇÃO HUMANA ENTRA NA TIMELINE (wave 6). Antes disto, mexer num campo
  // era invisível: a IA deixava rastro e o humano não — meia continuidade
  // vendida como continuidade, e o dossiê mostraria só metade da vida do lead.
  //
  // O `reason` carrega QUAIS campos mudaram porque "dados alterados" sozinho
  // não muda o que ninguém faz a seguir; saber que mudou o VALOR é diferente de
  // saber que mudou a descrição. Os nomes vão em português — o que a pessoa lê
  // não pode ser o vocabulário da coluna.
  // Salvar sem mexer em nada NAO e um acontecimento. Sem esta guarda, abrir o
  // dossie e clicar Salvar geraria "Dados do negocio alterados" com a lista
  // vazia — ruido na timeline exatamente na superficie que promete contar a
  // vida do negocio.
  const atividadeEdicao = fields.length === 0 ? { ok: true as const } : await emitLeadActivity(supabase, {
    organizationId: existing.organization_id,
    leadId,
    contactId: (updated as { contact_id?: string | null }).contact_id ?? null,
    type: "lead_edited",
    sourceModule: "crm",
    sourceId: leadId,
    actor: ctx.actor,
    // ⚠️ O REASON NOMEIA OS CAMPOS, NUNCA OS VALORES. Se você veio aqui para
    // deixar a timeline "mais informativa" pondo o antes-e-depois — pare: neste
    // produto o TÍTULO É O NOME DO CLIENTE ("Carlos — Clínica Vida Odonto"), e
    // `custom_fields` é dado arbitrário do tenant, sem limite conhecido. O
    // reason é RENDERIZADO NA TELA e vai junto em captura, exportação e ticket
    // de suporte; o §9 proíbe PII nova em log, reason ou evidence.
    //
    // Quem precisa do valor anterior tem `api_audit_log`, que já registra a
    // mutação SOB CONTROLE DE ACESSO. Duplicar aqui criaria um segundo lugar
    // com o mesmo dado e menos proteção.
    //
    // NÃO confunda com a atividade de autorização vencida (wave 4), que mostra
    // antes-e-depois DE PROPÓSITO: lá o texto é a proposta do PRÓPRIO AGENTE,
    // escrita por máquina. A origem do texto é que decide, não a forma da frase.
    reason: `Alterou ${listaLegivel(fields)}`,
    payload: { fields },
  });
  if (!atividadeEdicao.ok) {
    // Rastro de mutação já ocorrida: falha BAIXO, mas contada (ver
    // lib/leads/activity-write-failure.ts).
    await registraFalhaDeAtividade(supabase, {
      organizationId: existing.organization_id,
      leadId,
      tipo: "lead_edited",
      origem: "leads/_handler.updateLeadHandler",
      erro: atividadeEdicao.error,
      requestId: ctx.requestId,
    });
  }

  await supabase
    .rpc("emit_event", {
      p_event_type: "lead.updated",
      p_entity_kind: "crm_lead",
      p_entity_id: leadId,
      p_payload: { fields },
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
      p_organization_id: existing.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[lead.update] emit_event failed", error.message);
    });

  if (input.tags !== undefined) {
    const prevTags: string[] = (existing as { tags?: string[] }).tags ?? [];
    const addedTags = input.tags.filter((t) => !prevTags.includes(t));
    if (addedTags.length) {
      await createAdminClient()
        .rpc("emit_event", {
          p_event_type: "lead.tag_added",
          p_entity_kind: "crm_lead",
          p_entity_id: leadId,
          p_payload: { added_tags: addedTags, tags: input.tags, service_origin: tagServiceOrigin },
          p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
          p_organization_id: existing.organization_id,
        })
        .then(({ error }) => {
          if (error) console.error("[lead.update] emit_event failed", error.message);
        });
    }
  }

  // ── A ÚLTIMA LEITURA VEM DEPOIS DA ÚLTIMA ESCRITA (issue #916) ─────────────
  //
  // O mesmo defeito do `moveLeadHandler`, no PATCH do dossiê: `updated` é o
  // retorno do UPDATE, e a atividade `lead_edited` gravada acima está na lista
  // positiva de `fn_update_last_activity_at` (supabase/baseline.sql) — o gatilho
  // faz `update crm_leads` numa transação POSTERIOR, e `fn_set_updated_at` troca
  // o `updated_at` de novo. Devolver `updated` entregava ao quadro um carimbo
  // que a própria edição já invalidou: `useEditLead` o grava no cache, e o
  // arrasto seguinte levava 409 mesmo com o conserto do cliente.
  const { data: fresh } = await supabase
    .from("crm_leads")
    .select(LEAD_COLS)
    .eq("organization_id", ctx.organization_id)
    .eq("id", leadId)
    .maybeSingle();

  await audit({
    action: "lead.updated",
    actorUserId: a.actorUserId,
    organizationId: existing.organization_id,
    resourceType: "crm_lead",
    resourceId: leadId,
    requestId: ctx.requestId,
    metadata: { ...a.metadataActor, fields },
  });

  return (fresh ?? updated) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// move (within same pipeline) — extraido para reuso pelo MCP (S-13.04)
// ---------------------------------------------------------------------------

export interface MoveLeadAdminInput {
  to_stage_id: string;
  /** Optional fractional position. If omitted, append at end (max + 1000). */
  position_in_stage?: number;
  reason?: string;
  /**
   * O motivo da perda, quando a etapa de destino é de perda (issue #917).
   *
   * ⚠️ NÃO é o mesmo `reason` de cima, e por isso são dois campos: `reason` é a
   * nota humana que entra na timeline ("cliente achou caro"), texto livre; este é
   * o `crm_leads.lost_reason`, que o banco confere contra o vocabulário do funil
   * (canônico + `settings.lost_reasons` do pipeline). Um valor de texto livre aqui
   * não é recusado por esta função — é recusado pelo trigger, e a rota devolve a
   * recusa de negócio (`recusaDeMotivoDaPerdaPeloBanco`). Quem decide se há de
   * exigir ou não é `lib/leads/motivo-da-perda.ts`, o mesmo dos outros caminhos.
   */
  lost_reason?: string | null;
  /**
   * O motivo do ganho, quando a etapa de destino fecha o negócio como ganho
   * (issue #1536) — espelho do `lost_reason`, mesma disciplina de escrita.
   */
  won_reason?: string | null;
}

export async function moveLeadHandler(
  supabase: SB,
  ctx: HandlerCtx,
  leadId: string,
  input: MoveLeadAdminInput,
): Promise<Record<string, unknown>> {
  const { data: lead, error: selErr } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();

  if (selErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, selErr.message);
  }
  if (!lead || lead.organization_id !== ctx.organization_id) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Lead não encontrado.", ctx.idioma ?? "pt-BR"),
    );
  }

  const { data: stage, error: stageErr } = await supabase
    .from("crm_stages")
    .select("id, pipeline_id, organization_id, name, is_lost, is_won")
    .eq("id", input.to_stage_id)
    .maybeSingle();
  if (stageErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, stageErr.message);
  }
  if (!stage || stage.organization_id !== ctx.organization_id) {
    throw new ApiError(
      404,
      "not_found",
      undefined,
      ctx.requestId,
      traduzir("Stage não encontrado.", ctx.idioma ?? "pt-BR"),
    );
  }
  if (stage.pipeline_id !== lead.pipeline_id) {
    throw new ApiError(
      422,
      "pipeline_immutable_use_clone",
      { use: "/api/v1/leads/{id}/clone" },
      ctx.requestId,
      traduzir(RECUSA_DE_TROCA_DE_FUNIL, ctx.idioma ?? "pt-BR"),
    );
  }

  // ── RETOMAR COMO NOVO NEGÓCIO (issue #1538) ────────────────────────────────
  //
  // Este handler é o escritor de etapa de TODO cliente que não é o board: IA,
  // lote (`create_or_move_lead`), automações e a tool MCP
  // `crm_move_lead_stage`. Nenhum deles pode reabrir um negócio encerrado num
  // funil `novo_negocio` — a mesma pergunta e a MESMA função da rota de arrasto,
  // porque duas réguas para a mesma regra é como o defeito nasce.
  // Vem ANTES da régua de campos, como no arrasto: um encerrado que não reabre
  // não tem campo de etapa a pedir.
  const settings = await settingsDoFunil(supabase, lead.pipeline_id);
  {
    const recusa = recusaReabertura({
      modo: modoDeReabertura(settings),
      statusAtual: (lead as { status?: string }).status,
      etapaDestino: stage,
      idioma: ctx.idioma,
    });
    if (recusa) {
      throw new ApiError(
        409,
        recusa.codigo,
        { use: "/api/v1/leads/{id}/retomar", lead_id: leadId },
        ctx.requestId,
        recusa.mensagem,
      );
    }
  }

  let position = input.position_in_stage;
  if (position === undefined) {
    const { data: maxRow } = await supabase
      .from("crm_leads")
      .select("position_in_stage")
      .eq("stage_id", input.to_stage_id)
      .order("position_in_stage", { ascending: false })
      .limit(1)
      .maybeSingle();
    position = maxRow?.position_in_stage ? Number(maxRow.position_in_stage) + 1000 : 1000;
  }

  // ── A MESMA ETAPA É REORDENAÇÃO, NÃO ENTRADA ────────────────────────────────
  //
  // O negócio que já está NA etapa de destino não está ENTRANDO nela: mover para
  // onde ele já está só troca a posição. A rota do quadro compara o destino com
  // `lead.stage_id` antes da régua e pula a régua por isso; aqui a comparação
  // faltava, e este handler é o escritor de etapa de tudo que NÃO é o quadro (o
  // MCP `crm_move_lead_stage`, a ação `create_or_move_lead`) — reordenar numa
  // coluna exigente devolvia a frase de campos faltando e a execução aparecia
  // como failed na aba Atividade.
  //
  // Fora da régua, e não dentro dela: `campos-exigidos.ts` segue sem saber o que
  // é "mesma etapa" — quem sabe é quem lê a etapa atual ao lado do destino.
  const mesmaEtapa = stage.id === lead.stage_id;

  // ── OS CAMPOS OBRIGATÓRIOS (issue #1536) ────────────────────────────────────
  //
  // Este handler é o escritor de etapa de TODOS os clientes que não são o board
  // (MCP `crm_move_lead_stage`, ações de automação), então a régua é a MESMA do
  // arrasto, decidida pela MESMA função: o que falta vira 422 com
  // `details.faltando`, e a tool do MCP devolve a frase ao modelo — que pergunta
  // ao cliente ou passa para o humano, em vez de mover calado.
  const vereditoDeCampos = mesmaEtapa
    ? { faltando: [] }
    : validaCamposExigidos({
        lead: lead as Record<string, unknown>,
        settingsDoFunil: settings,
        destino: {
          stageId: stage.id,
          desfecho: stage.is_won ? "won" : stage.is_lost ? "lost" : null,
        },
        motivoDeGanho: input.won_reason ?? null,
      });
  if (vereditoDeCampos.faltando.length > 0) {
    const recusa = recusaDeCamposObrigatorios(vereditoDeCampos.faltando, ctx.idioma);
    throw new ApiError(
      422,
      recusa.codigo,
      { faltando: vereditoDeCampos.faltando },
      ctx.requestId,
      recusa.mensagem,
    );
  }
  if (stage.is_won) {
    const recusaGanho = recusaDeMotivoDoGanho({
      motivo: input.won_reason,
      settingsDoFunil: settings,
      idioma: ctx.idioma,
    });
    if (recusaGanho) {
      throw new ApiError(422, recusaGanho.codigo, undefined, ctx.requestId, recusaGanho.mensagem);
    }
  }

  // ── O MOTIVO DA PERDA (issue #917) ──────────────────────────────────────────
  //
  // Este handler é o escritor de etapa de TODOS os clientes que não são o board
  // (MCP `crm_move_lead_stage`, ações de automação), e a regra é a mesma do
  // arrasto: etapa de perda exige motivo, e o motivo sai na mesma escrita.
  const veredito = decideMotivoDaPerda({
    etapaDeDestino: stage,
    motivo: input.lost_reason,
    motivoAtual: (lead as { lost_reason?: string | null }).lost_reason ?? null,
    idioma: ctx.idioma,
  });
  if (!veredito.ok) {
    throw new ApiError(422, veredito.codigo, undefined, ctx.requestId, veredito.mensagem);
  }

  const serviceOrigin = ctx.serviceOrigin ?? await observeServiceOrigin(createAdminClient(), ctx.organization_id, lead.contact_id);
  const nowIso = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from("crm_leads")
    .update({
      stage_id: input.to_stage_id,
      position_in_stage: position,
      updated_at: nowIso,
      ...veredito.patch,
      ...(stage.is_won && input.won_reason?.trim()
        ? { won_reason: input.won_reason.trim() }
        : {}),
    })
    .eq("id", leadId)
    .eq("updated_at", lead.updated_at)
    .select("*")
    .maybeSingle();

  if (updErr) {
    // Rede de segurança (#917) — mesma da rota de arrasto: recusa do banco por
    // motivo da perda vira recusa de negócio, nunca 500.
    const recusa = recusaDeMotivoDaPerdaPeloBanco(updErr, ctx.idioma);
    if (recusa) {
      throw new ApiError(422, recusa.codigo, undefined, ctx.requestId, recusa.mensagem);
    }
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, updErr.message);
  }
  if (!updated) {
    throw new ApiError(
      409,
      "lead_stage_changed_concurrent",
      undefined,
      ctx.requestId,
      traduzir("Lead foi modificado concorrentemente.", ctx.idioma ?? "pt-BR"),
    );
  }

  const a = actorAuditPayload(ctx.actor);
  await createAdminClient()
    .rpc("emit_event", {
      p_event_type: "lead.stage_changed",
      p_entity_kind: "crm_lead",
      p_entity_id: leadId,
      p_payload: {
        service_origin: serviceOrigin,
        pipeline_id: lead.pipeline_id,
        from_stage_id: lead.stage_id,
        to_stage_id: input.to_stage_id,
        position_in_stage: position,
        // `updated` é o retorno do próprio UPDATE, e `trg_crm_lead_close_on_stage`
        // é BEFORE (baseline.sql): o `status` que o gatilho escreveu já está
        // aqui. Ler a releitura do fim seria amarrar este evento à ordem dela.
        status: (updated as { status: string }).status,
      },
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
      p_organization_id: lead.organization_id,
    })
    .then(({ error }) => {
      if (error) console.error("[lead.move] emit_event failed", error.message);
    });

  // Wave 3 (CORE 2): a mudança de estágio entra no barramento da vida do lead.
  // É mudança de ESTADO do negócio — passa no teste "isto muda o que alguém
  // faria a seguir?". O nome do estágio de origem sai de crm_stages para o
  // reason ser legível ("Movido de Avaliação para Proposta enviada") em vez de
  // dois UUIDs.
  const { data: fromStage } = await supabase
    .from("crm_stages")
    .select("name")
    .eq("id", lead.stage_id)
    .maybeSingle();

  const atividade = await emitLeadActivity(supabase, {
    organizationId: lead.organization_id,
    leadId,
    contactId: (lead as { contact_id: string | null }).contact_id,
    type: "stage_changed",
    sourceModule: "crm",
    sourceId: leadId,
    actor: ctx.actor,
    reason: input.reason
      ? `${stageChangeReason(fromStage?.name ?? null, stage.name)} — ${input.reason}`
      : stageChangeReason(fromStage?.name ?? null, stage.name),
    payload: {
      from_stage_id: lead.stage_id,
      to_stage_id: input.to_stage_id,
      pipeline_id: lead.pipeline_id,
    },
  });
  // ── O LAÇO (spec 17 passo 5) ──────────────────────────────────────────────
  //
  // Um humano mover um card que a IA moveu por último é o retorno que fecha o
  // ciclo: sem isto o produto tem caminho e não tem aprendizado — a IA erra
  // igual amanhã, e alguém corrige de novo, para sempre e em silêncio.
  //
  // Só para ator HUMANO: a IA reorganizando o próprio trabalho não é correção.
  if (ctx.actor.type === "user") {
    try {
      const { data: historico } = await supabase
        .from("crm_lead_activities")
        .select("actor_kind, actor_agent_id, payload, performed_at")
        .eq("organization_id", lead.organization_id)
        .eq("lead_id", leadId)
        .eq("type", "stage_changed")
        .order("performed_at", { ascending: false })
        .limit(5);

      const anteriores = ((historico ?? []) as Array<{
        actor_kind: string | null;
        actor_agent_id: string | null;
        payload: { from_stage_id?: string; to_stage_id?: string } | null;
        performed_at: string;
      }>)
        // A atividade que ACABOU de ser emitida está aqui: descartá-la é o que
        // impede o movimento de se comparar consigo mesmo e virar "correção".
        .filter((h) => h.performed_at < new Date(Date.now() - 500).toISOString())
        .map((h) => ({
          actorKind: h.actor_kind,
          fromStageId: h.payload?.from_stage_id ?? null,
          toStageId: h.payload?.to_stage_id ?? null,
          performedAt: h.performed_at,
          agentId: h.actor_agent_id,
        }));

      const veredito = ehCorrecaoDeMovimentoDaIa({
        anteriores,
        deEtapa: lead.stage_id,
        paraEtapa: input.to_stage_id,
      });

      if (veredito.ehCorrecao) {
        await emitLeadActivity(supabase, {
          organizationId: lead.organization_id,
          leadId,
          contactId: (lead as { contact_id: string | null }).contact_id,
          type: "agent_move_corrected",
          sourceModule: "crm",
          sourceId: leadId,
          actor: ctx.actor,
          reason:
            veredito.tipo === "devolucao"
              ? "Uma pessoa devolveu o negócio para onde ele estava antes do assistente"
              : "Uma pessoa levou o negócio para outra etapa, diferente da que o assistente escolheu",
          payload: {
            tipo: veredito.tipo,
            // A etapa da IA é o dado do agregado: é ela que aparece em "o
            // assistente está mandando gente para X cedo demais".
            etapa_da_ia: veredito.etapaDaIa,
            etapa_do_humano: veredito.etapaDoHumano,
            agent_id: veredito.agentId,
            pipeline_id: lead.pipeline_id,
          },
        });
      }
    } catch {
      // O laço NUNCA derruba a movimentação: o card já moveu, e o dono não pode
      // perder a operação porque a medição do aprendizado falhou.
    }
  }

  if (!atividade.ok) {
    // Falha BAIXO: o card já moveu e bloquear deixaria o negócio refém da
    // timeline. Mas falhar baixo é escolher não bloquear, não escolher não
    // contar — o rastro perdido vira evento e alerta.
    await registraFalhaDeAtividade(supabase, {
      organizationId: lead.organization_id,
      leadId,
      tipo: "stage_changed",
      origem: "leads/_handler.moveLeadHandler",
      erro: atividade.error,
      requestId: ctx.requestId,
    });
  }

  // ── A ÚLTIMA LEITURA VEM DEPOIS DA ÚLTIMA ESCRITA (issue #916) ─────────────
  //
  // Reler o lead ANTES de gravar a atividade devolvia um `updated_at` que a
  // própria requisição já invalidava: o INSERT de `stage_changed` dispara
  // `trg_update_last_activity_at`, cuja lista positiva inclui `stage_changed`
  // (baseline.sql), e o `update crm_leads` dele passa por `fn_set_updated_at`
  // (`new.updated_at := now()`, incondicional). Quem guardar esta resposta para
  // a próxima trava otimista leva 409 no gesto seguinte.
  //
  // Este é o caminho da IA, do lote e das automações — o irmão de
  // `app/api/v1/leads/[id]/move/route.ts`, onde a mesma inversão já foi
  // corrigida. `agent_move_corrected` NÃO está na lista positiva, mas a
  // releitura vem depois dele também: a ordem certa não depende de qual tipo
  // está na lista hoje.
  const { data: fresh } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", leadId)
    .eq("organization_id", ctx.organization_id)
    .maybeSingle();
  const finalLead = (fresh ?? updated) as Record<string, unknown>;

  await audit({
    action: "lead.moved",
    actorUserId: a.actorUserId,
    organizationId: lead.organization_id,
    resourceType: "crm_lead",
    resourceId: leadId,
    requestId: ctx.requestId,
    metadata: {
      ...a.metadataActor,
      from_stage_id: lead.stage_id,
      to_stage_id: input.to_stage_id,
      position_in_stage: position,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });

  return finalLead;
}


export interface RetomarLeadInput {
  /**
   * A etapa da NOVA tentativa — a que quem arrastou tentou usar. Sem ela, a
   * primeira etapa aberta do funil (mesma escolha do clone sem `stage_id`).
   */
  stage_id?: string;
}

/**
 * RETOMAR UM NEGÓCIO PERDIDO COMO NEGÓCIO NOVO (issue #1538).
 *
 * É a porta que o 409 `reabertura_cria_novo` aponta: o negócio encerrado NÃO é
 * tocado (continua com o status e o motivo dele), e nasce outro lead no MESMO
 * funil, com o mesmo contato, `source = "retomada"` e
 * `retomado_de_lead_id` apontando para a origem — a coluna (migration 0425) por
 * onde "quantas tentativas até fechar" é derivado. A criação passa pelo
 * `createLeadHandler`, então o `lead.created`, a auditoria e a linha do tempo
 * são os MESMOS de um lead novo: uma retomada não é um lead de segunda classe.
 *
 * Serve a rota `POST /api/v1/leads/{id}/retomar` e a tool MCP
 * `crm_retomar_lead` — dois call sites, um só caminho, como `/move` ×
 * `moveLeadHandler`.
 *
 * Exige origem ENCRERRADA (`reabertura_lead_aberto`): retomar um negócio que
 * já está aberto duplicaria o card que já está no quadro. O modo do funil NÃO
 * entra aqui — em `mesmo_registro` quem decide se um encerrado reabre é o
 * arrasto; esta porta existe para quem quer a nova tentativa de propósito.
 */
export async function retomarLeadHandler(
  supabase: SB,
  ctx: HandlerCtx,
  leadId: string,
  input: RetomarLeadInput = {},
): Promise<Record<string, unknown>> {
  const idioma = ctx.idioma ?? "pt-BR";

  const { data: origem, error: selErr } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();
  if (selErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, selErr.message);
  }
  if (!origem || origem.organization_id !== ctx.organization_id) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, traduzir("Lead não encontrado.", idioma));
  }
  const origemTipada = origem as {
    id: string;
    pipeline_id: string;
    status: string;
    title: string;
    description?: string | null;
    contact_id?: string | null;
    value_cents?: number | null;
    currency?: string | null;
    owner_user_id?: string | null;
    owner_agent_id?: string | null;
    expected_close_date?: string | null;
    tags?: string[] | null;
    custom_fields?: Record<string, unknown> | null;
    lost_reason?: string | null;
  };
  if (origemTipada.status === "open") {
    throw new ApiError(
      422,
      "reabertura_lead_aberto",
      { use: "/api/v1/leads/{id}/move" },
      ctx.requestId,
      traduzir(RECUSA_RETOMADA_LEAD_ABERTO, idioma),
    );
  }

  // IDEMPOTÊNCIA: a origem já tem uma retomada ABERTA? Então a resposta é ela —
  // retomar duas vezes (clique repetido, tool MCP chamada de novo) não abre um
  // segundo negócio para a mesma tentativa. Retomada já encerrada não conta: aí
  // uma nova tentativa é legítima.
  // ponytail: não é atômico sob concorrência (duas chamadas simultâneas ainda
  // criam duas); o upgrade é um índice único parcial em
  // (retomado_de_lead_id) where status = 'open'.
  const { data: jaRetomado, error: jaErr } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("organization_id", ctx.organization_id)
    .eq("retomado_de_lead_id", origemTipada.id)
    .eq("status", "open")
    .limit(1)
    .maybeSingle();
  if (jaErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, jaErr.message);
  }
  if (jaRetomado) return jaRetomado as Record<string, unknown>;

  const { data: funil, error: funilErr } = await supabase
    .from("crm_pipelines")
    .select("settings")
    .eq("id", origemTipada.pipeline_id)
    .maybeSingle();
  if (funilErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, funilErr.message);
  }
  const settings = (funil as { settings?: unknown } | null)?.settings;

  // A etapa da nova tentativa: a que o chamador pediu (se veio) ou a primeira
  // aberta do funil. Recusa junta para os dois casos em que ela não serve —
  // etapa de OUTRO funil, de fechamento ou arquivada — porque a ação é a mesma
  // (escolher outra), e `stage_pipeline_mismatch` é o código que o clone já
  // devolve para o mesmo "não está disponível".
  let etapa: { id: string; is_won: boolean; is_lost: boolean; is_archived: boolean };
  if (input.stage_id) {
    const { data, error } = await supabase
      .from("crm_stages")
      .select("id, pipeline_id, is_won, is_lost, is_archived")
      .eq("organization_id", ctx.organization_id)
      .eq("id", input.stage_id)
      .maybeSingle();
    if (error) {
      throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
    }
    if (
      !data ||
      data.pipeline_id !== origemTipada.pipeline_id ||
      data.is_archived ||
      data.is_won ||
      data.is_lost
    ) {
      throw new ApiError(
        422,
        "stage_pipeline_mismatch",
        undefined,
        ctx.requestId,
        traduzir(RECUSA_RETOMADA_ETAPA_INDISPONIVEL, idioma),
      );
    }
    etapa = data;
  } else {
    const { data, error } = await supabase
      .from("crm_stages")
      .select("id, pipeline_id, is_won, is_lost, is_archived")
      .eq("organization_id", ctx.organization_id)
      .eq("pipeline_id", origemTipada.pipeline_id)
      .eq("is_archived", false)
      .order("position", { ascending: true });
    if (error) {
      throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
    }
    const aberta = (data ?? []).find((e) => !e.is_won && !e.is_lost);
    if (!aberta) {
      throw new ApiError(
        422,
        "pipeline_without_initial_stage",
        undefined,
        ctx.requestId,
        traduzir(RECUSA_RETOMADA_SEM_ETAPA, idioma),
      );
    }
    etapa = aberta;
  }

  const campos = camposCopiadosNaRetomada(settings);
  const copia = (campo: string): boolean => (campos as readonly string[]).includes(campo);

  const payload: CreateLeadInput & {
    custom_fields?: Record<string, unknown>;
    source_metadata?: Record<string, unknown>;
    retomado_de_lead_id?: string;
    dono_herdado?: boolean;
  } = {
    pipeline_id: origemTipada.pipeline_id,
    stage_id: etapa.id,
    // O título é o da origem: ele nasce do resolvedor das telas e é o que o
    // operador reconhece no quadro — "Lead da automação" aqui seria um card
    // novo sem nome.
    title: origemTipada.title,
    contact_id: origemTipada.contact_id ?? null,
    source: "retomada",
    tags: copia("tags") ? origemTipada.tags ?? [] : [],
    custom_fields: copia("custom_fields") ? origemTipada.custom_fields ?? {} : {},
    retomado_de_lead_id: origemTipada.id,
    // O ponteiro da coluna é a cadeia; este registro guarda TAMBÉM o desfecho
    // de origem para a tela, porque a coluna guarda só o id.
    source_metadata: {
      retomada_de: {
        lead_id: origemTipada.id,
        status: origemTipada.status,
        lost_reason: origemTipada.lost_reason ?? null,
      },
    },
    ...(copia("description") ? { description: origemTipada.description ?? null } : {}),
    ...(copia("value_cents") ? { value_cents: origemTipada.value_cents ?? null } : {}),
    ...(copia("currency") && origemTipada.currency ? { currency: origemTipada.currency } : {}),
    ...(copia("expected_close_date")
      ? { expected_close_date: origemTipada.expected_close_date ?? null }
      : {}),
    ...(copia("owner_user_id") && origemTipada.owner_user_id
      ? { owner_user_id: origemTipada.owner_user_id }
      : {}),
    ...(copia("owner_agent_id") && origemTipada.owner_agent_id
      ? { owner_agent_id: origemTipada.owner_agent_id }
      : {}),
    // Dono copiado é HERDADO, como no clone: se ele saiu da empresa, a retomada
    // nasce sem dono em vez de virar 422.
    ...((copia("owner_user_id") && origemTipada.owner_user_id) ||
    (copia("owner_agent_id") && origemTipada.owner_agent_id)
      ? { dono_herdado: true }
      : {}),
  };

  // A RÉGUA DE CAMPOS OBRIGATÓRIOS (issue #1536): a retomada ENTRA numa etapa,
  // e a etapa exigente vale para ela como vale para o arrasto. Só conta o que o
  // negócio novo vai ter — os campos copiados da origem.
  const vereditoDeCampos = validaCamposExigidos({
    lead: { custom_fields: payload.custom_fields ?? {} },
    settingsDoFunil: settings,
    destino: { stageId: etapa.id, desfecho: null },
    motivoDeGanho: null,
  });
  if (vereditoDeCampos.faltando.length > 0) {
    const recusa = recusaDeCamposObrigatorios(vereditoDeCampos.faltando, idioma);
    throw new ApiError(
      422,
      recusa.codigo,
      { faltando: vereditoDeCampos.faltando },
      ctx.requestId,
      recusa.mensagem,
    );
  }

  return createLeadHandler(supabase, ctx, payload);
}
