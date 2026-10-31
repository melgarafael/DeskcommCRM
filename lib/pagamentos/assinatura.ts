/**
 * A ASSINATURA DO AVISO DE PAGAMENTO — obrigatória, e é ela que decide (issue #3509).
 *
 * ─── Por que esta função existe ─────────────────────────────────────────────
 *
 * A rota que recebe "pago" é pública (webhook não tem sessão): qualquer pessoa
 * na internet a alcança com um POST. Sem conferir quem falou, um
 * `{"id":"xyz","status":"paid"}` forjado marcaria um recebimento como pago e
 * moveria o negócio de etapa — o cliente não pagou nada e o funil diz que sim.
 * A issue #3509 põe isso como o item que NÃO pode ficar para depois.
 *
 * ─── Dois modos, e por quê ──────────────────────────────────────────────────
 *
 * 1. `hmac` — `X-Assinatura: t=<unix>,v1=<hex64>`, HMAC-SHA256 de `t.corpo` com
 *    o segredo. É o desenho da Stripe (`lib/cobranca/provedores/stripe.ts`) e o
 *    que se usa quando o provedor assina. Carimbo de tempo dentro da assinatura
 *    porque sem ele uma assinatura capturada vale para sempre.
 *
 * 2. `token` — `X-Webhook-Token: <segredo>`, comparado em tempo constante. É o
 *    que a InfinitePay permite hoje: ela não documenta assinatura do aviso
 *    (pergunta 2 da issue), e o mesmo desenho já roda no Asaas
 *    (`asaas-access-token`). Um token estático é MAIS FRACO que o HMAC — não
 *    protege contra reentrega de um corpo alterado — e por isso não é o
 *    preferido: quando o provedor passar a assinar, o modo 1 assume sem que a
 *    rota mude.
 *
 * 3. `url_token` — o segredo vai no CAMINHO/QUERY da URL do aviso
 *    (`...?t=<segredo>`), não em cabeçalho. Existe por MEDIÇÃO, não por gosto:
 *    em 31/10/2026 um aviso real da InfinitePay foi capturado e ele **não vem
 *    assinado** — nenhum cabeçalho nem campo do corpo traz assinatura, HMAC ou
 *    token (`x-webhook-timestamp` é só uma data). Como a URL é configurada por
 *    nós ao criar o link, o segredo nela é a única prova de origem que o
 *    provedor nos deixa ter. É o modo mais fraco dos três e o texto do PR diz
 *    isso: quem descobrir a URL pode forjar um `paid`. O que segura o dano é o
 *    conjunto — segredo longo (>=16), o único `(org, provedor, external_id)`,
 *    o compare-and-set da confirmação e a auditoria de quem confirmou.
 *
 * ⚠️ FAIL CLOSED nos três: cabeçalho presente e errado NÃO cai para o outro
 * modo. Se `X-Assinatura` veio e não confere, o veredito é inválida — aceitar o
 * token em seguida seria deixar quem forjou a assinatura escolher o caminho mais
 * fraco.
 *
 * Nada aqui loga, nada aqui lança: corpo, cabeçalho e segredo não podem ir para
 * log nem para Sentry (`lib/cobranca/provedores/contrato.ts` diz o mesmo).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { TOLERANCIA_DO_AVISO_S } from "./vocabulario";

export const CABECALHO_DA_ASSINATURA = "x-assinatura";
export const CABECALHO_DO_TOKEN = "x-webhook-token";
/**
 * O parâmetro de query onde o segredo pode vir quando o provedor não manda
 * cabeçalho nenhum (medido na InfinitePay em 31/10). Quem cria o link configura
 * a URL — então o segredo viaja nela.
 */
export const PARAMETRO_DO_TOKEN_NA_URL = "t";

export type ModoDeAssinatura = "hmac" | "token" | "url_token";

export type VereditoDaAssinatura =
  | { ok: true; modo: ModoDeAssinatura }
  | { ok: false; motivo: "sem_assinatura" | "assinatura_invalida" };

const INVALIDA: VereditoDaAssinatura = { ok: false, motivo: "assinatura_invalida" };

/**
 * `segredo` vazio é inválida, e não "sem assinatura": quem chama já conferiu a
 * configuração antes (a rota devolve 503 dizendo o que falta). Chegar aqui sem
 * segredo é defeito de chamada, e o veredito tem de ser o fechado.
 */
export function verificarAssinatura(
  corpoCru: string,
  headers: Headers,
  segredo: string,
  agora: Date,
  tokenNaUrl: string | null = null,
): VereditoDaAssinatura {
  if (!segredo) return INVALIDA;

  const cabecalho = headers.get(CABECALHO_DA_ASSINATURA);
  if (cabecalho !== null) return verificarHmac(cabecalho, corpoCru, segredo, agora);

  const token = headers.get(CABECALHO_DO_TOKEN);
  if (token !== null) return compararToken(token, segredo, "token");

  // Sem cabeçalho nenhum: é o provedor que NÃO assina (medido na InfinitePay em
  // 31/10). A prova de origem passa a ser o segredo que viaja na URL que nós
  // configuramos. Ausente também é recusa — nunca "aceita por falta de prova".
  if (tokenNaUrl !== null) return compararToken(tokenNaUrl, segredo, "url_token");

  return { ok: false, motivo: "sem_assinatura" };
}

function compararToken(
  recebido: string,
  segredo: string,
  modo: "token" | "url_token",
): VereditoDaAssinatura {
  // Hash dos dois lados: `timingSafeEqual` exige buffers do MESMO tamanho, e
  // comparar o comprimento antes já contaria ao atacante quanto ele acertou.
  const a = createHash("sha256").update(recebido, "utf8").digest();
  const b = createHash("sha256").update(segredo, "utf8").digest();
  return timingSafeEqual(a, b) ? { ok: true, modo } : INVALIDA;
}

function verificarHmac(
  cabecalho: string,
  corpoCru: string,
  segredo: string,
  agora: Date,
): VereditoDaAssinatura {
  let t: number | null = null;
  const assinaturas: Buffer[] = [];
  for (const parte of cabecalho.split(",")) {
    const i = parte.indexOf("=");
    if (i <= 0) continue;
    const nome = parte.slice(0, i).trim();
    const valor = parte.slice(i + 1).trim();
    if (nome === "t" && /^\d{1,12}$/.test(valor)) t = Number(valor);
    else if (nome === "v1" && /^[0-9a-f]{64}$/.test(valor)) assinaturas.push(Buffer.from(valor, "hex"));
  }
  if (t === null || assinaturas.length === 0) return INVALIDA;

  // Falha fechada com `agora` inválido (NaN): a comparação daria false e pularia
  // a janela, que é o oposto do que se quer.
  const agoraS = agora.getTime() / 1000;
  if (!(Math.abs(agoraS - t) <= TOLERANCIA_DO_AVISO_S)) return INVALIDA;

  const esperada = createHmac("sha256", segredo).update(`${t}.${corpoCru}`, "utf8").digest();
  // Todas comparadas, sem atalho: o tamanho (32 bytes) já foi garantido pelo regex.
  if (!assinaturas.map((a) => timingSafeEqual(a, esperada)).includes(true)) return INVALIDA;
  return { ok: true, modo: "hmac" };
}

/** O cabeçalho que um teste (ou o painel do provedor) precisa montar. Documentação viva. */
export function assinarParaTeste(corpoCru: string, segredo: string, quando: Date): string {
  const t = Math.floor(quando.getTime() / 1000);
  const v1 = createHmac("sha256", segredo).update(`${t}.${corpoCru}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}
