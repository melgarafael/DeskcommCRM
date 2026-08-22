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
import { resolveOwnerPatch, type OwnerPatch, type OwnerPatchInput } from "@/lib/leads/owner-patch";
import { emitLeadActivity, stageChangeReason } from "@/lib/leads/activity-emitter";
import { listaLegivel } from "@/lib/leads/activity-vocabulary";
import { camposAlterados } from "@/lib/leads/campos-alterados";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
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
): Promise<OwnerPatch | null> {
  const result = resolveOwnerPatch(input);
  if (!result.ok) {
    throw new ApiError(
      422,
      "validation_failed",
      undefined,
      ctx.requestId,
      "Um lead tem um dono: informe owner_user_id OU owner_agent_id.",
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
        "Agente não encontrado nesta organização.",
      );
    }
  }

  return result.patch;
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

  if (q.cursor) {
    const c = decLeadCursor(q.cursor);
    if (!c) {
      throw new ApiError(400, "invalid_cursor", undefined, ctx.requestId, "Cursor inválido.");
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
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Lead não encontrado.");
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
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Stage não encontrado.");
  }
  if (stage.pipeline_id !== input.pipeline_id) {
    throw new ApiError(
      422,
      "stage_pipeline_mismatch",
      undefined,
      ctx.requestId,
      "Stage não pertence ao pipeline informado.",
    );
  }

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
  const ownerPatch =
    (await ownerPatchOrThrow(supabase, ctx, input)) ??
    ({ owner_user_id: null, owner_agent_id: null, owner_kind: null } satisfies OwnerPatch);

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
      currency: input.currency ?? "MZN",
      ...ownerPatch,
      assigned_at:
        ownerPatch.owner_kind === null ? null : new Date().toISOString(),
      expected_close_date: input.expected_close_date ?? null,
      tags: input.tags ?? [],
      source: input.source,
      source_metadata: input.source_metadata ?? {},
      external_id: input.external_id ?? null,
      custom_fields: input.custom_fields ?? {},
      status: "open",
      position_in_stage: nextPos,
      created_by_user_id: ctx.actor.type === "user" ? ctx.actor.id : null,
    })
    .select(LEAD_COLS)
    .single();

  if (insErr || !lead) {
    throw new ApiError(
      500,
      "internal_error",
      undefined,
      ctx.requestId,
      insErr?.message ?? "Falha ao criar lead.",
    );
  }

  const a = actorAuditPayload(ctx.actor);
  await supabase
    .rpc("emit_event", {
      p_event_type: "lead.created",
      p_entity_kind: "crm_lead",
      p_entity_id: (lead as { id: string }).id,
      p_payload: {
        pipeline_id: (lead as { pipeline_id: string }).pipeline_id,
        stage_id: (lead as { stage_id: string }).stage_id,
        title: (lead as { title: string }).title,
      },
      p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
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
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Lead não encontrado.");
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.contact_id !== undefined) patch.contact_id = input.contact_id;
  if (input.value_cents !== undefined) patch.value_cents = input.value_cents;
  if (input.currency !== undefined) patch.currency = input.currency;
  // Dono do negócio (0070): regra em lib/leads/owner-patch.ts, compartilhada
  // com create, bulk e MCP. owner_kind é DERIVADO — nunca lido do body.
  const ownerPatch = await ownerPatchOrThrow(supabase, ctx, input);
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

  // O filtro entra AQUI TAMBÉM, e não só no SELECT acima: entre ler e escrever
  // há uma janela, e defesa que depende de uma leitura anterior é defesa que
  // some quando alguém reordena o código.
  const { data: updated, error: updErr } = await supabase
    .from("crm_leads")
    .update(patch)
    .eq("organization_id", ctx.organization_id)
    .eq("id", leadId)
    .select(LEAD_COLS)
    .maybeSingle();

  if (updErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, updErr.message);
  }
  if (!updated) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Lead não encontrado.");
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
      await supabase
        .rpc("emit_event", {
          p_event_type: "lead.tag_added",
          p_entity_kind: "crm_lead",
          p_entity_id: leadId,
          p_payload: { added_tags: addedTags, tags: input.tags },
          p_metadata: { request_id: ctx.requestId, ...a.metadataActor },
          p_organization_id: existing.organization_id,
        })
        .then(({ error }) => {
          if (error) console.error("[lead.update] emit_event failed", error.message);
        });
    }
  }

  await audit({
    action: "lead.updated",
    actorUserId: a.actorUserId,
    organizationId: existing.organization_id,
    resourceType: "crm_lead",
    resourceId: leadId,
    requestId: ctx.requestId,
    metadata: { ...a.metadataActor, fields },
  });

  return updated as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// move (within same pipeline) — extraido para reuso pelo MCP (S-13.04)
// ---------------------------------------------------------------------------

export interface MoveLeadAdminInput {
  to_stage_id: string;
  /** Optional fractional position. If omitted, append at end (max + 1000). */
  position_in_stage?: number;
  reason?: string;
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
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Lead não encontrado.");
  }

  const { data: stage, error: stageErr } = await supabase
    .from("crm_stages")
    .select("id, pipeline_id, organization_id, name")
    .eq("id", input.to_stage_id)
    .maybeSingle();
  if (stageErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, stageErr.message);
  }
  if (!stage || stage.organization_id !== ctx.organization_id) {
    throw new ApiError(404, "not_found", undefined, ctx.requestId, "Stage não encontrado.");
  }
  if (stage.pipeline_id !== lead.pipeline_id) {
    throw new ApiError(
      422,
      "pipeline_immutable_use_clone",
      undefined,
      ctx.requestId,
      "Move cross-pipeline não é permitido.",
    );
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

  const nowIso = new Date().toISOString();
  const { data: updated, error: updErr } = await supabase
    .from("crm_leads")
    .update({
      stage_id: input.to_stage_id,
      position_in_stage: position,
      updated_at: nowIso,
    })
    .eq("id", leadId)
    .eq("updated_at", lead.updated_at)
    .select("*")
    .maybeSingle();

  if (updErr) {
    throw new ApiError(500, "internal_error", undefined, ctx.requestId, updErr.message);
  }
  if (!updated) {
    throw new ApiError(
      409,
      "lead_stage_changed_concurrent",
      undefined,
      ctx.requestId,
      "Lead foi modificado concorrentemente.",
    );
  }

  const { data: fresh } = await supabase
    .from("crm_leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();
  const finalLead = (fresh ?? updated) as Record<string, unknown>;

  const a = actorAuditPayload(ctx.actor);
  await supabase
    .rpc("emit_event", {
      p_event_type: "lead.stage_changed",
      p_entity_kind: "crm_lead",
      p_entity_id: leadId,
      p_payload: {
        pipeline_id: lead.pipeline_id,
        from_stage_id: lead.stage_id,
        to_stage_id: input.to_stage_id,
        position_in_stage: position,
        status: (finalLead as { status: string }).status,
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
