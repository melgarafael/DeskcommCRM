/**
 * GET /api/v1/external-db/connections/:id/schemas (qualquer autenticado)
 *
 * Retrato AO VIVO do catálogo: tabelas, views, colunas, chave primária e
 * estimativa de linhas. Não existe cache de schema — ele muda com frequência, e
 * cache é exatamente como uma coluna nova some da tela sem ninguém remover nada.
 *
 * A leitura é auditada (dado de terceiro pode ter PII). O metadata registra o
 * ESCOPO lido, nunca conteúdo de linha.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { abrirAcesso } from "@/lib/external-db/acesso";
import { listarTabelas } from "@/lib/external-db/introspeccao";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

import { respostaDeAcesso } from "../../../_falha";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", { requestId, resource: "external_db_connections" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  const limite = await checkRateLimit(`external-db:read:${activeOrg.orgId}`, 120, 60);
  if (!limite.allowed) {
    return fail("rate_limited", t("Muitas consultas em pouco tempo. Tente de novo em instantes."), 429, {
      requestId,
    });
  }

  const acesso = await abrirAcesso(createAdminClient(), activeOrg.orgId, id);
  if (!acesso.ok) return respostaDeAcesso(acesso.motivo, { requestId, idioma: authUser.idioma });

  try {
    const tabelas = await listarTabelas(acesso.pool);

    await audit({
      action: "external_db_connection.read",
      actorUserId: authUser.id,
      organizationId: activeOrg.orgId,
      resourceType: "external_db_connection",
      resourceId: id,
      requestId,
      metadata: { escopo: "catalogo", tabelas: tabelas.length },
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
