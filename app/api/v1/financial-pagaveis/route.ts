/**
 * GET /api/v1/financial-pagaveis — contas a pagar da organização ativa.
 *
 * Leitura pura (viewer+): o detalhe da entrada mostra as parcelas geradas
 * na importação. Baixa e cancelamento são fase futura — hoje o status
 * nasce `aberto` e a tela diz isso.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DO_PAGAVEL } from "@/lib/schemas/fiscal-entrada";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "financial-pagaveis" });
  if (!authz.ok) return authz.response;

  const entradaId = req.nextUrl.searchParams.get("entrada_id")?.trim() ?? "";
  const supabase = await createClient();
  let q = supabase
    .from("financial_pagaveis")
    .select(COLUNAS_DO_PAGAVEL)
    .eq("organization_id", authz.org.orgId);

  if (entradaId !== "") {
    q = q.eq("entrada_id", entradaId);
  }

  const { data, error } = await q.order("vencimento", { ascending: true }).limit(500);
  if (error) return fail("internal_error", "Erro ao listar as contas a pagar.", 500, { requestId });
  return ok(data ?? [], { requestId });
}
