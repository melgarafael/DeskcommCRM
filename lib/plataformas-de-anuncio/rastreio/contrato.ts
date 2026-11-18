import { z } from "zod";
import { normalizarUtm } from "@/lib/leads/origem-do-site";
import { textoSemRef } from "../texto-do-ref";

export const linkSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(100),
  whatsapp_e164: z
    .string()
    .trim()
    .regex(/^\+[1-9][0-9]{7,14}$/),
  message_template: z.string().trim().min(1).max(900),
  use_case: z.enum(["site", "anuncio", "organico"]),
  utm: z.record(z.string(), z.string().max(200)).refine((v) => Object.keys(v).length <= 10),
  enabled: z.boolean(),
});
export type LinkInput = z.infer<typeof linkSchema>;
export type LinkRastreavel = LinkInput & { id: string; organization_id: string };
export type MetricasLink = { link_id: string; clicks: number; contacts: number; leads: number };

export function mensagemComRef(texto: string): string {
  return `${textoSemRef(texto)
    .replace(/\[ref:[^\]]*\]/g, "")
    .trim()} [ref:{token}]`;
}
export function utmsDoLink(
  link: Pick<LinkRastreavel, "utm" | "use_case" | "name">,
  search: URLSearchParams,
) {
  const utm = normalizarUtm({ ...link.utm, ...Object.fromEntries(search.entries()) });
  for (const [k, v] of Object.entries(utm)) if (/[{}<>]/.test(v)) delete utm[k];
  return {
    utm_source: link.use_case === "organico" ? "organico" : "site",
    utm_campaign: link.name,
    ...utm,
  };
}
// Auto-tagging preserva gclid/gbraid/wbraid; não inventamos macros sem suporte do Google.
export const SUFIXO_GOOGLE =
  "utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={creative}&utm_term={keyword}&google_campaign_id={campaignid}&google_adgroup_id={adgroupid}&google_ad_id={creative}";
export const MODELO_GOOGLE = `{lpurl}?${SUFIXO_GOOGLE}`;
