import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { fusoUtilizavel } from "@/lib/tempo/fusos";
import { acumularNegociosGoogle, type LinhaPainelGoogle } from "./painel";

// Só as dimensões públicas atravessam a consulta. O restante dos metadados pode conter identificadores de clique.
const COLUNAS = "id,created_at,status,currency,value_cents,google_customer_id:source_metadata->>google_customer_id,utm_campaign:source_metadata->>utm_campaign,google_campaign_id:source_metadata->>google_campaign_id,utm_adset:source_metadata->>utm_adset,google_adgroup_id:source_metadata->>google_adgroup_id,utm_ad:source_metadata->>utm_ad,utm_content:source_metadata->>utm_content,google_ad_id:source_metadata->>google_ad_id,utm_term:source_metadata->>utm_term";

export async function lerPainelGoogle(
  db: SupabaseClient<Database>,
  organizationId: string,
  desde: string,
  ateExclusivo: string,
  fusoHorario: string,
  moedaDaOrg?: string | null,
): Promise<LinhaPainelGoogle[]> {
  const linhas = new Map<string, LinhaPainelGoogle>();
  const fuso = fusoUtilizavel(fusoHorario);
  let ultimoId: string | undefined;
  for (;;) {
    let consulta = db.from("crm_leads").select(COLUNAS)
      .eq("organization_id", organizationId)
      .or("source_metadata->>ad_platform.eq.google_ads,and(source.eq.google_ads,source_metadata->>ad_platform.is.null)")
      .gte("created_at", desde).lt("created_at", ateExclusivo)
      .order("id", { ascending: true }).limit(500);
    if (ultimoId) consulta = consulta.gt("id", ultimoId);
    const { data, error } = await consulta;
    if (error) throw new Error("Falha ao consultar os negócios do Google Ads", { cause: error });
    if (!data?.length) return Array.from(linhas.values());
    acumularNegociosGoogle(linhas, data, fuso, moedaDaOrg);
    // Um servidor self-host pode limitar o número de linhas abaixo de 500.
    ultimoId = data[data.length - 1]!.id;
  }
}
