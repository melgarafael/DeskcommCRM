/**
 * GET  /api/v1/categories — árvore de categorias da organização ativa.
 * POST /api/v1/categories — cria uma categoria (filha se `parent_id` vier).
 *
 * Escrita exige `manager`, como o catálogo: categoria organiza preço.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { categoriaCreateSchema, COLUNAS_DA_CATEGORIA } from "@/lib/schemas/precos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "product_categories" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("product_categories")
    .select(COLUNAS_DA_CATEGORIA)
    .eq("organization_id", authz.org.orgId)
    .order("posicao")
    .order("nome")
    .limit(500);

  if (error) return fail("internal_error", "Erro ao listar as categorias.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "product_categories" });
  if (!authz.ok) return authz.response;

  const parsed = categoriaCreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();

  // O pai tem de ser da mesma org — parent_id forjado de outra org morre aqui,
  // não na FK (que não enxerga tenant).
  if (parsed.data.parent_id) {
    const { data: pai } = await supabase
      .from("product_categories")
      .select("id")
      .eq("id", parsed.data.parent_id)
      .eq("organization_id", authz.org.orgId)
      .maybeSingle();
    if (!pai) {
      return fail("validation_failed", "Categoria pai não encontrada.", 422, { requestId });
    }
  }

  const { data, error } = await supabase
    .from("product_categories")
    .insert({ ...parsed.data, organization_id: authz.org.orgId })
    .select(COLUNAS_DA_CATEGORIA)
    .single();

  if (error) {
    if (error.code === "23505") {
      return fail("conflict", "Já existe uma categoria com esse nome neste nível.", 409, { requestId });
    }
    return fail("internal_error", "Erro ao salvar a categoria.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "catalog_category.created",
    resourceType: "product_categories",
    resourceId: (data as unknown as { id: string }).id,
    requestId,
  });

  return ok(data, { requestId, status: 201 });
}
