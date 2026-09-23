/**
 * GET /api/v1/external-db/connections/:id/tables/:schema/:tabela
 *
 * Dados paginados de uma tabela/view. O SELECT é montado no servidor
 * (`lib/external-db/leitura`): a projeção e a ordem são validadas contra as
 * colunas REAIS lidas do catálogo, e só existe a lista fechada de operadores.
 *
 * SEM FILTRO pela querystring, de propósito: filtro carrega VALOR, valor carrega
 * PII, e querystring vai para log de proxy. A consulta filtrada é da IA (Fase 5),
 * que chama o núcleo direto.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { abrirAcesso } from "@/lib/external-db/acesso";
import { colunasDaTabela } from "@/lib/external-db/introspeccao";
import { LeituraInvalidaError, lerTabela } from "@/lib/external-db/leitura";
import { leituraQuerySchema } from "@/lib/external-db/schemas";
import type { PedidoDeLeitura } from "@/lib/external-db/types";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

import { respostaDeAcesso, seModuloDesligado } from "../../../../../_falha";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; schema: string; tabela: string }> };

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const desligado = await seModuloDesligado(requestId);
  if (desligado) return desligado;
  const { id, schema, tabela } = await ctx.params;

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

  const sp = req.nextUrl.searchParams;
  const parsed = leituraQuerySchema.safeParse({
    limit: sp.get("limit") ?? undefined,
    offset: sp.get("offset") ?? undefined,
    order_by: sp.get("order_by") ?? undefined,
    order_desc: sp.get("order_desc") ?? undefined,
    colunas: sp.get("colunas") ?? undefined,
  });
  if (!parsed.success) {
    return fail("validation_failed", t("Parâmetros de leitura inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const query = parsed.data;

  const acesso = await abrirAcesso(createAdminClient(), activeOrg.orgId, id);
  if (!acesso.ok) return respostaDeAcesso(acesso.motivo, { requestId, idioma: authUser.idioma });

  const permitidas = await colunasDaTabela(acesso.pool, schema, tabela);
  if (!permitidas) {
    return fail("not_found", t("Tabela ou view não encontrada."), 404, { requestId });
  }

  const colunas = (query.colunas ?? "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const desc = query.order_desc === "true" || query.order_desc === "1";
  const pedido: PedidoDeLeitura = {
    schema,
    tabela,
    colunas,
    filtros: [],
    ...(query.order_by ? { ordem: { coluna: query.order_by, desc } } : {}),
    // O teto efetivo é o configurado na conexão, não o absoluto.
    limite: Math.min(query.limit, acesso.conexao.maxRows),
    offset: query.offset,
  };

  try {
    const resultado = await lerTabela(acesso.pool, pedido, permitidas, {
      limiteMax: acesso.conexao.maxRows,
    });

    await audit({
      action: "external_db_connection.read",
      actorUserId: authUser.id,
      organizationId: activeOrg.orgId,
      resourceType: "external_db_connection",
      resourceId: id,
      requestId,
      metadata: {
        schema,
        tabela,
        limite: resultado.limite,
        offset: resultado.offset,
        ...(query.order_by ? { order_by: query.order_by } : {}),
      },
    });

    return ok(resultado, { requestId });
  } catch (err) {
    if (err instanceof LeituraInvalidaError) {
      return fail("validation_failed", t("Pedido de leitura inválido."), 422, {
        requestId,
        details: { motivo: err.message },
      });
    }
    return fail("upstream_unavailable", t("Não foi possível consultar o banco externo agora."), 502, {
      requestId,
    });
  }
}
