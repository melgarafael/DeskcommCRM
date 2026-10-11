/**
 * GET /api/v1/external-db/connections/:id/catalog (admin)
 *
 * O catálogo COMPLETO do banco de origem, ignorando as fontes liberadas. Existe
 * só para a tela de marcação (o administrador precisa ver tudo para escolher o
 * que liberar). Mesma guarda de host e mesmos erros de `schemas/route.ts`.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { abrirAcesso } from "@/lib/external-db/acesso";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

import { respostaDeAcesso, seModuloDesligado } from "../../../_falha";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "external_db_connections" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  // Chave PRÓPRIA (cada chamada vai AO VIVO ao banco do cliente), mais estreita
  // que a da grade: o catálogo completo é a leitura mais cara.
  const limite = await checkRateLimit(`external-db:catalog:${activeOrg.orgId}`, 30, 60);
  if (!limite.allowed) {
    return fail("rate_limited", t("Muitas consultas em pouco tempo. Tente de novo em instantes."), 429, {
      requestId,
    });
  }

  const acesso = await abrirAcesso(createAdminClient(), activeOrg.orgId, id);
  if (!acesso.ok) return respostaDeAcesso(acesso.motivo, { requestId, idioma: authUser.idioma });

  try {
    const tabelas = await acesso.dialeto.catalogoCompleto();

    await audit({
      action: "external_db_connection.read",
      actorUserId: authUser.id,
      organizationId: activeOrg.orgId,
      resourceType: "external_db_connection",
      resourceId: id,
      requestId,
      metadata: { escopo: "catalogo_completo", tabelas: tabelas.length },
    });

    return ok({ tabelas }, { requestId });
  } catch {
    return fail(
      "upstream_unavailable",
      t("Não foi possível ler o catálogo do banco externo agora."),
      502,
      { requestId },
    );
  }
}
