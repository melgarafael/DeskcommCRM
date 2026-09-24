/**
 * PATCH  /api/v1/campaign-templates/:id — reescreve a copy guardada.
 * DELETE /api/v1/campaign-templates/:id — tira da lista.
 *
 * Mexer aqui NÃO alcança campanha nenhuma: o texto que cada pessoa recebe é
 * congelado em `campaign_recipients.rendered_body` na preparação, com o
 * `content_version` junto. Editar um template amanhã não reescreve o que alguém
 * recebeu ontem — e apagar um template não apaga campanha que o usou.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { editarTemplateSchema } from "@/lib/campanhas/schemas";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const COLUNAS = "id, name, body, created_at, updated_at, created_by";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaign_templates" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const parsed = editarTemplateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  }

  const mudanca: Record<string, unknown> = { updated_by: authz.user.id };
  if (parsed.data.name !== undefined) mudanca.name = parsed.data.name;
  if (parsed.data.body !== undefined) mudanca.body = parsed.data.body;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("campaign_templates")
    .update(mudanca)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select(COLUNAS)
    .maybeSingle();
  if (error) {
    if (error.code === "23505") {
      return fail("campanha_conteudo_invalido", t("Já existe um texto salvo com esse nome."), 409, {
        requestId,
      });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }
  if (!data) return fail("campanha_nao_encontrada", t("Texto não encontrado."), 404, { requestId });

  return ok(data, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const negado = await requireSupportWrite();
  if (negado) return negado;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaign_templates" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("campaign_templates")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("campanha_nao_encontrada", t("Texto não encontrado."), 404, { requestId });

  return ok({ id }, { requestId });
}
