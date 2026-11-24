import { z } from "zod";
import {
  CHAVES_DE_METADADOS_DA_CAMPANHA,
  type AtribuicaoDeAnuncio,
} from "@/lib/leads/atribuicao-de-anuncio";

export type MetadadosDaCampanhaGoogle = NonNullable<AtribuicaoDeAnuncio["metadadosDaCampanha"]>;

export const CHAVES_DE_METADADOS_GOOGLE = CHAVES_DE_METADADOS_DA_CAMPANHA;

// Só parâmetros EXPLICITAMENTE destinados a IDs. Uma UTM numérica continua
// sendo rótulo; gclid/gbraid/wbraid identificam o clique, nunca a conta.
const ALIASES_DE_ID = {
  google_campaign_id: ["google_campaign_id", "campaignid", "campaign_id"],
  google_adgroup_id: ["google_adgroup_id", "adgroupid", "adgroup_id"],
  google_ad_id: ["google_ad_id", "creative", "ad_id"],
  google_customer_id: ["google_customer_id", "customerid", "customer_id"],
} as const;

export const CHAVES_DE_CAPTURA_GOOGLE = [
  ...CHAVES_DE_METADADOS_GOOGLE,
  ...Object.values(ALIASES_DE_ID).flat(),
] as const;

const rotulo = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => !/[{}<>\u0000-\u001f\u007f]/.test(v))
  .refine(
    (v) =>
      !/(?:[a-z][a-z0-9+.-]*:\/\/|https?:|javascript:|data:|file:|mailto:|tel:|about:|www\.)/i.test(
        v,
      ),
  );
const id = z
  .string()
  .trim()
  .regex(/^[0-9]{1,30}$/);
export const idDaContaGoogle = z
  .string()
  .trim()
  .regex(/^(?:[0-9]{10}|[0-9]{3}-[0-9]{3}-[0-9]{4})$/)
  .transform((v) => v.replaceAll("-", ""));

/** Mesma lista no clique, na leitura do recibo e na estampa; nunca espalha query_raw. */
export function normalizarMetadadosGoogle(carga: unknown): MetadadosDaCampanhaGoogle {
  if (!carga || typeof carga !== "object" || Array.isArray(carga)) return {};
  const entrada = Object.fromEntries(
    Object.entries(carga).map(([k, v]) => [k.trim().toLowerCase(), v]),
  );
  // A forma canônica ganha de variações de caixa vindas de importação,
  // inclusive quando contém null para limpar uma origem parcial anterior.
  for (const chave of CHAVES_DE_CAPTURA_GOOGLE) {
    if (Object.hasOwn(carga, chave)) entrada[chave] = (carga as Record<string, unknown>)[chave];
  }
  const resultado: MetadadosDaCampanhaGoogle = {};
  for (const chave of CHAVES_DE_METADADOS_GOOGLE) {
    if (!chave.startsWith("utm_")) continue;
    const lido = rotulo.safeParse(entrada[chave]);
    if (lido.success) resultado[chave] = lido.data;
  }
  for (const [chave, aliases] of Object.entries(ALIASES_DE_ID)) {
    // Campo canônico presente é definitivo: null/valor inválido não pode
    // ressuscitar um alias antigo que o merge do cadastro preservou.
    const candidatos = Object.hasOwn(entrada, chave) ? [chave] : aliases;
    for (const alias of candidatos) {
      const lido = (chave === "google_customer_id" ? idDaContaGoogle : id).safeParse(
        entrada[alias],
      );
      if (!lido.success) continue;
      resultado[chave as keyof typeof ALIASES_DE_ID] = lido.data;
      break;
    }
  }
  return resultado;
}
