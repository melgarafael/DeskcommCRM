import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET /api/v1/external-db/connections/:id/sources (qualquer autenticado)
 * PUT /api/v1/external-db/connections/:id/sources (admin)
 *
 * As FONTES LIBERADAS da conexão: o modo (`all` | `list`) e a lista do que o
 * assistente e a grade podem ler. O `PUT` troca o modo E a lista inteira de uma
 * vez — um UPDATE atômico, sem estado pela metade — e por isso é naturalmente
 * idempotente: repetir o mesmo corpo grava o mesmo estado (não há
 * `Idempotency-Key`).
 *
 * NÃO exige que a fonte exista no banco de origem na hora de gravar: o catálogo
 * ao vivo pode estar fora do ar, e a tela marca "não encontrada no banco" a
 * fonte que sumiu. A organização vem do contexto autenticado, nunca do corpo.
 *
 * O audit guarda CONTAGENS (modo e número de fontes) — nunca nomes.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { lerFontesDoBanco } from "@/lib/external-db/fontes";
import { atualizarFontesSchema } from "@/lib/external-db/schemas";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

import { seModuloDesligado } from "../../../_falha";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "external_db_connections" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { data, error } = await createAdminClient()
    .from("external_db_connections")
    .select("source_mode, sources")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();

  if (error) return fail("internal_error", "Erro ao ler as fontes.", 500, { requestId });
  if (!data) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });

  // Lista corrompida volta VAZIA: o que o assistente enxerga nesse caso é nada,
  // e a tela deve mostrar o mesmo (falha fechada).
  const lida = lerFontesDoBanco(data.sources);
  return ok(
    { source_mode: data.source_mode as string, sources: lida.ok ? lida.fontes : [] },
    { requestId },
  );
}

export async function PUT(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "external_db_connections" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  const limite = await checkRateLimit(`external-db:write:${activeOrg.orgId}`, 30, 60);
  if (!limite.allowed) {
    return fail("rate_limited", t("Muitas alterações em pouco tempo. Tente de novo em instantes."), 429, {
      requestId,
    });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = atualizarFontesSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { source_mode, sources } = parsed.data;

  const { data: atualizado, error } = await createAdminClient()
    .from("external_db_connections")
    .update({ source_mode, sources })
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .select("source_mode, sources")
    .maybeSingle();

  if (error) return fail("internal_error", "Erro ao salvar as fontes.", 500, { requestId });
  if (!atualizado) return fail("not_found", t("Conexão não encontrada."), 404, { requestId });

  await audit({
    action: "external_db_sources.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "external_db_connection",
    resourceId: id,
    requestId,
    metadata: { source_mode, fontes: sources.length },
  });

  return ok({ source_mode: atualizado.source_mode as string, sources }, { requestId });
}
