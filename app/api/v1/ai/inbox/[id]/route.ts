import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * Épico Operação Visível (F1) — transição de status de um aviso do agente.
 * PATCH { status: 'ack' | 'resolved' | 'open' } — org-scoped, auditado.
 * Reabrir (→'open') é permitido: resolver por engano não pode esconder alerta.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bodySchema = z.object({ status: z.enum(["open", "ack", "resolved"]) }).strict();

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("agent", { requestId, resource: "agent_inbox_items" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_inbox_items")
    .update({ status: parsed.data.status })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select("id, kind, severity, title, body, ref_kind, ref_id, status, created_at")
    .maybeSingle();
  if (error) {
    // `23505` — um índice único parcial das migrations 0491/0527/0538 recusou a
    // virada para `open`: já existe um aviso ABERTO com a mesma chave nesta
    // organização (mesmo kind e mesmo título, ou mesma conversa). É 409 e não
    // 500: a ação pedida não cabe no estado atual, e "falha ao atualizar"
    // esconderia que foi o próprio banco que impediu o duplicado que a issue
    // #880 veio fechar. Reabrir sem um aberto igual continua passando — o índice
    // parcial deixa a linha resolvida sair de lá e voltar quando reabre.
    if (error.code === "23505") {
      return fail(
        "state_conflict",
        t("Já existe um aviso idêntico aberto nesta organização — reabrir duplicaria o alerta."),
        409,
        { requestId },
      );
    }
    return fail("internal_error", t("Falha ao atualizar o aviso."), 500, { requestId });
  }
  if (!data) {
    return fail("not_found", t("Aviso não encontrado nesta organização."), 404, { requestId });
  }

  await audit({
    action: "ai.inbox_item_status_changed",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "agent_inbox_items",
    resourceId: id,
    metadata: { status: parsed.data.status },
  });

  return ok({ item: data }, { requestId });
}
