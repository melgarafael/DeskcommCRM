/**
 * Parsing do inbound de captação: field_map → lead normalizado + HMAC.
 * Sem I/O — puro, testável. A rota (webhooks/in/[token]) faz o resto.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { normalizePhoneBR } from "@/lib/channels/phone-variants";
import type {
  AtribuicaoDeAnuncio,
  PlataformaDeAnuncio,
} from "@/lib/leads/atribuicao-de-anuncio";

export interface FieldMap {
  name?: string[];
  phone?: string[];
  email?: string[];
}

const DEFAULT_FIELD_MAP: Required<FieldMap> = {
  name: ["name", "nome", "full_name", "fullname"],
  phone: ["phone", "telefone", "whatsapp", "celular", "phone_number", "tel"],
  email: ["email", "e-mail", "mail"],
};

/**
 * Chaves que a PLATAFORMA do formulário põe no envio e que não são resposta de
 * ninguém. O JetFormBuilder manda `__refer`, `__form_id` e `__is_ajax` junto com
 * os campos do formulário (medido num envio real, 2026-09-30); o WordPress
 * acrescenta nonce e referer. Entrando em `custom_fields`, apareciam no card do
 * lead como se a pessoa as tivesse preenchido.
 *
 * Lista NOMEADA, e não "tudo que começa com `_`": um formulário próprio pode ter
 * um campo legítimo chamado `_origem`, e descartá-lo em silêncio seria perder
 * dado de cliente. Só cai o que é conhecidamente da plataforma.
 */
export const CHAVES_DE_PLATAFORMA = new Set([
  "__refer",
  "__form_id",
  "__is_ajax",
  "__queried_post_id",
  "_wpnonce",
  "_wp_http_referer",
  "_jet_engine_refer",
  "_jet_engine_booking_form_id",
  "jfb_preview_nonce",
  "_jfb_current_render_states",
  "_jfb_current_render_states[]",
]);

/**
 * As chaves com que uma PLATAFORMA DE ANÚNCIO marca o clique que trouxe a pessoa
 * (issue #2317).
 *
 * Quem anuncia para uma landing page com FORMULÁRIO manda `fbclid`, `fbc`,
 * `fbp`, `gclid`, `ad_id`, `adset_id` e `campaign_id` no envio. Até aqui elas
 * caíam em `custom_fields` — apareciam no card do lead como se a pessoa as
 * tivesse preenchido — e a origem do anúncio se perdia: `lib/conversoes`, que lê
 * a atribuição do contato, não sabia de que clique veio uma venda de formulário.
 *
 * RESERVADAS, e por isso seguem o MESMO caminho do `utm_*`: vão para
 * `source_metadata`, de onde a atribuição do contato é estampada
 * (`extrairAtribuicaoDoInbound`) com a guarda de primeiro toque que o
 * clique-pro-WhatsApp já usa.
 *
 * Lista NOMEADA e FECHADA, como `CHAVES_DE_PLATAFORMA`: um formulário próprio
 * pode ter um campo legítimo chamado `campaign` ou `origem`, e não é trabalho
 * deste módulo adivinhar. Só o que é conhecidamente identificador de anúncio cai
 * aqui. Os identificadores só-iOS (`gbraid`/`wbraid`) ficam de fora enquanto um
 * formulário real não os mandar.
 */
export const CHAVES_DE_ANUNCIO = new Set([
  "fbclid",
  "fbc",
  "fbp",
  "gclid",
  "ad_id",
  "adset_id",
  "campaign_id",
]);

export interface MappedLead {
  name: string | null;
  phone: string | null;
  email: string | null;
  custom_fields: Record<string, string>;
  source_metadata: Record<string, string>;
}

// A regra mora em `lib/channels/phone-variants.ts`, que o componente de cliente
// também importa (este módulo carrega `node:crypto`).
export { normalizePhoneBR };

function firstMatch(payload: Record<string, unknown>, aliases: string[]): { key: string; value: string } | null {
  const lowered = new Map(Object.keys(payload).map((k) => [k.toLowerCase(), k]));
  for (const alias of aliases) {
    const key = lowered.get(alias.toLowerCase());
    if (key !== undefined) {
      const v = payload[key];
      if (typeof v === "string" && v.trim()) return { key, value: v.trim() };
    }
  }
  return null;
}

export function mapInboundPayload(
  payload: Record<string, unknown>,
  fieldMap: FieldMap = {},
): MappedLead {
  const map: Required<FieldMap> = {
    name: [...(fieldMap.name ?? []), ...DEFAULT_FIELD_MAP.name],
    phone: [...(fieldMap.phone ?? []), ...DEFAULT_FIELD_MAP.phone],
    email: [...(fieldMap.email ?? []), ...DEFAULT_FIELD_MAP.email],
  };

  const nameHit = firstMatch(payload, map.name);
  const phoneHit = firstMatch(payload, map.phone);
  const emailHit = firstMatch(payload, map.email);
  const consumed = new Set([nameHit?.key, phoneHit?.key, emailHit?.key].filter(Boolean));

  const custom_fields: Record<string, string> = {};
  const source_metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (consumed.has(key) || CHAVES_DE_PLATAFORMA.has(key)) continue;
    const str =
      typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
    if (str === null) continue; // objetos/arrays aninhados: descartados no v1
    const chave = key.toLowerCase();
    // As chaves de CAMPANHA — `utm_*` e as de anúncio reservadas — descrevem como
    // a pessoa CHEGOU, não o que ela respondeu: vão para `source_metadata`, onde
    // viram a atribuição do contato, e não aparecem no card como campo
    // preenchido. `CHAVES_DE_ANUNCIO` é a lista da issue #2317.
    if (chave.startsWith("utm_") || CHAVES_DE_ANUNCIO.has(chave)) source_metadata[chave] = str;
    else custom_fields[key] = str;
  }

  return {
    name: nameHit?.value ?? null,
    phone: normalizePhoneBR(phoneHit?.value),
    email: emailHit?.value ?? null,
    custom_fields,
    source_metadata,
  };
}

