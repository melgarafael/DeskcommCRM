import { logger } from "@/lib/logger";
import { mensagemComRef, utmsDoLink, type LinkRastreavel, type MetricasLink } from "./contrato";
export type { LinkRastreavel } from "./contrato";
import type { SupabaseClient } from "@supabase/supabase-js";
import { criarClickRef } from "../captura-de-clique";
import { lerIdentificadoresGoogle } from "../google/identificadores";
import { normalizarMetadadosGoogle } from "../google/metadados-da-campanha";
import { textoSemRef, whatsAppUrl } from "../pagina-de-captura";

export async function listarLinks(admin: SupabaseClient, org: string): Promise<LinkRastreavel[]> {
  const { data, error } = await admin
    .from("ad_tracking_links")
    .select("id,organization_id,name,whatsapp_e164,message_template,use_case,utm,enabled")
    .eq("organization_id", org)
    .order("created_at", { ascending: false });
  if (error) throw new Error("Não foi possível ler os links.");
  return (data ?? []) as LinkRastreavel[];
}
export async function metricasLinks(admin: SupabaseClient, org: string): Promise<MetricasLink[]> {
  const { data, error } = await admin.rpc("fn_metricas_links_rastreaveis", { p_org: org });
  if (error) throw new Error("Não foi possível ler as métricas dos links.");
  return (data ?? []) as MetricasLink[];
}
/** Falha da gravação perde atribuição, mas preserva o acesso ao atendimento. */
export async function destinoDoLink(
  admin: SupabaseClient,
  link: LinkRastreavel,
  search: URLSearchParams,
): Promise<string> {
  const ids = lerIdentificadoresGoogle(Object.fromEntries(search.entries()));
  const utm = utmsDoLink(link, search);
  const campos = ids
    ? {
        gclid: ids.gclid ?? null,
        gbraid: ids.gbraid ?? null,
        wbraid: ids.wbraid ?? null,
        query_raw: {
          // O nome do link é rótulo do CRM, não nome comprovado da campanha.
          // Para Google, só parâmetros explícitos atravessam ao contato/card.
          ...normalizarMetadadosGoogle({ ...link.utm, ...Object.fromEntries(search.entries()) }),
          ...ids,
        },
      }
    : { utm, query_raw: utm };
  let ref = null;
  try {
    ref = await criarClickRef(
      admin,
      ids ? "google_ads_click_refs" : "meta_ads_click_refs",
      link.organization_id,
      { ...campos, tracking_link_id: link.id },
    );
  } catch {
    logger.error("[rastreio] captura indisponível", {
      organizationId: link.organization_id,
      linkId: link.id,
    });
  }
  return whatsAppUrl(
    link.whatsapp_e164,
    ref
      ? mensagemComRef(link.message_template).replaceAll("{token}", ref.token)
      : textoSemRef(mensagemComRef(link.message_template)),
  );
}
