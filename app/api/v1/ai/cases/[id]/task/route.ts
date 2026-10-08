import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { conversasVisiveisDosCasos } from "@/lib/escalacao/chamados";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { applyCaseTaskAction, readCaseTask, taskFields } from "@/lib/agent-engine/agent/case-task";
import { caseTaskActionSchema, CaseTaskConflict } from "@/lib/agent-engine/agent/case-task-schema";
import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };

async function authorize(params: Params["params"], requestId: string) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success)
    return { response: fail("validation_failed", "Caso inválido.", 422, { requestId }) };
  const auth = await requireRole("agent", { requestId, resource: "agent_cases" });
  if (!auth.ok) return { response: auth.response };
  const session = await createClient();
  const visible = await conversasVisiveisDosCasos(session, auth.org.orgId, { caseId: id.data });
  const pool = getRequestPool();
  const row = await readCaseTask(pool, auth.org.orgId, id.data);
  if (!row || (visible !== null && !visible.includes(row.conversation_id)))
    return { response: fail("not_found", "Caso não encontrado.", 404, { requestId }) };
  return { auth, pool, row, session, id: id.data };
}

export async function GET(_req: NextRequest, { params }: Params) {
  const requestId = randomUUID();
  try {
    const context = await authorize(params, requestId);
    if (context.response) return context.response;
    const { data: candidates, error } = await context
      .session!.from("crm_leads")
      .select("id,title")
      .eq("organization_id", context.auth!.org.orgId)
      .eq("contact_id", context.row!.contact_id)
      .eq("status", "open");
    if (error) throw error;
    const { data: flows, error: flowError } = await context
      .session!.from("followup_flow_pointers")
      .select("id,name")
      .eq("organization_id", context.auth!.org.orgId)
      .eq("status", "active")
      .eq("surface", "followup");
    if (flowError) throw flowError;
    return ok(
      {
        ...taskFields(context.row!),
        purchase_candidates: candidates ?? [],
        post_delivery_options: flows ?? [],
        assigned_to_me: context.row!.assignee_user_id === context.auth!.user.id,
        can_reassign: context.auth!.org.role === "manager" || context.auth!.org.role === "admin",
      },
      { requestId },
    );
  } catch (error) {
    logger.error("[case/task] falha na leitura", {
      requestId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return fail("internal_error", "Não foi possível carregar a tarefa.", 500, { requestId });
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const requestId = randomUUID();
  const denied = await requireSupportWrite();
  if (denied) return denied;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_request", "Body inválido.", 400, { requestId });
  }
  const parsed = caseTaskActionSchema.safeParse(body);
  if (!parsed.success)
    return fail("validation_failed", "Revise os campos da tarefa.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  try {
    const context = await authorize(params, requestId);
    if (context.response) return context.response;
    const { auth, pool, id } = context;
    const caseId = id!;
    if (parsed.data.post_delivery_pointer_id) {
      if (parsed.data.action !== "details_release")
        return fail(
          "validation_failed",
          "A retomada só pode ser escolhida na liberação de dados.",
          422,
          { requestId },
        );
      const { data, error } = await context
        .session!.from("followup_flow_pointers")
        .select("id")
        .eq("organization_id", auth!.org.orgId)
        .eq("id", parsed.data.post_delivery_pointer_id)
        .eq("status", "active")
        .eq("surface", "followup")
        .maybeSingle();
      if (error) throw error;
      if (!data)
        return fail("validation_failed", "Escolha um fluxo publicado de acompanhamento.", 422, {
          requestId,
        });
    }
    if (parsed.data.action === "link_purchase") {
      const { data, error } = await context
        .session!.from("crm_leads")
        .select("id")
        .eq("organization_id", auth!.org.orgId)
        .eq("contact_id", context.row!.contact_id)
        .eq("id", parsed.data.lead_id!)
        .maybeSingle();
      if (error) throw error;
      if (!data) return fail("not_found", "Compra não encontrada.", 404, { requestId });
    }
    let canReassign = false;
    if (parsed.data.action === "takeover") {
      const manager = await requireRole("manager", { requestId, resource: "agent_cases" });
      if (!manager.ok) return manager.response;
      canReassign = manager.org.orgId === auth!.org.orgId && manager.user.id === auth!.user.id;
    }
    const fields = await applyCaseTaskAction(
      pool!,
      auth!.org.orgId,
      id!,
      auth!.user.id,
      parsed.data,
      { canReassign },
    );
    await audit({
      action: "ai.case_replied",
      actorUserId: auth!.user.id,
      organizationId: auth!.org.orgId,
      resourceType: "agent_case",
      resourceId: caseId,
      requestId,
      metadata: { task_action: parsed.data.action, revision: fields.revision },
    });
    return ok(
      { ...fields, assigned_to_me: fields.assignee_user_id === auth!.user.id },
      { requestId },
    );
  } catch (error) {
    if (error instanceof CaseTaskConflict)
      return fail(
        error.code,
        error.message,
        error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 409,
        { requestId },
      );
    logger.error("[case/task] falha ao registrar decisão", {
      requestId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return fail(
      "internal_error",
      "Não foi possível registrar a decisão. Atualize a tarefa antes de tentar novamente.",
      500,
      { requestId },
    );
  }
}
