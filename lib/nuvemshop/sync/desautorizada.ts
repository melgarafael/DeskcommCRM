/**
 * A loja revogou o acesso (401/403). Três efeitos, e o laço que os desfaz:
 * integração em `error`, estado do sync em `error/auth` (a reconciliação pula),
 * e UM aviso aberto na Central. A reconexão (callback OAuth) resolve o aviso
 * e recomeça do cursor.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { PROVEDOR } from "./constantes";

export const KIND_INTEGRACAO_DESAUTORIZADA = "integracao_desautorizada" as const;

export async function marcarIntegracaoDesautorizada(
  admin: SupabaseClient,
  integ: { id: string; organizationId: string },
): Promise<void> {
  const { error: erroIntegracao } = await admin
    .from("tenant_integrations")
    .update({ status: "error", status_reason: "auth_revogada" })
    .eq("organization_id", integ.organizationId)
    .eq("id", integ.id);
  if (erroIntegracao) throw new Error(`desautorizar_integracao:${erroIntegracao.code ?? "erro"}`);
  const { error: erroEstado } = await admin
    .from("integration_sync_state")
    .update({ status: "error", ultimo_erro: "auth", run_id: null, trava_ate: null })
    .eq("organization_id", integ.organizationId)
    .eq("provider", PROVEDOR)
    .eq("resource", "orders");
  if (erroEstado) throw new Error(`desautorizar_estado:${erroEstado.code ?? "erro"}`);
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: integ.organizationId,
    kind: KIND_INTEGRACAO_DESAUTORIZADA,
    severity: "warn",
    title: "A Nuvemshop parou de enviar pedidos",
    body: "A loja revogou o acesso do aplicativo. Em Integrações › Nuvemshop, desconecte e conecte de novo para voltar a sincronizar.",
    ref_kind: "tenant_integration",
    ref_id: integ.id,
  });
  if (error && error.code !== "23505") {
    logger.warn("[nuvemshop.sync] aviso de desautorização não aberto", { code: error.code });
  }
  if (!error) {
    await audit({
      action: "nuvemshop.sync_failed",
      organizationId: integ.organizationId,
      resourceType: "tenant_integration",
      resourceId: integ.id,
      metadata: { motivo: "auth" },
    });
  }
}

export async function resolverAvisoDeDesautorizacao(admin: SupabaseClient, orgId: string, integracaoId: string): Promise<void> {
  await admin
    .from("agent_inbox_items")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("kind", KIND_INTEGRACAO_DESAUTORIZADA)
    .eq("ref_id", integracaoId)
    .eq("status", "open");
}
