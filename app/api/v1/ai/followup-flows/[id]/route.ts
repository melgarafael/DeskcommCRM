import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET    /api/v1/ai/followup-flows/:id — pointer completo (draft_graph,
 *   trigger_config, handoff_policy) — any org member.
 * PATCH  /api/v1/ai/followup-flows/:id — atualiza campos parciais (manager+).
 *   draft_graph é validado só estruturalmente (flowGraphSchema) — a validação
 *   semântica de publish (reachability, coverage) roda em /publish.
 * DELETE /api/v1/ai/followup-flows/:id — apaga o pointer (manager+). Enrollment
 *   e versões saem no cascade / na ordem abaixo; não dá para desfazer.
 */
import { rascunhoDoFluxo } from "@/lib/followup/rascunho";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { patchFollowupFlowSchema } from "@/lib/followup/api-schemas";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const DETAIL_COLUMNS =
  "id, name, status, active_version_id, draft_graph, handoff_policy, send_when_assigned, trigger_config, surface, created_at, updated_at";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "followup_flows",
    role: "viewer",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "followup_flows", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  const supabase = authz.supabase;
  const { data, error } = await supabase
    .from("followup_flow_pointers")
    .select(DETAIL_COLUMNS)
    .eq("id", id)
    .eq("organization_id", authz.organizationId)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });

  // Linhagem de versions (Task 6.2 — builder): o PublishBar precisa saber se
  // existe versão anterior pra habilitar Rollback. `.limit()` deliberadamente
  // evitado (não coberto pelo fake DB de tests/api/followup-flows.test.ts);
  // volume por pointer é baixo (1 insert por publish), então ordenar tudo em
  // memória é seguro.
  const { data: versionRows, error: versionsErr } = await supabase
    .from("followup_flow_versions")
    .select("id, created_at")
    .eq("organization_id", authz.organizationId)
    .eq("pointer_id", id)
    .order("created_at", { ascending: false });
  if (versionsErr) return fail("internal_error", versionsErr.message, 500, { requestId });

  // Rascunho ausente COM versão publicada: a tela abre o que está NO AR. Ver
  // `lib/followup/rascunho.ts` — um fluxo publicado por fora do construtor
  // abria vazio, e salvar por cima trocava o fluxo do ar por quase-nada.
  const draft_graph = await rascunhoDoFluxo(
    supabase,
    data as unknown as { draft_graph: unknown; active_version_id: string | null },
    authz.organizationId,
  );

  return ok(
    {
      ...data,
      draft_graph,
      versions_count: versionRows?.length ?? 0,
      previous_version_id: versionRows?.[1]?.id ?? null,
    },
    { requestId },
  );
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "followup_flows",
    role: "manager",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "followup_flows", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = patchFollowupFlowSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = authz.supabase;
  const { data: existing, error: fetchErr } = await supabase
    .from("followup_flow_pointers")
    .select("id")
    .eq("id", id)
    .eq("organization_id", authz.organizationId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });

  const patch = parsed.data;
  if (Object.keys(patch).length === 0) {
    const { data: unchanged, error: reloadErr } = await supabase
      .from("followup_flow_pointers")
      .select(DETAIL_COLUMNS)
      .eq("id", id)
      .eq("organization_id", authz.organizationId)
      .single();
    if (reloadErr || !unchanged) {
      return fail("internal_error", reloadErr?.message ?? "reload_failed", 500, { requestId });
    }
    return ok(unchanged, { requestId });
  }

  const update: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };

  const { data: updated, error: updErr } = await supabase
    .from("followup_flow_pointers")
    .update(update)
    .eq("id", id)
    .eq("organization_id", authz.organizationId)
    .select(DETAIL_COLUMNS)
    .single();

  if (updErr || !updated) {
    if (updErr?.code === "23505") {
      return fail("conflict", t("Já existe um fluxo com este nome."), 409, { requestId });
    }
    // O banco recusa gatilho de relógio em roteiro de atendimento (0394,
    // `followup_flow_pointers_roteiro_so_manual`): ele começa na conversa.
    if (updErr?.code === "23514") {
      return fail(
        "validation_failed",
        t("Roteiro de atendimento começa por palavra-gatilho ou pelo roteador, não por gatilho de follow-up."),
        422,
        { requestId },
      );
    }
    return fail("internal_error", updErr?.message ?? "followup_flow_update_failed", 500, {
      requestId,
    });
  }

  void audit({
    action: "followup_flow.updated",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "followup_flow_pointer",
    resourceId: id,
    requestId,
    metadata: { fields_changed: Object.keys(patch) },
  });

  return ok(updated, { requestId });
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "followup_flows",
    role: "manager",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const teto = await tetoDeEscritaDoToken(authz, "followup_flows", requestId);
  if (teto) return teto;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);

  const supabase = authz.supabase;
  const { data: existing, error: fetchErr } = await supabase
    .from("followup_flow_pointers")
    .select("id")
    .eq("id", id)
    .eq("organization_id", authz.organizationId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });

  // Enrollment referencia version_id; pointer referencia active_version_id.
  // Soltar o relógio nessa ordem evita 23503 no Postgres.
  const { error: enrErr } = await supabase
    .from("followup_enrollments")
    .delete()
    .eq("pointer_id", id)
    .eq("organization_id", authz.organizationId);
  if (enrErr) return fail("internal_error", enrErr.message, 500, { requestId });

  const { error: unpinErr } = await supabase
    .from("followup_flow_pointers")
    .update({ active_version_id: null, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", authz.organizationId);
  if (unpinErr) return fail("internal_error", unpinErr.message, 500, { requestId });

  const { error: verErr } = await supabase
    .from("followup_flow_versions")
    .delete()
    .eq("pointer_id", id)
    .eq("organization_id", authz.organizationId);
  if (verErr) return fail("internal_error", verErr.message, 500, { requestId });

  const { error: delErr } = await supabase
    .from("followup_flow_pointers")
    .delete()
    .eq("id", id)
    .eq("organization_id", authz.organizationId);
  if (delErr) return fail("internal_error", delErr.message, 500, { requestId });

  void audit({
    action: "followup_flow.deleted",
    actorUserId: authz.actor.type === "user" ? authz.actor.id : null,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: authz.organizationId,
    resourceType: "followup_flow_pointer",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
