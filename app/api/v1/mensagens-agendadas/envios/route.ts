/**
 * GET /api/v1/mensagens-agendadas/envios?contact_id=… — relatório: os últimos 30
 * envios (enviados, falhados ou pulados) das mensagens agendadas do contato.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { ok, fail } from "@/lib/api/wrappers";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const auth = await requireRole("agent", { requestId, resource: "mensagens_agendadas" });
  if (!auth.ok) return auth.response;
  const contactId = req.nextUrl.searchParams.get("contact_id");
  if (!contactId || !z.uuid().safeParse(contactId).success) {
    return fail("validation_failed", "contact_id inválido.", 422, { requestId });
  }
  const { data, error } = await createAdminClient()
    .from("mensagens_agendadas_envios")
    .select(
      "id, prevista_para, desfecho, erro, created_at, agendamento:mensagens_agendadas!inner(id, title, body, recorrencia, intervalo_dias, contact_id)",
    )
    .eq("organization_id", auth.org.orgId)
    .eq("agendamento.contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) return fail("internal_error", "Erro ao listar envios.", 500, { requestId });
  return ok(data ?? [], { requestId });
}
