import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/**
 * O FUNIL DE ENTRADA DO NÚMERO (migration 9430).
 *
 * `pipeline_id: null` volta ao funil padrão da organização. `stage_id` é
 * opcional: sem ele, a conversa nasce na etapa de entrada do próprio funil.
 *
 * ⚠️ O ADMIN CLIENT BYPASSA RLS: funil e etapa são conferidos contra a
 * organização do NÚMERO (resolvida da sessão, nunca do body) antes de gravar.
 * A FK composta com a organização recusaria o mesmo uuid de outra empresa, mas
 * com um 500 cru; a conferência aqui devolve o erro que a tela sabe mostrar.
 */
const entradaSchema = z
  .object({
    pipeline_id: z.uuid().nullable(),
    stage_id: z.uuid().nullable().optional(),
  })
  .strict();

/**
 * O que a tela precisa para abrir o seletor: a escolha gravada e os funis
 * abertos da organização, cada um com as etapas onde um card pode nascer
 * (abertas, nem ganho nem perdido), na ordem do funil.
 */
export async function GET(_req: NextRequest, { params }: Context): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return fail("validation_failed", "Canal inválido.", 422, { requestId });

  const orgId = auth.org.orgId;
  const db = createAdminClient();
  const [numero, funis, etapas] = await Promise.all([
    db
      .from("channel_sessions")
      .select("entry_pipeline_id, entry_stage_id")
      .eq("organization_id", orgId)
      .eq("id", id)
      .is("archived_at", null)
      .maybeSingle(),
    db
      .from("crm_pipelines")
      .select("id, name, is_default")
      .eq("organization_id", orgId)
      .eq("is_archived", false)
      .order("created_at", { ascending: true }),
    db
      .from("crm_stages")
      .select("id, name, pipeline_id, position")
      .eq("organization_id", orgId)
      .eq("is_archived", false)
      .eq("is_won", false)
      .eq("is_lost", false)
      .order("position", { ascending: true }),
  ]);
  if (numero.error || funis.error || etapas.error)
    return fail("internal_error", "Não foi possível ler o funil de entrada.", 500, { requestId });
  if (!numero.data) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  const lista = (funis.data ?? []).map((f) => ({
    id: f.id as string,
    name: f.name as string,
    is_default: Boolean(f.is_default),
    etapas: (etapas.data ?? [])
      .filter((e) => e.pipeline_id === f.id)
      .map((e) => ({ id: e.id as string, name: e.name as string })),
  }));
  return ok(
    {
      entry_pipeline_id: numero.data.entry_pipeline_id ?? null,
      entry_stage_id: numero.data.entry_stage_id ?? null,
      funis: lista,
    },
    { requestId },
  );
}

export async function PATCH(req: NextRequest, { params }: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const auth = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return fail("validation_failed", "Canal inválido.", 422, { requestId });

  const parsed = entradaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_failed", "Escolha um funil (ou nenhum, para usar o padrão).", 422, {
      requestId,
    });

  const orgId = auth.org.orgId;
  const pipelineId = parsed.data.pipeline_id;
  const stageId = pipelineId ? (parsed.data.stage_id ?? null) : null;

  const db = createAdminClient();
  const { data: before, error: readError } = await db
    .from("channel_sessions")
    .select("entry_pipeline_id, entry_stage_id")
    .eq("organization_id", orgId)
    .eq("id", id)
    .is("archived_at", null)
    .maybeSingle();
  if (readError)
    return fail("internal_error", "Não foi possível ler a conexão.", 500, { requestId });
  if (!before) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  if (pipelineId) {
    const { data: funil, error: funilError } = await db
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", orgId)
      .eq("id", pipelineId)
      .eq("is_archived", false)
      .maybeSingle();
    if (funilError)
      return fail("internal_error", "Não foi possível conferir o funil.", 500, { requestId });
    if (!funil) return fail("validation_failed", "Funil não encontrado ou arquivado.", 422, { requestId });

    if (stageId) {
      const { data: etapa, error: etapaError } = await db
        .from("crm_stages")
        .select("id")
        .eq("organization_id", orgId)
        .eq("pipeline_id", pipelineId)
        .eq("id", stageId)
        .eq("is_archived", false)
        .eq("is_won", false)
        .eq("is_lost", false)
        .maybeSingle();
      if (etapaError)
        return fail("internal_error", "Não foi possível conferir a etapa.", 500, { requestId });
      if (!etapa)
        return fail(
          "validation_failed",
          "Escolha uma etapa aberta deste funil (nem ganho nem perdido).",
          422,
          { requestId },
        );
    }
  }

  if (before.entry_pipeline_id === pipelineId && before.entry_stage_id === stageId)
    return ok({ id, entry_pipeline_id: pipelineId, entry_stage_id: stageId }, { requestId });

  const { data, error } = await db
    .from("channel_sessions")
    .update({ entry_pipeline_id: pipelineId, entry_stage_id: stageId })
    .eq("organization_id", orgId)
    .eq("id", id)
    .is("archived_at", null)
    .select("id, entry_pipeline_id, entry_stage_id")
    .maybeSingle();
  if (error)
    return fail("internal_error", "Não foi possível salvar o funil de entrada.", 500, { requestId });
  if (!data) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  void audit({
    action: "channel.entry_pipeline_changed",
    actorUserId: auth.user.id,
    organizationId: orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    metadata: {
      previous_entry_pipeline_id: before.entry_pipeline_id,
      previous_entry_stage_id: before.entry_stage_id,
      entry_pipeline_id: pipelineId,
      entry_stage_id: stageId,
    },
  });
  return ok(data, { requestId });
}
