/**
 * POST /api/v1/cobranca/assinatura/sincronizar — "Já paguei" e a volta do
 * checkout (`?voltou=1`), spec §7b.4 e §7d.5. Relê o provedor pela MESMA
 * `sincronizar` do sinal e do cron: quem pagou e está suspensa volta aqui, na
 * hora. Uma releitura a cada 30 s por empresa — o mesmo custo que o coalescer
 * dá a um sinal forjado.
 */
import { randomUUID } from "node:crypto";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { sincronizar } from "@/lib/cobranca/sincronizar";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { ehOperante } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST() {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "cobranca_assinaturas", permiteOrgSuspensa: true });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca"))) return fail("not_found", "Not found", 404, { requestId });
  const orgId = authz.org.orgId;

  const taxa = await checkRateLimit(`cobranca-sincronizar:${orgId}`, 1, 30);
  if (!taxa.allowed) {
    return fail("rate_limited", "Aguarde alguns segundos para conferir de novo.", 429, { requestId, headers: { "Retry-After": "30" } });
  }
  const r = await sincronizar(admin, orgId);
  if (r.tipo === "isenta") return fail("not_found", "Sua empresa não tem plano de cobrança.", 404, { requestId });
  if (r.tipo === "falhou" && !r.transitorio) {
    // Chave inválida ou leitura inválida é do dono do sistema: esperar não resolve.
    return fail("provedor_recusou", "O provedor de pagamento recusou a conferência. Fale com quem administra o sistema.", 502, { requestId });
  }
  if (r.tipo === "falhou") {
    return fail("provedor_indisponivel", "Não conseguimos falar com o provedor de pagamento agora. Tente de novo em alguns minutos.", 503, { requestId });
  }
  const [linha, org] = await Promise.all([
    admin.from("cobranca_assinaturas").select("estado, assinaturas_vivas").eq("organization_id", orgId).maybeSingle(),
    admin.from("organizations").select("status").eq("id", orgId).maybeSingle(),
  ]);
  if (linha.error || org.error) return fail("internal_error", "Não foi possível ler a situação.", 500, { requestId });
  const lida = linha.data as { estado: string; assinaturas_vivas: number } | null;
  return ok(
    {
      estado: lida?.estado ?? null,
      assinaturas_vivas: lida?.assinaturas_vivas ?? 0,
      org_operante: ehOperante((org.data as { status?: string } | null)?.status),
    },
    { requestId },
  );
}
