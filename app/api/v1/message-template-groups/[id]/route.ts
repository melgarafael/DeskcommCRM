import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/message-template-groups/[id] — renomeia o grupo (#3245).
 * DELETE /api/v1/message-template-groups/[id] — apaga o grupo.
 *
 * ─── Apagar o grupo NÃO apaga resposta nenhuma ─────────────────────────────
 *
 * A FK composta `(organization_id, grupo_id)` nasce `on delete set null
 * (grupo_id)` (migration 0808): as respostas do grupo voltam a "sem grupo" e
 * continuam na lista plana, que é o comportamento de quem nunca criou grupo.
 * O DELETE daqui não toca em `message_templates` — quem faz o desvínculo é o
 * banco, dentro da mesma transação. A tela avisa isso antes de confirmar.
 *
 * ─── O `.select()` do DELETE é a prova de que algo foi apagado ────────────
 *
 * Sem ele, um DELETE barrado pela RLS (ou um id de outra organização) afeta 0
 * linhas e a rota responderia 204 com audit falso — mutação que não ocorreu.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, noContent, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { updateGrupoSchema } from "@/lib/schemas/templates";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
const COLS = "id, organization_id, name, ordem, created_at, updated_at";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await params;

  const parsed = updateGrupoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("message_template_groups")
    .update({ name: parsed.data.name, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select(COLS)
    .maybeSingle();
  if (error) {
    if (error.code === "23505") {
      return fail("conflict", t("Já existe um grupo com esse nome."), 409, { requestId });
    }
    return fail("internal_error", "Erro ao renomear o grupo.", 500, { requestId });
  }
  if (!data) return fail("not_found", t("Grupo não encontrado."), 404, { requestId });

  void audit({
    action: "template_group.updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "message_template_group",
    resourceId: data.id,
    requestId,
    metadata: { name: parsed.data.name },
  });
  return ok(data, { requestId });
}

export async function DELETE(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  // `name` volta só para o audit: depois do delete a linha não existe, e o
  // recibo de "apagou o grupo X" precisa do nome para ser legível.
  const { data: apagado, error } = await supabase
    .from("message_template_groups")
    .delete()
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .select("id, name")
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao excluir o grupo.", 500, { requestId });
  if (!apagado) return fail("not_found", t("Grupo não encontrado."), 404, { requestId });

  void audit({
    action: "template_group.deleted",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "message_template_group",
    resourceId: apagado.id,
    requestId,
    metadata: { name: (apagado as { name: string }).name },
  });
  return noContent(requestId);
}
