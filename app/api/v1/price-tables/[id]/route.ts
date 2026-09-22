/**
 * GET   /api/v1/price-tables/[id] — a tabela com seus itens.
 * PATCH /api/v1/price-tables/[id] — renomeia, muda desconto, ativa/desativa,
 *         troca a padrão (desmarcando a anterior).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  COLUNAS_DA_TABELA,
  COLUNAS_DO_ITEM_DE_TABELA,
  tabelaPatchSchema,
} from "@/lib/schemas/precos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "price_tables" });
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const supabase = await createClient();

  const { data: tabela, error: erroTabela } = await supabase
    .from("price_tables")
    .select(COLUNAS_DA_TABELA)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .single();

  if (erroTabela || !tabela) {
    return fail("not_found", "Tabela não encontrada.", 404, { requestId });
  }

  const { data: itens, error: erroItens } = await supabase
    .from("price_table_items")
    .select(COLUNAS_DO_ITEM_DE_TABELA)
    .eq("price_table_id", id)
    .eq("organization_id", authz.org.orgId)
    .limit(2000);

  if (erroItens) return fail("internal_error", "Erro ao ler os itens.", 500, { requestId });

  return ok({ ...(tabela as unknown as Record<string, unknown>), itens: itens ?? [] }, { requestId });
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "price_tables" });
  if (!authz.ok) return authz.response;

  const parsed = tabelaPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  if (Object.keys(parsed.data).length === 0) {
    return fail("validation_failed", "Nada para atualizar.", 422, { requestId });
  }

  const { id } = await params;
  const supabase = await createClient();

  if (parsed.data.padrao) {
    await supabase
      .from("price_tables")
      .update({ padrao: false })
      .eq("organization_id", authz.org.orgId)
      .eq("padrao", true)
      .neq("id", id);
  }

  const { data, error } = await supabase
    .from("price_tables")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select(COLUNAS_DA_TABELA)
    .single();

  if (error || !data) return fail("not_found", "Tabela não encontrada.", 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "price_table.updated",
    resourceType: "price_tables",
    resourceId: id,
    requestId,
  });

  return ok(data, { requestId });
}
