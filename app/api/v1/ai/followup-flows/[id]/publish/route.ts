import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followup-flows/:id/publish — valida o draft_graph
 * (validateFlowForPublish, Task 2.2) e, se válido, publica atomicamente via
 * fn_publish_followup_flow_version (migration 0056): insert da version +
 * ativação do pointer (active_version_id + status='active') numa função só,
 * sem janela onde a version fica órfã. EXECUTE da função é só service_role
 * (revogado de authenticated) — por isso o client aqui é o admin, com
 * organization_id sempre filtrado explicitamente (nunca do body).
 *
 * 422 validation_failed com details.errors (mesmo shape de PublishValidationError)
 * se draft_graph ausente ou reprovado na validação estrutural/semântica.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import { publishFollowupFlowVersion } from "@/lib/followup/publish";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("manager", { requestId, resource: "followup_flows" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  const admin = createAdminClient();
  const { data: pointer, error: fetchErr } = await admin
    .from("followup_flow_pointers")
    .select("id, draft_graph, trigger_config")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!pointer) return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });

  // ⚠️ ALLOWLIST, NÃO DENYLIST — e a diferença não é estilo.
  //
  // A versão anterior recusava UM literal (`conversation_end`) e deixava passar
  // qualquer outro. Só que `trigger_config` é `jsonb` SEM CHECK, e este publish
  // lê a linha CRUA do banco — não passa pelo Zod do PATCH. Então uma linha
  // escrita por SQL à mão, por um clone open-source, ou por uma versão futura do
  // produto, publicava `status='active'` e nunca enrollava ninguém: fluxo morto
  // com cara de vivo, que é o desfecho exato que este bloco existe para impedir.
  //
  // Kind entra neste conjunto só DEPOIS de ter motor de enrollment vivo:
  // `manual`/`webhook` (POST enroll + ação de regra), `silence` (silence-sweep),
  // `stage_change` (gatilho-etapa), `case_opened` (gatilho-caso) e
  // `appointment_no_show` (followup-gatilho-presenca.v1, confirmação humana).
  const KINDS_COM_MOTOR = new Set(["manual", "webhook", "silence", "stage_change", "case_opened", "appointment_no_show"]);
  const trigger = (pointer.trigger_config ?? { kind: "manual" }) as {
    kind?: string;
    params?: { stage_id?: string };
  };
  const triggerKind = trigger.kind ?? "manual";
  if (!KINDS_COM_MOTOR.has(triggerKind)) {
    return fail(
      "trigger_kind_not_implemented",
      `O gatilho «${triggerKind}» não está disponível — use Etapa do funil, Silêncio ou Manual.`,
      422,
      { requestId },
    );
  }

  // ⚠️ ETAPA QUE NÃO EXISTE MAIS É FLUXO MORTO COM CARA DE VIVO. O gatilho casa
  // o `to_stage_id` do evento com este `stage_id`: apontando para etapa apagada,
  // arquivada ou de outra org, o pointer fica `active` e nunca enrolla ninguém —
  // exatamente o desfecho que o bloqueio acima existe para evitar. A recusa é
  // aqui, no momento em que há um humano na tela para corrigir.
  if (triggerKind === "stage_change") {
    const stageId = trigger.params?.stage_id;
    if (!stageId || !UUID_RX.test(stageId)) {
      return fail(
        "trigger_stage_missing",
        t("Escolha a etapa do funil que dispara este fluxo antes de publicar."),
        422,
        { requestId },
      );
    }
    const { data: stage, error: stageErr } = await admin
      .from("crm_stages")
      .select("id, name, is_archived")
      .eq("id", stageId)
      .eq("organization_id", activeOrg.orgId)
      .maybeSingle();
    if (stageErr) return fail("internal_error", stageErr.message, 500, { requestId });
    if (!stage) {
      return fail(
        "trigger_stage_not_found",
        t("A etapa escolhida para o gatilho não existe mais neste funil — escolha outra."),
        422,
        { requestId },
      );
    }
    if (stage.is_archived) {
      return fail(
        "trigger_stage_archived",
        `A etapa «${stage.name}» está arquivada e nunca receberia um negócio — escolha uma etapa ativa.`,
        422,
        { requestId },
      );
    }
  }

  if (!pointer.draft_graph) {
    return fail("validation_failed", t("Fluxo não tem rascunho pronto para publicar."), 422, {
      requestId,
      details: {
        errors: [
          {
            node_id: null,
            code: "no_trigger",
            message: t("draft_graph ausente — monte o fluxo antes de publicar."),
          },
        ],
      },
    });
  }

  const graph = pointer.draft_graph as unknown as FlowGraph;
  const validation = validateFlowForPublish(graph);
  if (!validation.ok) {
    return fail("validation_failed", t("Fluxo reprovado na validação de publish."), 422, {
      requestId,
      details: { errors: validation.errors },
    });
  }

  const result = await publishFollowupFlowVersion(admin, {
    orgId: activeOrg.orgId,
    pointerId: id,
    graph,
    createdBy: user.id,
  });
  if (!result.ok) {
    if (result.code === "pointer_not_found") {
      return fail("not_found", t("Fluxo não encontrado."), 404, { requestId });
    }
    return fail("internal_error", result.message, 500, { requestId });
  }

  const { data: updatedPointer, error: reloadErr } = await admin
    .from("followup_flow_pointers")
    .select("id, status, active_version_id, updated_at")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .single();
  if (reloadErr || !updatedPointer) {
    return fail("internal_error", reloadErr?.message ?? "followup_flow_reload_failed", 500, {
      requestId,
    });
  }

  void audit({
    action: "followup_flow.published",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "followup_flow_pointer",
    resourceId: id,
    requestId,
    metadata: { version_id: result.version_id },
  });

  return ok(updatedPointer, { requestId });
}
