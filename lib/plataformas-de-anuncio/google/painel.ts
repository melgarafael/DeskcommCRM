import { diaLocalISO } from "@/lib/agenda/fuso";
import { normalizarMetadadosGoogle, type MetadadosDaCampanhaGoogle } from "./metadados-da-campanha";

/** Uma linha representa um conjunto de negócios com as mesmas dimensões no dia local. */
export interface LinhaPainelGoogle {
  dia: string;
  conta: string | null;
  campanha: string | null;
  campanhaId: string | null;
  grupo: string | null;
  grupoId: string | null;
  anuncio: string | null;
  anuncioId: string | null;
  palavraChave: string | null;
  moeda: string | null;
  negocios: number;
  ganhos: number;
  perdidos: number;
  valorGanhoCentavos: number;
}

interface NegocioDoPainel extends Partial<Record<keyof MetadadosDaCampanhaGoogle, unknown>> {
  created_at: string;
  status: string;
  currency: string | null;
  value_cents: number | null;
}

/** O contato guarda o primeiro toque. Para esta coorte vale a origem do próprio negócio. */
export function acumularNegociosGoogle(
  linhas: Map<string, LinhaPainelGoogle>,
  negocios: readonly NegocioDoPainel[],
  fusoHorario: string,
  moedaDaOrg?: string | null,
): void {
  for (const negocio of negocios) {
    const meta = normalizarMetadadosGoogle(negocio);
    const dimensoes = {
      dia: diaLocalISO(new Date(negocio.created_at), fusoHorario),
      conta: meta.google_customer_id ?? null,
      campanha: meta.utm_campaign ?? null,
      campanhaId: meta.google_campaign_id ?? null,
      grupo: meta.utm_adset ?? null,
      grupoId: meta.google_adgroup_id ?? null,
      anuncio: meta.utm_ad ?? meta.utm_content ?? null,
      anuncioId: meta.google_ad_id ?? null,
      palavraChave: meta.utm_term ?? null,
      moeda: (negocio.currency?.trim() || moedaDaOrg?.trim())?.toUpperCase() ?? null,
    };
    const chave = JSON.stringify(dimensoes);
    let linha = linhas.get(chave);
    if (!linha) {
      linha = { ...dimensoes, negocios: 0, ganhos: 0, perdidos: 0, valorGanhoCentavos: 0 };
      linhas.set(chave, linha);
    }
    linha.negocios++;
    if (negocio.status === "won") {
      linha.ganhos++;
      linha.valorGanhoCentavos += Math.max(0, negocio.value_cents ?? 0);
    } else if (negocio.status === "lost") {
      linha.perdidos++;
    }
  }
}
