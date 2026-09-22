/**
 * POST /api/v1/invoices/[id]/cancel — cancela uma nota.
 *
 * Pendente/erro cancela direto (nada foi ao fisco). Autorizada exige motivo
 * (regra fiscal: cancelamento após autorização é ato formal) — e sem emissor
 * real não há autorizada a cancelar, então o caminho existe para o dia em que
 * houver. Denegada/cancelada não mudam: história fiscal não se reescreve.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DA_NOTA } from "@/lib/schemas/fiscal";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const corpoSchema = z.object({
  motivo: z.string().trim().max(500).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "invoices" });
  if (!authz.ok) return authz.response;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, { requestId });
  }

  const { id } = await params;
  const supabase = await createClient();

  const { data: nota } = await supabase
    .from("invoices")
    .select("id, status")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  const atual = nota as unknown as { id: string; status: string } | null;
  if (!atual) return fail("not_found", "Nota não encontrada.", 404, { requestId });

  if (atual.status === "cancelada" || atual.status === "denegada") {
    return fail("validation_failed", "Nota encerrada não pode ser cancelada.", 422, { requestId });
  }
  if (atual.status === "autorizada" && !parsed.data.motivo) {
    return fail("validation_failed", "Cancelar nota autorizada exige motivo.", 422, { requestId });
  }

  // Cancela também o job aberto: sem isso o drain emitiria uma nota que o
  // usuário acabou de cancelar (o claim condicional já protege a corrida —
  // quem chegar primeiro vence, o outro encontra o estado final).
  const admin = createAdminClient();
  await admin
    .from("fiscal_jobs")
    .update({ status: "concluido", ultimo_erro: "nota cancelada", updated_at: new Date().toISOString() })
    .eq("organization_id", authz.org.orgId)
    .eq("invoice_id", id)
    .in("status", ["pendente", "processando"]);

  const { data, error } = await supabase
    .from("invoices")
    .update({ status: "cancelada", erro: parsed.data.motivo ?? null })
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select(COLUNAS_DA_NOTA)
    .single();

  if (error || !data) {
    return fail("internal_error", "Erro ao cancelar a nota.", 500, { requestId });
  }

  await admin.from("fiscal_events").insert({
    organization_id: authz.org.orgId,
    invoice_id: id,
    tipo: "cancelada",
    status: "cancelada",
    mensagem: parsed.data.motivo ?? null,
  });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "invoice.cancelled",
    resourceType: "invoices",
    resourceId: id,
    requestId,
  });

  return ok(data, { requestId });
}
