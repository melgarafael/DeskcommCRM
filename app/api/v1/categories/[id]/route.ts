/**
 * GET    /api/v1/categories/[id] — uma categoria.
 * PATCH  /api/v1/categories/[id] — renomeia, move de pai, reordena, ativa/desativa.
 * DELETE /api/v1/categories/[id] — apaga. Filhas e produtos caem para NULL
 *          (`on delete cascade` na auto-FK apaga a subárvore; produtos usam
 *          `set null` e sobrevivem sem categoria).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { categoriaPatchSchema, COLUNAS_DA_CATEGORIA } from "@/lib/schemas/precos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Sobe a cadeia de pais até a raiz (teto 20 níveis) para detectar ciclo. */
async function paisDa(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  id: string,
): Promise<string[]> {
  const cadeia: string[] = [];
  let atual: string | null = id;
  for (let i = 0; i < 20 && atual; i++) {
    const res: { data: { parent_id: string | null } | null } = await supabase
      .from("product_categories")
      .select("parent_id")
      .eq("id", atual)
      .eq("organization_id", orgId)
      .maybeSingle();
    const pai: string | null = res.data?.parent_id ?? null;
    if (!pai) break;
    cadeia.push(pai);
    atual = pai;
  }
  return cadeia;
}

export async function GET(_req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "product_categories" });
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("product_categories")
    .select(COLUNAS_DA_CATEGORIA)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .single();

  if (error || !data) return fail("not_found", "Categoria não encontrada.", 404, { requestId });
  return ok(data, { requestId });
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "product_categories" });
  if (!authz.ok) return authz.response;

  const parsed = categoriaPatchSchema.safeParse(await req.json().catch(() => null));
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

  // Mover para debaixo de si mesma (ou de um descendente) fecha ciclo: a
  // árvore vira laço e a tela entra em recursão. A conferência sobe a cadeia.
  if (parsed.data.parent_id !== undefined && parsed.data.parent_id !== null) {
    if (parsed.data.parent_id === id) {
      return fail("validation_failed", "Uma categoria não pode ser pai de si mesma.", 422, { requestId });
    }
    const cadeia = await paisDa(supabase, authz.org.orgId, parsed.data.parent_id);
    if (cadeia.includes(id)) {
      return fail("validation_failed", "Esse pai é descendente desta categoria — mover criaria um ciclo.", 422, { requestId });
    }
  }

  const { data, error } = await supabase
    .from("product_categories")
    .update(parsed.data)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select(COLUNAS_DA_CATEGORIA)
    .single();

  if (error || !data) return fail("not_found", "Categoria não encontrada.", 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "catalog_category.updated",
    resourceType: "product_categories",
    resourceId: id,
    requestId,
  });

  return ok(data, { requestId });
}

export async function DELETE(_req: NextRequest, { params }: Params): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "product_categories" });
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("product_categories")
    .delete()
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select("id")
    .maybeSingle();

  if (error || !data) return fail("not_found", "Categoria não encontrada.", 404, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "catalog_category.deleted",
    resourceType: "product_categories",
    resourceId: id,
    requestId,
  });

  return ok({ id }, { requestId });
}
