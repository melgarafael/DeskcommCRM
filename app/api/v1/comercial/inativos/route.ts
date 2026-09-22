/**
 * GET /api/v1/comercial/inativos — clientes que compravam e pararam.
 *
 * `?dias=60`: sem compra há ao menos N dias. Só quem JÁ comprou (cancelado
 * não conta como compra); ordenado por score de recuperação.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { classificarInativo } from "@/lib/comercial/inatividade";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "commercial_orders" });
  if (!authz.ok) return authz.response;

  const dias = Math.min(3650, Math.max(1, Number(req.nextUrl.searchParams.get("dias") ?? 60) || 60));
  const corte = new Date(Date.now() - dias * 86400000).toISOString();

  const supabase = await createClient();

  // Última compra por contato (cancelado não é compra). Sem RPC nova: duas
  // queries simples e o join em código — volume de PME, não de marketplace.
  const { data: pedidos, error: erroPedidos } = await supabase
    .from("commercial_orders")
    .select("contact_id, total_cents, created_at")
    .eq("organization_id", authz.org.orgId)
    .neq("status", "cancelado")
    .not("contact_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (erroPedidos) return fail("internal_error", "Erro ao ler os pedidos.", 500, { requestId });

  const porContato = new Map<string, { ultima: string; total: number; qtd: number }>();
  for (const p of (pedidos ?? []) as unknown as {
    contact_id: string;
    total_cents: number;
    created_at: string;
  }[]) {
    const atual = porContato.get(p.contact_id);
    if (!atual) {
      porContato.set(p.contact_id, { ultima: p.created_at, total: p.total_cents, qtd: 1 });
    } else {
      atual.total += p.total_cents;
      atual.qtd += 1;
    }
  }

  const inativos: string[] = [];
  for (const [contactId, v] of porContato) {
    if (v.ultima < corte) inativos.push(contactId);
  }
  if (inativos.length === 0) return ok([], { requestId });

  const { data: contatos, error: erroContatos } = await supabase
    .from("contacts")
    .select("id, display_name, name, phone_number")
    .eq("organization_id", authz.org.orgId)
    .in("id", inativos.slice(0, 500));

  if (erroContatos) return fail("internal_error", "Erro ao ler os contatos.", 500, { requestId });

  const agora = Date.now();
  const lista = ((contatos ?? []) as unknown as {
    id: string;
    display_name: string | null;
    name: string | null;
    phone_number: string | null;
  }[])
    .map((c) => {
      const v = porContato.get(c.id);
      if (!v) return null;
      const diasSem = Math.floor((agora - new Date(v.ultima).getTime()) / 86400000);
      return classificarInativo(
        { contact_id: c.id, nome: c.display_name ?? c.name ?? c.phone_number ?? "Sem nome", telefone: c.phone_number },
        diasSem,
        v.total,
        v.qtd,
      );
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.score - a.score);

  return ok(lista, { requestId });
}
