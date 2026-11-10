/**
 * A PROVA DE ORIGEM DO AVISO DE PAGAMENTO — o segredo de CADA recebimento (issue #3509).
 *
 * ─── Por que esta função existe ─────────────────────────────────────────────
 *
 * A rota que recebe "pago" é pública (webhook não tem sessão): qualquer pessoa
 * na internet a alcança com um POST. Sem conferir quem falou, um aviso forjado
 * marcaria um recebimento como pago e moveria o negócio de etapa.
 *
 * ─── O que a InfinitePay deixa ter (medido em 31/10 e 03/11/2026) ───────────
 *
 * O aviso dela NÃO vem assinado: nenhum cabeçalho nem campo do corpo traz
 * assinatura, HMAC ou token. O que volta, em todo aviso e nos dois tipos de
 * link (painel e API), é a URL que nós configuramos, com os parâmetros que
 * pusemos nela — em ordem que muda, então eles são lidos por NOME. Por isso o
 * segredo viaja na URL (`?t=`), e é o modo mais fraco que existe: quem tiver a
 * URL pode forjar um `paid`. O que segura o dano:
 *
 * - o segredo é DESTE recebimento, não da instalação nem da empresa: a URL de
 *   um pagamento não abre o de mais ninguém;
 * - só o hash fica no banco; o texto é mostrado uma vez, no registro;
 * - o valor do aviso tem de bater com o registrado (`lib/pagamentos/confirmar.ts`);
 * - a confirmação é compare-and-set e auditada.
 *
 * Um provedor que mande o segredo em cabeçalho (`X-Webhook-Token`) usa o mesmo
 * segredo. ⚠️ FAIL CLOSED: cabeçalho presente e errado NÃO cai para a URL —
 * seria deixar quem errou escolher o caminho.
 *
 * Nada aqui loga, nada aqui lança: o segredo não vai para log nem para Sentry.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { urlPublicaUsavel } from "@/lib/escalacao/url-publica";

export const CABECALHO_DO_TOKEN = "x-webhook-token";
/** O parâmetro de query que leva o segredo. Lido por NOME: a ordem muda no aviso. */
export const PARAMETRO_DO_TOKEN_NA_URL = "t";
/** O parâmetro de query que leva o id do recebimento. */
export const PARAMETRO_DO_RECEBIMENTO_NA_URL = "r";

export type VereditoDaOrigem =
  | { ok: true; modo: "token" | "url_token" }
  | { ok: false; motivo: "sem_token" | "token_invalido" };

/** sha256 hex do segredo — a forma que o banco guarda (CHECK da 9312). */
export function hashDoToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Um segredo novo para um recebimento: 32 bytes aleatórios, e o hash que vai para o banco. */
export function novoTokenDoAviso(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashDoToken(token) };
}

export function verificarOrigem(
  headers: Headers,
  tokenNaUrl: string | null,
  hashGuardado: string,
): VereditoDaOrigem {
  const cabecalho = headers.get(CABECALHO_DO_TOKEN);
  if (cabecalho !== null) return comparar(cabecalho, hashGuardado, "token");
  if (tokenNaUrl !== null) return comparar(tokenNaUrl, hashGuardado, "url_token");
  return { ok: false, motivo: "sem_token" };
}

function comparar(recebido: string, hashGuardado: string, modo: "token" | "url_token"): VereditoDaOrigem {
  // Os dois lados viram 32 bytes: `timingSafeEqual` exige o mesmo tamanho, e
  // hash guardado fora da forma é recusa, nunca exceção.
  if (!/^[0-9a-f]{64}$/.test(hashGuardado)) return { ok: false, motivo: "token_invalido" };
  const a = Buffer.from(hashDoToken(recebido), "hex");
  const b = Buffer.from(hashGuardado, "hex");
  return timingSafeEqual(a, b) ? { ok: true, modo } : { ok: false, motivo: "token_invalido" };
}

/**
 * O endereço que a atendente cola como "URL do Webhook" ao criar o link no
 * provedor. `null` quando a instalação não tem endereço https que abra fora da
 * máquina (`NEXT_PUBLIC_APP_URL` no default, placeholder ou host privado): um
 * recebimento cujo aviso nunca chega é pior que não ter — o vendedor confia e
 * para de conferir. Mesma régua do aviso da cobrança (`lib/cobranca/url.ts`).
 */
export function urlDoAviso(base: string, provedor: string, recebimentoId: string, token: string): string | null {
  const limpa = base.trim().replace(/\/+$/, "");
  if (!URL.canParse(limpa) || new URL(limpa).protocol !== "https:" || !urlPublicaUsavel(limpa)) return null;
  const url = new URL(`${limpa}/api/v1/webhooks/pagamento/${provedor}`);
  url.searchParams.set(PARAMETRO_DO_RECEBIMENTO_NA_URL, recebimentoId);
  url.searchParams.set(PARAMETRO_DO_TOKEN_NA_URL, token);
  return url.toString();
}
