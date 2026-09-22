/**
 * GET /api/v1/commercial-orders/[id]/timeline — a história do pedido (§30).
 *
 * Lê o audit append-only filtrado por recurso. Sem RLS própria? Tem: a rota
 * filtra organization_id do JWT — audit de outra org nunca aparece.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const ROTULO_ACAO: Record<string, string> = {
  "commercial_order.created": "Pedido criado",
  "commercial_order.updated": "Pedido alterado",
  "commercial_order.items_updated": "Itens alterados",
  "commercial_order.duplicated": "Duplicado deste pedido",
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "commercial_orders" });
  if (!authz.ok) return authz.response;

  const { id } = await params;
  const supabase = await createClient();

  const { data: pedido } = await supabase
    .from("commercial_orders")
    .select("id")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!pedido) return fail("not_found", "Pedido não encontrado.", 404, { requestId });

  const { data, error } = await supabase
    .from("api_audit_log")
    .select("action, actor_user_id, created_at")
    .eq("organization_id", authz.org.orgId)
    .eq("resource_type", "commercial_orders")
    .eq("resource_id", id)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) return fail("internal_error", "Erro ao ler o histórico.", 500, { requestId });

  // Nomes dos atores (poucos por pedido; mesmo custo da listagem de inbox).
  const ids = [...new Set(((data ?? []) as { actor_user_id: string | null }[]).map((a) => a.actor_user_id).filter(Boolean))] as string[];
  const nomes: Record<string, string> = {};
  if (ids.length > 0) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    await Promise.all(
      ids.slice(0, 50).map(async (uid) => {
        const { data: u } = await admin.auth.admin.getUserById(uid);
        const meta = u?.user?.user_metadata as { full_name?: string } | undefined;
        nomes[uid] = meta?.full_name ?? u?.user?.email ?? "Sistema";
      }),
    );
  }

  return ok(
    ((data ?? []) as unknown as { action: string; actor_user_id: string | null; created_at: string }[]).map((a) => ({
      acao: ROTULO_ACAO[a.action] ?? a.action,
      por: a.actor_user_id ? (nomes[a.actor_user_id] ?? "Sistema") : "Sistema",
      em: a.created_at,
    })),
    { requestId },
  );
}
