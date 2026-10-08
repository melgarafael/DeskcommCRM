/**
 * POST /api/v1/cobranca/assinatura/cancelar — a empresa cancela (spec §7f,
 * D-14): o acesso segue até o fim do período pago e não há reembolso
 * automático. Depois de cancelar no provedor, grava a marca e audita; relê (melhor esforço): a tela já mostra
 * "Cancelada, acesso até DD/MM" sem esperar o aviso do provedor.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { limiteDoProvedorPorOrg, recusaDoProvedor } from "@/lib/cobranca/falhas";
import { adaptador } from "@/lib/cobranca/provedores";
import { sincronizar } from "@/lib/cobranca/sincronizar";
import type { ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
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

  const lerLinha = () =>
    admin
      .from("cobranca_assinaturas")
      .select("provedor, provedor_assinatura_id, proximo_vencimento, cancela_no_fim")
      .eq("organization_id", orgId)
      .maybeSingle();
  const { data, error } = await lerLinha();
  if (error) return fail("internal_error", "Não foi possível ler a assinatura.", 500, { requestId });
  const linha = data as { provedor: ProvedorDeCobranca | null; provedor_assinatura_id: string | null; proximo_vencimento: string | null; cancela_no_fim: boolean } | null;
  if (!linha) return fail("not_found", "Sua empresa não tem plano de cobrança.", 404, { requestId });
  if (!linha.provedor || !linha.provedor_assinatura_id) {
    return fail("state_conflict", "Não há assinatura paga para cancelar.", 409, { requestId });
  }
  if (linha.cancela_no_fim) return ok({ changed: false, acesso_ate: linha.proximo_vencimento }, { requestId });
  if (!(await limiteDoProvedorPorOrg(orgId))) {
    return fail("rate_limited", "Muitas tentativas seguidas. Aguarde um minuto e tente de novo.", 429, { requestId, headers: { "Retry-After": "60" } });
  }

  try {
    await adaptador(linha.provedor).cancelarNoFim(linha.provedor_assinatura_id);
  } catch (e) {
    const r = recusaDoProvedor(e);
    return fail(r.code, r.message, r.status, { requestId });
  }
  // O provedor já cancelou: o resto é nosso. Grava a marca direto (como o ramo
  // `cancelar_no_provedor` de sincronizar) e audita COM o ator antes de qualquer releitura.
  const { error: erroDaMarca } = await admin
    .from("cobranca_assinaturas")
    .update({ cancela_no_fim: true, updated_at: new Date().toISOString() })
    .eq("organization_id", orgId);
  if (erroDaMarca) logger.error("cobranca: cancelamento feito no provedor mas não gravado", { requestId, organizationId: orgId, codigo: erroDaMarca.code ?? null });
  void audit({
    action: "cobranca.assinatura_cancelada",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "cobranca_assinatura",
    resourceId: orgId,
    requestId,
    metadata: { motivo: "pedido_da_empresa" },
  });
  // Melhor esforço: a tela só quer a data; o webhook e o cron reconciliam o resto.
  await sincronizar(admin, orgId).catch((e: unknown) =>
    logger.error("cobranca: releitura depois de cancelar falhou", { requestId, organizationId: orgId, erro: e instanceof Error ? e.name : "desconhecido" }),
  );
  const depois = await lerLinha();
  const ate = (depois.data as { proximo_vencimento: string | null } | null)?.proximo_vencimento ?? linha.proximo_vencimento;
  return ok({ changed: true, acesso_ate: ate }, { requestId });
}
