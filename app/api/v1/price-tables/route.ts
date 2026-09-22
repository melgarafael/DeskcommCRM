/**
 * GET  /api/v1/price-tables — tabelas de preço da organização ativa.
 * POST /api/v1/price-tables — cria uma tabela.
 *
 * Escrita exige `manager`, como o catálogo: preço de venda.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DA_TABELA, tabelaCreateSchema } from "@/lib/schemas/precos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "price_tables" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("price_tables")
    .select(COLUNAS_DA_TABELA)
    .eq("organization_id", authz.org.orgId)
    .order("nome")
    .limit(100);

  if (error) return fail("internal_error", "Erro ao listar as tabelas.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "price_tables" });
  if (!authz.ok) return authz.response;

  const parsed = tabelaCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  // Só uma padrão por org: marcar esta desmarca a anterior. Duas padrões e a
  // rota de pedidos não sabe qual usar — o índice único parcial impede no
  // banco, e aqui se resolve sem 409.
  if (parsed.data.padrao) {
    await supabase
      .from("price_tables")
      .update({ padrao: false })
      .eq("organization_id", authz.org.orgId)
      .eq("padrao", true);
  }

  const { data, error } = await supabase
    .from("price_tables")
    .insert({ ...parsed.data, organization_id: authz.org.orgId })
    .select(COLUNAS_DA_TABELA)
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", "Já existe uma tabela com esse nome.", 409, { requestId });
    }
    return fail("internal_error", "Erro ao salvar a tabela.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "price_table.created",
    resourceType: "price_tables",
    resourceId: (data as unknown as { id: string }).id,
    requestId,
  });

  return ok(data, { requestId, status: 201 });
}
