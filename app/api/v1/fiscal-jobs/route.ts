/**
 * GET /api/v1/fiscal-jobs — a fila fiscal da org (Manutenção do SPED).
 *
 * Traz cada job com número/série da nota para a tela dizer QUAL nota está
 * presa, há quantas tentativas e por quê — em vez de um contador abstrato.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "fiscal-jobs" });
  if (!authz.ok) return authz.response;

  const abertas = req.nextUrl.searchParams.get("abertas") === "1";
  const supabase = await createClient();
  let q = supabase
    .from("fiscal_jobs")
    .select("id, invoice_id, tipo, status, tentativas, max_tentativas, ultimo_erro, proxima_tentativa, created_at")
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (abertas) q = q.in("status", ["pendente", "processando", "erro"]);

  const { data: jobs, error } = await q;
  if (error) return fail("internal_error", "Erro ao listar a fila fiscal.", 500, { requestId });

  const lista = (jobs ?? []) as unknown as {
    id: string;
    invoice_id: string;
    tipo: string;
    status: string;
    tentativas: number;
    max_tentativas: number;
    ultimo_erro: string | null;
    proxima_tentativa: string;
    created_at: string;
  }[];
  const ids = [...new Set(lista.map((j) => j.invoice_id))];
  let notas: Record<string, { numero: number | null; serie: string; status: string }> = {};
  if (ids.length > 0) {
    const { data } = await supabase
      .from("invoices")
      .select("id, numero, serie, status")
      .eq("organization_id", authz.org.orgId)
      .in("id", ids);
    notas = Object.fromEntries(
      ((data ?? []) as unknown as { id: string; numero: number | null; serie: string; status: string }[]).map((n) => [
        n.id,
        { numero: n.numero, serie: n.serie, status: n.status },
      ]),
    );
  }

  return ok(
    lista.map((j) => ({ ...j, nota: notas[j.invoice_id] ?? null })),
    { requestId },
  );
}
