/**
 * Enriquecimento de empresa via BrasilAPI — não bloqueia o INSERT.
 * Atualiza enrichment_status e brasilapi_raw; pronto para retry.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createBrasilApiClient,
  mapBrasilApiToCompanyFields,
} from "@/lib/brasil-api/client";
import { formatCnpj, normalizeCnpj } from "@/lib/crm-b2b/normalize";
import { logger } from "@/lib/logger";

type SB = SupabaseClient;

/**
 * A resposta da BrasilAPI traz o quadro de sócios (`qsa`): nome e parte do CPF
 * de gente que não é cliente de ninguém aqui. Nenhuma tela usa, e guardar seria
 * dado pessoal sem finalidade nem caminho de anonimização — sai antes de gravar.
 */
function semSocios(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { qsa: _qsa, ...resto } = raw as Record<string, unknown>;
  return resto;
}

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
        // Uma falha de enriquecimento NÃO pode trocar o CNPJ formatado pelo
        // valor sem máscara (relato #1937: `33547054000120` no lugar de
        // `33.547.054/0001-20`). O dígito fica em normalized_cnpj.
        cnpj: formatCnpj(normalized),
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
      cnpj: formatCnpj(normalized),
      enrichment_status: "completed",
      enrichment_error: null,
      enriched_at: new Date().toISOString(),
      brasilapi_raw: semSocios(result.raw),
    })
    .eq("organization_id", organizationId)
    .eq("id", companyId);

  if (updErr) {
    return { status: "failed", error: updErr.message };
  }
  return { status: "completed" };
}
