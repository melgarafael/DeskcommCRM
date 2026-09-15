/**
 * A ORIGEM DA PÁGINA, QUANDO A PESSOA CHEGA PELO WHATSAPP.
 *
 * ─── O buraco que este arquivo tapa ─────────────────────────────────────────
 *
 * A atribuição de anúncio grava a plataforma de mídia e o id do anúncio a partir
 * do contexto que o canal entrega (o `referral` do clique no anúncio). Uma
 * landing page NÃO tem esse transporte: o link `wa.me/<numero>?text=...` abre o
 * WhatsApp pelo sistema operacional — sem cookie, sem referrer, sem sessão. As
 * UTMs morriam na página e a origem de site virava nada.
 *
 * O único fio que atravessa essa fronteira é o TEXTO da primeira mensagem. A
 * página embute nele um código curto; a ingestão o reconhece aqui.
 *
 * ─── Contrato (a página depende disto para o link funcionar) ────────────────
 *
 *   [dk1:<base64url(JSON)>]      JSON = só as chaves da lista de CHAVES_DE_UTM
 *
 * O marcador é VISÍVEL no texto pré-preenchido — é a opção que a própria issue
 * chama de "mais simples e auditável", e a escolha é revisável: o dia em que o
 * código precisa ficar oculto, muda o transporte, não este contrato.
 *
 * ─── Entrada NÃO CONFIÁVEL, e o que isso significa aqui ─────────────────────
 *
 * O texto do cliente é controlado por quem escreve: dá para digitar, copiar,
 * encaminhar, editar ou repetir o marcador de outra pessoa. Então:
 *
 *   1. nada disso AUTORIZA coisa alguma — é rótulo de origem, não permissão;
 *   2. o valor é limitado (lista fechada de chaves, tamanho máximo) e normalizado;
 *   3. NÃO sobrescreve o primeiro toque: quem decide isso é a
 *      `fn_estampar_atribuicao_de_anuncio`, no banco, com a mesma guarda que já
 *      vale para anúncio pago. Aqui não há regra de atribuição paralela.
 *   4. marcador ilegível é ignorado em silêncio, e a ingestão segue. A mensagem
 *      do cliente JÁ está gravada quando este código roda.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** Versão do formato. O parser ignora qualquer outra, em vez de chutar. */
export const VERSAO_DO_CODIGO = "dk1";

/**
 * As chaves aceitas, e nada mais.
 *
 * Lista FECHADA de propósito: o marcador vem do texto do cliente, e um mapa
 * aberto viraria um depósito de qualquer coisa que alguém colar ali dentro —
 * com o agravante de que isso é lido meses depois como se fosse atribuição.
 */
export const CHAVES_DE_UTM = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
] as const;

/** Teto por valor. Nada legítimo chega perto disso; colagem aleatória chega. */
const TAMANHO_MAXIMO_DO_VALOR = 200;

export interface OrigemDaPagina {
  /** Só chaves de `CHAVES_DE_UTM`, já normalizadas, e nunca vazio. */
  utm: Record<string, string>;
  /**
   * Quando o marcador foi lido — do relógio de quem INGERE, não da página.
   *
   * A página não tem como provar quando gerou o código, e um campo de tempo
   * vindo do texto seria mais um valor que o cliente escolhe. `null` quando o
   * chamador não tem relógio à mão (o banco carimba o `updated_at` de qualquer
   * forma).
   */
  capturadaEm: string | null;
}

const RE_DO_CODIGO = /\[dk1:([A-Za-z0-9_-]{1,2000})\]/;

/** Normaliza `{"  UTM_SOURCE  ": " ig "}` → `{ utm_source: "ig" }`. */
function normalizar(carga: unknown): Record<string, string> {
  if (!carga || typeof carga !== "object" || Array.isArray(carga)) return {};
  const utm: Record<string, string> = {};
  for (const [bruta, valor] of Object.entries(carga as Record<string, unknown>)) {
    const chave = bruta.trim().toLowerCase();
    if (!(CHAVES_DE_UTM as readonly string[]).includes(chave)) continue;
    if (typeof valor !== "string") continue;
    const limpo = valor.trim().slice(0, TAMANHO_MAXIMO_DO_VALOR);
    if (limpo === "") continue;
    utm[chave] = limpo;
  }
  return utm;
}

/**
 * O código que a página embute no `?text=` do `wa.me`.
 *
 * Chaves ordenadas para o mesmo mapa render sempre o mesmo código — duas UTMs
 * iguais em ordem diferente não são duas origens. Devolve `null` quando não
 * sobra nada válido: não faz sentido gerar um marcador que o parser recusa.
 */
export function montarCodigoDeOrigemDoSite(utm: Record<string, string>): string | null {
  const normalizado = normalizar(utm);
  if (Object.keys(normalizado).length === 0) return null;
  const ordenado: Record<string, string> = {};
  for (const chave of [...Object.keys(normalizado)].sort()) ordenado[chave] = normalizado[chave]!;
  const carga = Buffer.from(JSON.stringify(ordenado), "utf8").toString("base64url");
  return `[dk${VERSAO_DO_CODIGO.slice(2)}:${carga}]`;
}

/**
 * Procura o código no texto e devolve a origem — ou `null`.
 *
 * Nunca lança. Este caminho roda no meio da ingestão, depois de a mensagem do
 * cliente já estar gravada: uma exceção aqui viraria erro para o provider, e
 * ele reenviaria a mensagem — trocaríamos um rótulo de origem faltando por uma
 * tempestade de reentregas.
 */
export function extrairOrigemDaPagina(texto: string | null | undefined): OrigemDaPagina | null {
  if (!texto) return null;
  const achado = RE_DO_CODIGO.exec(texto);
  if (!achado?.[1]) return null;
  try {
    const json = Buffer.from(achado[1], "base64url").toString("utf8");
    const utm = normalizar(JSON.parse(json));
    if (Object.keys(utm).length === 0) return null;
    return { utm, capturadaEm: null };
  } catch {
    // Marcador truncado, carga que não é JSON, base64 que não decodifica:
    // tudo isso é "não há origem nesta mensagem", e não um erro.
    return null;
  }
}

/**
 * Grava a origem da página no contato, pela função que já existe.
 *
 * ─── Por que passar pela `fn_estampar_atribuicao_de_anuncio` ────────────────
 *
 * Porque a regra de PRIMEIRO TOQUE já está implementada lá, e uma segunda
 * implementação desta regra, escrita aqui, divergiria dela — que é exatamente o
 * modo de falhar que custa caro neste domínio (o valor "correto" muda de card
 * para card sem ninguém notar).
 *
 * `ad_platform: "site"` é o que a função usa como marca de "já tem
 * atribuição": quem chegou de anúncio pago primeiro mantém o anúncio pago, e
 * quem chegou do site primeiro mantém o site. `ad_source_id` fica nulo de
 * propósito — origem de site não é anúncio, e não deve virar conversão.
 *
 * `utm_*` vão achatados no metadata junto do resto: é o formato que a leitura
 * de conversões e a ficha do contato já consomem.
 */
export async function estamparOrigemDaPagina(
  admin: Admin,
  contactId: string,
  origem: OrigemDaPagina,
): Promise<boolean> {
  const { error } = await admin.rpc("fn_estampar_atribuicao_de_anuncio", {
    p_contact: contactId,
    p_platform: "site",
    p_metadata: {
      ad_platform: "site",
      ad_source_id: null,
      origem: "site",
      origem_capturada_em: origem.capturadaEm,
      ...origem.utm,
    },
  });
  return !error;
}
