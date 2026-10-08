/**
 * `nuvemshop-desinstalacao.v1` — a loja desinstalou o app. Escrita interna
 * (`roda` em org parada): a integração vira `disconnected` e o run em curso é
 * liberado; o próximo evento de página encontra a integração inativa e para.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { createAdminClient } from "@/lib/supabase/admin";
import { PROVEDOR } from "./constantes";

const KEY = "nuvemshop-desinstalacao.v1";

export async function processarDesinstalacao(row: EventRow, admin: SupabaseClient): Promise<HandlerResult> {
  const { data, error } = await admin
    .from("tenant_integrations")
    .update({ status: "disconnected", status_reason: "app_uninstalled" })
    .eq("organization_id", row.organization_id)
    .eq("provider", PROVEDOR)
    .select("id")
    .maybeSingle();
  if (error) return { consumer_key: KEY, status: "error", detail: `integracao:${error.message}` };

  await admin
    .from("integration_sync_state")
    .update({ status: "idle", run_id: null, trava_ate: null })
    .eq("organization_id", row.organization_id)
    .eq("provider", PROVEDOR)
    .eq("resource", "orders");

  await audit({
    action: "nuvemshop.uninstalled",
    organizationId: row.organization_id,
    resourceType: "tenant_integration",
    resourceId: (data as { id?: string } | null)?.id,
    metadata: { store_id: String(row.payload.store_id ?? "") },
  });
  return { consumer_key: KEY, status: "ok", detail: "desconectada" };
}

export const nuvemshopDesinstalacaoHandler: EventHandler = {
  key: KEY,
  naOrgParada: "roda",
  events: ["nuvemshop.app_uninstalled"],
  handle: (row) => processarDesinstalacao(row, createAdminClient()),
};
