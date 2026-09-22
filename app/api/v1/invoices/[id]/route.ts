/**
 * GET /api/v1/invoices/[id] — detalhe da nota com timeline de eventos.
 *
 * Junta invoice + eventos (ordem cronológica) + job aberto (tentativas).
 * É o que a tela de detalhe e a conciliação leem.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DA_NOTA } from "@/lib/schemas/fiscal";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "invoices" });
  if (!authz.ok) return authz.response;
  const { id } = await params;

  const supabase = await createClient();
  const { data: nota, error } = await supabase
    .from("invoices")
    .select(`${COLUNAS_DA_NOTA}, xml`)
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao ler a nota.", 500, { requestId });
  if (!nota) return fail("not_found", "Nota não encontrada.", 404, { requestId });

  const [eventos, jobs] = await Promise.all([
    supabase
      .from("fiscal_events")
      .select("id, tipo, status, protocolo, mensagem, created_at")
      .eq("organization_id", authz.org.orgId)
      .eq("invoice_id", id)
      .order("created_at", { ascending: true })
      .limit(100),
    supabase
      .from("fiscal_jobs")
      .select("id, status, tentativas, max_tentativas, proxima_tentativa, ultimo_erro")
      .eq("organization_id", authz.org.orgId)
      .eq("invoice_id", id)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  return ok(
    {
      ...(nota as unknown as Record<string, unknown>),
      tem_xml: Boolean((nota as unknown as { xml?: string | null }).xml),
      eventos: eventos.data ?? [],
      jobs: jobs.data ?? [],
    },
    { requestId },
  );
}
