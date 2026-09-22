/**
 * PUT /api/v1/price-tables/[id]/items — substitui os preços da tabela.
 *
 * Recebe a lista completa `{ itens: [{ product_id, preco_cents }] }` e troca o
 * conjunto inteiro (delete + insert). Troca total e não upsert incremental
 * porque a tela edita a tabela como planilha: o que ela manda É a tabela, e
 * item que sumiu da lista saiu da tabela — merge silencioso manteria preço
 * velho que o gerente acha que tirou.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { itemDeTabelaSchema } from "@/lib/schemas/precos";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  itens: z.array(itemDeTabelaSchema).max(5000),
});

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "price_table_items" });
  if (!authz.ok) return authz.response;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const { id } = await params;
  const supabase = await createClient();

  // A tabela tem de ser da org — item de tabela alheia morre aqui.
  const { data: tabela } = await supabase
    .from("price_tables")
    .select("id")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!tabela) return fail("not_found", "Tabela não encontrada.", 404, { requestId });

  // Produtos fora da org não entram na tabela.
  const ids = [...new Set(parsed.data.itens.map((i) => i.product_id))];
  if (ids.length > 0) {
    const { data: prods } = await supabase
      .from("catalog_products")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .in("id", ids);
    const okIds = new Set((prods ?? []).map((p) => (p as unknown as { id: string }).id));
    const estranho = ids.find((pid) => !okIds.has(pid));
    if (estranho) {
      return fail("validation_failed", "Um dos produtos não é desta organização.", 422, { requestId });
    }
  }

  const { error: erroApaga } = await supabase
    .from("price_table_items")
    .delete()
    .eq("price_table_id", id)
    .eq("organization_id", authz.org.orgId);
  if (erroApaga) return fail("internal_error", "Erro ao limpar os preços.", 500, { requestId });

  if (parsed.data.itens.length > 0) {
    const { error: erroInsere } = await supabase.from("price_table_items").insert(
      parsed.data.itens.map((i) => ({
        organization_id: authz.org.orgId,
        price_table_id: id,
        product_id: i.product_id,
        preco_cents: i.preco_cents,
      })),
    );
    if (erroInsere) return fail("internal_error", "Erro ao salvar os preços.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "price_table.updated",
    resourceType: "price_tables",
    resourceId: id,
    requestId,
  });

  return ok({ itens: parsed.data.itens.length }, { requestId });
}
