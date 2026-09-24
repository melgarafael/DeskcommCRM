/**
 * Enriquecimento de empresa via BrasilAPI — não bloqueia o INSERT.
 * Atualiza enrichment_status e brasilapi_raw; pronto para retry.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createBrasilApiClient,
  mapBrasilApiToCompanyFields,
} from "@/lib/brasil-api/client";
import { normalizeCnpj } from "@/lib/crm-b2b/normalize";
import { logger } from "@/lib/logger";

type SB = SupabaseClient;

export async function enrichCompanyFromBrasilApi(
  supabase: SB,
  opts: { organizationId: string; companyId: string; cnpj?: string | null },
): Promise<{ status: "completed" | "failed" | "skipped"; error?: string }> {
  const { organizationId, companyId } = opts;

  const { data: row, error: loadErr } = await supabase
    .from("companies")
    .select("id, cnpj, normalized_cnpj, enrichment_status")
    .eq("organization_id", organizationId)
    .eq("id", companyId)
    .maybeSingle();

  if (loadErr || !row) {
    return { status: "failed", error: loadErr?.message ?? "empresa não encontrada" };
  }

  const normalized = normalizeCnpj(opts.cnpj ?? row.normalized_cnpj ?? row.cnpj);
  if (!normalized) {
    await supabase
      .from("companies")
      .update({
        enrichment_status: "failed",
        enrichment_error: "CNPJ inválido para enriquecimento",
        enriched_at: new Date().toISOString(),
      })
      .eq("organization_id", organizationId)
      .eq("id", companyId);
    return { status: "failed", error: "CNPJ inválido" };
  }

  await supabase
    .from("companies")
    .update({ enrichment_status: "processing", enrichment_error: null })
    .eq("organization_id", organizationId)
    .eq("id", companyId);

  const client = createBrasilApiClient();
  const result = await client.lookupCnpj(normalized);

  if (!result.ok) {
    await supabase
      .from("companies")
      .update({
        enrichment_status: "failed",
        enrichment_error: `${result.code}: ${result.message}`,
        enriched_at: new Date().toISOString(),
        normalized_cnpj: normalized,
        cnpj: normalized,
      })
      .eq("organization_id", organizationId)
      .eq("id", companyId);
    logger.warn("companies.enrich_failed", {
      organization_id: organizationId,
      company_id: companyId,
      code: result.code,
    });
    return { status: "failed", error: result.message };
  }

  const fields = mapBrasilApiToCompanyFields(result.data);
  const { error: updErr } = await supabase
    .from("companies")
    .update({
      ...fields,
      normalized_cnpj: normalized,
      cnpj: normalized,
      enrichment_status: "completed",
      enrichment_error: null,
      enriched_at: new Date().toISOString(),
      brasilapi_raw: result.raw as Record<string, unknown>,
    })
    .eq("organization_id", organizationId)
    .eq("id", companyId);

  if (updErr) {
    return { status: "failed", error: updErr.message };
  }
  return { status: "completed" };
}
