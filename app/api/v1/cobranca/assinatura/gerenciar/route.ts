/**
 * POST /api/v1/cobranca/assinatura/gerenciar — o portal do provedor, onde a
 * empresa troca o cartão e vê as faturas (spec §13). A troca de PLANO não
 * mora lá (o portal é configurado sem ela): é a nossa tela que agenda.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { limiteDoProvedorPorOrg, recusaDoProvedor } from "@/lib/cobranca/falhas";
import { adaptador } from "@/lib/cobranca/provedores";
import { urlDoPainelDaEmpresa } from "@/lib/cobranca/url";
import type { ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
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

  const { data, error } = await admin
    .from("cobranca_assinaturas")
    .select("provedor, provedor_cliente_id")
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível ler a assinatura.", 500, { requestId });
  const linha = data as { provedor: ProvedorDeCobranca | null; provedor_cliente_id: string | null } | null;
  const semPortal = () => fail("sem_portal", "Sua empresa ainda não tem assinatura no provedor de pagamento.", 409, { requestId });
  if (!linha?.provedor || !linha.provedor_cliente_id) return semPortal();
  if (!(await limiteDoProvedorPorOrg(authz.org.orgId))) {
    return fail("rate_limited", "Muitas tentativas seguidas. Aguarde um minuto e tente de novo.", 429, { requestId, headers: { "Retry-After": "60" } });
  }
  try {
    const url = await adaptador(linha.provedor).urlDeGerenciar({ clienteRef: linha.provedor_cliente_id, urlDeVolta: urlDoPainelDaEmpresa() });
    return url ? ok({ url }, { requestId }) : semPortal();
  } catch (e) {
    const r = recusaDoProvedor(e);
    return fail(r.code, r.message, r.status, { requestId });
  }
}
