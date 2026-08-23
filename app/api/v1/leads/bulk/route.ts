/**
 * POST /api/v1/leads/bulk
 *
 * Bulk operations on leads (move/assign/tag/delete). Discriminated by `action`.
 * AT-06: max 50 ids per call.
 *
 * Status transitions are NOT performed here — bulk move only changes
 * stage_id/position; the trigger will close-as-won/lost if the target is a
 * close stage. RLS scopes everything to the caller's tenant.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { resolveOwnerPatch } from "@/lib/leads/owner-patch";
import { emitLeadActivity, stageChangeReason } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import { bulkLeadActionSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const MAX_BULK = 50;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  // spec 13 §4: escrita é agent+ (viewer é read-only).
  const authz = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!authz.ok) return authz.response;
  const user = authz.user;

  let input;
  try {
    input = await validateRequest(bulkLeadActionSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  if (input.lead_ids.length > MAX_BULK) {
    return fail("bulk_too_large", `Máximo ${MAX_BULK} leads por bulk.`, 422, { requestId });
  }

  // G3-04: assign é reatribuição de dono em lote → piso ≥manager (spec 04 §6.5,
  // INB-03). Gate por-action: move/tag/delete continuam agent+ (piso acima);
  // só o assign exige manager. Reusa o helper (nada de ROLE_RANK na mão).
  if (input.action === "assign") {
    const mgr = await requireRole("manager", { requestId, resource: "crm_leads" });
    if (!mgr.ok) return mgr.response;

    // Novo dono tem que ser membro ativo agent+ da MESMA org (org de fonte
    // confiável = authz, nunca body). owner_user_id null = desatribuir (válido).
    // A RLS de user_organizations só mostra o próprio membership a um manager,
    // por isso o admin client filtrado pela org resolvida.
    const ownerId = input.params.owner_user_id;
    if (ownerId !== null) {
      // INB-09 nota 1: fail-closed. A validação de membership só roda com service
      // role (a RLS de user_organizations não mostra membership alheio a um
      // manager). Sem service role NÃO se pode validar o dono → recusar em vez
      // de atribuir um owner não-verificado. Desatribuir (owner null) segue livre.
      if (!isServiceRoleConfigured()) {
        return fail(
          "owner_validation_unavailable",
          "Não foi possível validar o responsável agora. Tente novamente em instantes.",
          422,
          { requestId },
        );
      }
      const admin = createAdminClient();
      const { data: member, error: memberErr } = await admin
        .from("user_organizations")
        .select("role")
        .eq("organization_id", authz.org.orgId)
        .eq("user_id", ownerId)
        .is("revoked_at", null)
        .maybeSingle();
      if (memberErr) return fail("internal_error", memberErr.message, 500, { requestId });
      if (!member || member.role === "viewer") {
        return fail(
          "invalid_owner",
          "Responsável não é um atendente ativo desta organização.",
          422,
          { requestId },
        );
      }
    }
  }

  // INB-09 nota 2: org de fonte confiável = org ativa do cookie (authz), NUNCA
  // inferida do 1º lead. A RLS já escopa por org do membro, mas um ator em 2+
  // orgs veria leads de ambas — o filtro explícito garante que o bulk só toca a
  // org ativa (mesmo padrão do gate de owner acima).
  const organizationId = authz.org.orgId;
  const { data: scoped } = await supabase
    .from("crm_leads")
    .select("id, organization_id, tags, stage_id, pipeline_id")
    .eq("organization_id", organizationId)
    .in("id", input.lead_ids);

  const visible = scoped ?? [];
  const first = visible[0];
  if (!first) {
    return fail(
      "not_found",
      "Nenhum lead acessível na operação.",
      404,
      { requestId },
    );
  }
  const visibleIds = visible.map((r) => r.id);

  let updatedCount = 0;
  const nowIso = new Date().toISOString();

  switch (input.action) {
    case "move": {
      const { data, error } = await supabase
        .from("crm_leads")
        .update({
          stage_id: input.params.stage_id,
          position_in_stage: input.params.position_in_stage,
          updated_at: nowIso,
        })
        .in("id", visibleIds)
        .select("id");
      if (error) return fail("internal_error", error.message, 500, { requestId });
      updatedCount = data?.length ?? 0;

      // Per-lead lead.stage_changed so the automation engine (which only
      // consumes per-entity events) fires for bulk moves too — mirrors
      // moveLeadHandler's payload. Skip leads already at the target stage.
      const movedIds = new Set((data ?? []).map((r) => r.id as string));

      // Wave 3 (CORE 2): mover 30 cards de uma vez é 30 mudanças de estado —
      // cada uma entra no barramento, senão o lote inteiro fica invisível na
      // timeline e a operação em massa vira o buraco por onde a atividade some.
      const nomesEstagio = new Map<string, string>();
      const { data: stageRows } = await supabase
        .from("crm_stages")
        .select("id, name")
        .eq("organization_id", organizationId)
        .in("id", [input.params.stage_id, ...visible.map((r) => r.stage_id as string)]);
      for (const s of (stageRows ?? []) as Array<{ id: string; name: string }>) {
        nomesEstagio.set(s.id, s.name);
      }

      await Promise.all(
        visible
          .filter((row) => movedIds.has(row.id) && row.stage_id !== input.params.stage_id)
          .map(async (row) => {
            const r = await emitLeadActivity(supabase, {
              organizationId,
              leadId: row.id as string,
              type: "stage_changed",
              sourceModule: "crm",
              sourceId: row.id as string,
              actor: { type: "user", id: user.id },
              reason: stageChangeReason(
                nomesEstagio.get(row.stage_id as string) ?? null,
                nomesEstagio.get(input.params.stage_id) ?? null,
              ),
              payload: {
                from_stage_id: row.stage_id,
                to_stage_id: input.params.stage_id,
                pipeline_id: row.pipeline_id,
                bulk: true,
              },
            });
            if (!r.ok) {
              // O bulk é o pior caso dos três: N leads movidos, e uma falha de
              // atividade some junto com as outras N-1 que deram certo. Sem o
              // aviso, o buraco na timeline não tem nem tamanho conhecido.
              await registraFalhaDeAtividade(supabase, {
                organizationId: row.organization_id,
                leadId: row.id,
                tipo: "stage_changed",
                origem: "leads/bulk",
                erro: r.error,
                requestId,
              });
            }
          }),
      );
      await Promise.all(
        visible
          .filter((row) => movedIds.has(row.id) && row.stage_id !== input.params.stage_id)
          .map((row) =>
            supabase
              .rpc("emit_event", {
                p_event_type: "lead.stage_changed",
                p_entity_kind: "crm_lead",
                p_entity_id: row.id,
                p_payload: {
                  pipeline_id: row.pipeline_id,
                  from_stage_id: row.stage_id,
                  to_stage_id: input.params.stage_id,
                },
                p_metadata: { request_id: requestId, actor_user_id: user.id },
                p_organization_id: organizationId,
              })
              .then(({ error: emitError }) => {
                if (emitError) console.error("[lead.bulk_moved] emit_event failed", emitError.message);
              }),
          ),
      );
      break;
    }
    case "assign": {
      // 0070: o trio de posse vem do helper compartilhado. Escrever só
      // owner_user_id aqui quebrava de dois jeitos: lote com algum lead de dono
      // AGENTE estourava 23514 e derrubava a operação inteira; e lead sem dono
      // ganhava dono sem owner_kind (drift silencioso).
      const owner = resolveOwnerPatch({ owner_user_id: input.params.owner_user_id });
      if (!owner.ok || !owner.patch) {
        return fail(
          "validation_failed",
          "Um lead tem um dono: informe owner_user_id OU owner_agent_id.",
          422,
          { requestId },
        );
      }
      const patch: Record<string, unknown> = {
        ...owner.patch,
        updated_at: nowIso,
      };
      if (owner.patch.owner_kind !== null) {
        patch.assigned_at = nowIso;
      }
      const { data, error } = await supabase
        .from("crm_leads")
        .update(patch)
        .in("id", visibleIds)
        .select("id");
      if (error) return fail("internal_error", error.message, 500, { requestId });
      updatedCount = data?.length ?? 0;
      break;
    }
    case "tag": {
      const add = input.params.add ?? [];
      const remove = new Set(input.params.remove ?? []);
      // Compute next tags per row from already-fetched `scoped`.
      const rows = visible.map((row) => {
        const current = (row.tags ?? []) as string[];
        const next = Array.from(new Set([...current.filter((t) => !remove.has(t)), ...add]));
        const addedTags = add.filter((t) => !current.includes(t));
        return { row, next, addedTags };
      });

      // Wave 3 (CORE 2): parallelize like the `move` case above — a
      // sequential await-per-row here turned into an N+1 that made bulk tag
      // take seconds where bulk move/assign/delete are near-instant.
      const results = await Promise.all(
        rows.map(({ row, next }) =>
          supabase
            .from("crm_leads")
            .update({ tags: next, updated_at: nowIso })
            .eq("id", row.id),
        ),
      );
      const firstError = results.find((r) => r.error)?.error;
      if (firstError) return fail("internal_error", firstError.message, 500, { requestId });
      updatedCount = rows.length;

      // Per-lead lead.tag_added (only-when-added), same contract as
      // updateLeadHandler, so the automation engine fires for bulk tags too.
      await Promise.all(
        rows
          .filter(({ addedTags }) => addedTags.length)
          .map(({ row, next, addedTags }) =>
            supabase
              .rpc("emit_event", {
                p_event_type: "lead.tag_added",
                p_entity_kind: "crm_lead",
                p_entity_id: row.id,
                p_payload: { added_tags: addedTags, tags: next },
                p_metadata: { request_id: requestId, actor_user_id: user.id },
                p_organization_id: organizationId,
              })
              .then(({ error: emitError }) => {
                if (emitError) console.error("[lead.bulk_tagged] emit_event failed", emitError.message);
              }),
          ),
      );
      break;
    }
    case "delete": {
      // crm_leads has no `is_archived` column → real DELETE.
      const { data, error } = await supabase
        .from("crm_leads")
        .delete()
        .in("id", visibleIds)
        .select("id");
      if (error) return fail("internal_error", error.message, 500, { requestId });
      updatedCount = data?.length ?? 0;
      break;
    }
  }

  // Aggregate event + aggregate audit (one record per bulk call).
  const eventType =
    input.action === "move"
      ? "lead.bulk_moved"
      : input.action === "assign"
        ? "lead.bulk_assigned"
        : input.action === "tag"
          ? "lead.bulk_tagged"
          : "lead.bulk_deleted";

  await supabase
    .rpc("emit_event", {
      p_event_type: eventType,
      p_entity_kind: "crm_lead",
      p_entity_id: null,
      p_payload: {
        action: input.action,
        lead_ids: visibleIds,
        params: "params" in input ? input.params : {},
      },
      p_metadata: { request_id: requestId, actor_user_id: user.id },
      p_organization_id: organizationId,
    })
    .then(({ error }) => {
      if (error) console.error("[lead.bulk] emit_event failed", error.message);
    });

  // Assign audita com action agregada dedicada (spec 04 §6.5); as demais ações
  // mantêm o code genérico. Uma única entrada por chamada, com a contagem.
  await audit({
    action: input.action === "assign" ? "leads.bulk_assigned" : "lead.bulk_action",
    actorUserId: user.id,
    organizationId,
    resourceType: "crm_lead",
    resourceId: null,
    requestId,
    metadata: {
      action: input.action,
      lead_ids: visibleIds,
      count: updatedCount,
      updated_count: updatedCount,
      ...(input.action === "assign" ? { owner_user_id: input.params.owner_user_id } : {}),
      params: "params" in input ? input.params : {},
    },
  });

  return ok({ updated_count: updatedCount, lead_ids: visibleIds }, { requestId });
}