/**
 * `fb.1.<instante em ms>.<clique>` — o `fbc` que o pixel da Meta escreve no
 * navegador quando o anúncio levou a uma página.
 *
 * Existe porque um formulário pode mandar SÓ o `fbclid` (página sem pixel, ou
 * pixel que não subiu): sem remontar o `fbc`, esse lead não teria identidade de
 * navegador nenhuma para a venda ser casada. O instante é o da CAPTURA aqui
 * (o envio do formulário), não o do clique original — o `fbclid` não carrega a
 * hora, e inventar uma data antiga não melhoraria a atribuição. O valor cru do
 * `fbclid` segue em `bruto`, que é a prova.
 */
export function fbcAPartirDoFbclid(fbclid: string, capturadoEmMs: number): string {
  return `fb.1.${capturadoEmMs}.${fbclid}`;
}

/**
 * A atribuição de anúncio do webhook de entrada (issue #2317) — a MESMA gravação
 * do clique-pro-WhatsApp, a partir de outro transporte: o formulário.
 *
 * O payload traz o CLIQUE (`fbclid`/`fbc` da Meta, `gclid` do Google) e, quando
 * o formulário é montado para isso, os ids da peça (`ad_id`, `adset_id`,
 * `campaign_id`). Devolve o formato AGNÓSTICO que `estamparAtribuicaoDoContato`
 * grava — a guarda de primeiro toque fica no banco, e NÃO há uma segunda cópia
 * dela aqui.
 *
 * A plataforma é decidida pelo clique presente: `fbclid`/`fbc` → Meta, `gclid` →
 * Google. Um payload com os dois é ambíguo — uma landing page que recebe as duas
 * redes — e a precedência é a do título da issue: Meta antes de Google.
 * Declarada, e não deixada à ordem das chaves no objeto.
 *
 * Sem identificador de CLIQUE não há atribuição: `ad_id` sozinho não diz de qual
 * rede o clique veio, e escolher uma seria inventar a conta que recebe a
 * conversão. As chaves seguem em `source_metadata`/`ad_raw` de qualquer forma —
 * é a prova de onde o dado saiu, não um dado descartado.
 *
 * Não há `ctwa_clid` aqui: este caminho é de FORMULÁRIO, não de clique-pro-WhatsApp.
 */
export function extrairAtribuicaoDoInbound(
  payload: Record<string, unknown>,
): AtribuicaoDeAnuncio | null {
  const chaves: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    const k = key.toLowerCase();
    if (!CHAVES_DE_ANUNCIO.has(k)) continue;
    const v =
      typeof value === "string"
        ? value.trim()
        : typeof value === "number"
          ? String(value)
          : "";
    if (v !== "") chaves[k] = v;
  }

  const fbclid = chaves.fbclid ?? null;
  const fbc = chaves.fbc ?? null;
  const gclid = chaves.gclid ?? null;
  const plataforma: PlataformaDeAnuncio | null =
    fbclid || fbc ? "meta_ads" : gclid ? "google_ads" : null;
  if (!plataforma) return null;

  const sourceId = plataforma === "meta_ads" ? (fbclid ?? fbc) : gclid;
  if (!sourceId) return null;

  return {
    plataforma,
    sourceId,
    adId: chaves.ad_id ?? null,
    titulo: null,
    corpo: null,
    sourceUrl: null,
    // ─── O clique de FORMULÁRIO não é `ctwa_clid` (#2317) ────────────────────
    //
    // Na Meta, a identidade de quem chegou por PÁGINA é o par `fbc`/`fbp` (o
    // cookie que o pixel escreveu), não o `ctwa_clid` do anúncio
    // clique-pro-WhatsApp. Quando o formulário manda só o `fbclid`, o `fbc` é
    // remontado: sem ele a venda de formulário não tem NENHUMA identidade de
    // navegador para a plataforma casar, e mandar o `fbclid` cru no lugar do
    // `ctwa_clid` é o defeito que este campo existe para não repetir.
    ...(plataforma === "meta_ads"
      ? {
          identidadeDoNavegador: {
            fbc: fbc ?? (fbclid ? fbcAPartirDoFbclid(fbclid, Date.now()) : null),
            fbp: chaves.fbp ?? null,
          },
        }
      : {}),
    bruto: chaves,
  };
}

/** HMAC SHA-256 hex do raw body. Header: X-Deskcomm-Signature. */
export function verifyInboundSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
