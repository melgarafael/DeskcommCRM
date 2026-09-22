/**
 * GET  /api/v1/fiscal-inutilizacoes — faixas inutilizadas da org (recentes primeiro).
 * POST /api/v1/fiscal-inutilizacoes — inutiliza uma faixa de numeração por série.
 *
 * Inutilizar é enterrar número que nunca virou nota: a rota recusa faixa que
 * cruze nota viva (não cancelada) da mesma série e faixa já inutilizada.
 * Nasce "registrada": a transmissão à SEFAZ exige sidecar com endpoint
 * próprio, que hoje não existe — e nada aqui finge que transmitiu.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { inutilizacaoSchema } from "@/lib/schemas/fiscal";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "fiscal-inutilizacoes" });
  if (!authz.ok) return authz.response;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("fiscal_inutilizacoes")
    .select("id, serie, numero_inicial, numero_final, motivo, ambiente, status, sefaz_protocolo, sefaz_xmotivo, created_at")
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return fail("internal_error", "Erro ao listar as inutilizações.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "fiscal-inutilizacoes" });
  if (!authz.ok) return authz.response;

  const parsed = inutilizacaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Faixa ou motivo inválidos.", 422, { requestId });
  }
  const { serie, numero_inicial, numero_final, motivo } = parsed.data;

  const supabase = await createClient();

  // Faixa com nota viva não se inutiliza: seria enterrar documento existente.
  const { data: vivas } = await supabase
    .from("invoices")
    .select("numero")
    .eq("organization_id", authz.org.orgId)
    .eq("serie", serie)
    .neq("status", "cancelada")
    .gte("numero", numero_inicial)
    .lte("numero", numero_final)
    .limit(1);
  if (vivas && (vivas as unknown[]).length > 0) {
    return fail("conflict", "A faixa cruza nota existente (não cancelada) — inutilização recusada.", 409, { requestId });
  }

  const { data: sobrepostas } = await supabase
    .from("fiscal_inutilizacoes")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("serie", serie)
    .lte("numero_inicial", numero_final)
    .gte("numero_final", numero_inicial)
    .limit(1);
  if (sobrepostas && (sobrepostas as unknown[]).length > 0) {
    return fail("conflict", "A faixa cruza inutilização já registrada.", 409, { requestId });
  }

  const { data: config } = await supabase
    .from("fiscal_settings")
    .select("ambiente")
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const ambiente = (config as unknown as { ambiente?: string } | null)?.ambiente === "producao" ? "producao" : "homologacao";

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("fiscal_inutilizacoes")
    .insert({
      organization_id: authz.org.orgId,
      serie: serie.trim(),
      numero_inicial,
      numero_final,
      motivo: motivo.trim(),
      ambiente,
      status: "registrada",
      created_by: authz.user.id,
    })
    .select("id, serie, numero_inicial, numero_final, motivo, ambiente, status, created_at")
    .single();

  if (error || !data) {
    return fail("internal_error", "Erro ao registrar a inutilização.", 500, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "fiscal.inutilizacao",
    resourceType: "fiscal_inutilizacoes",
    resourceId: (data as unknown as { id: string }).id,
    requestId,
  });

  return ok(data, { requestId, status: 201 });
}
