/**
 * Fetch de auditoria de site — fase de rede do enriquecimento (spec 24, §3.2).
 *
 * Server-only (resolve DNS, abre socket). Nunca importar de client: a tela
 * recebe o veredito pronto em `data.site`.
 *
 * Guardas (testadas sem rede externa, contra servidor local e fakes nos testes):
 * - SSRF pela guarda da casa: `recusarSSRF` (sintaxe/protocolo/credencial) +
 *   `assertDestinoResolvidoSeguro` (DNS com fail-closed) a cada salto, via
 *   `hostLiberado`; `ipEhEspecial` para o literal;
 * - redirects manuais (teto 5), cada salto revalidado;
 * - corpo abortado ao passar de 200KB (nunca fatiado depois);
 * - timeout 8000ms por tentativa; 1 retry real em falha transitória
 *   (timeout/conexão) — o docstring antigo prometia sem implementar;
 * - transitória persistente vira veredito PROVISÓRIO (não citável, reverificado
 *   até `LIMITE_TENTATIVAS`); definitivo só o comprovado (HTTP/SSL/agregador)
 *   e o domínio inexistente (NXDOMAIN com certeza do resolvedor, na hora).
 *
 * Residual conhecido: DNS rebinding entre a verificação e o connect (TOCTOU),
 * declarado na guarda da casa. Fora do modelo de ameaça desta fase.
 */
import { lookup as lookupDns } from "node:dns/promises";
import { isIP } from "node:net";

import {
  assertDestinoResolvidoSeguro,
  ipEhEspecial,
} from "@/lib/automation/outbound-ip";
import {
  derivarClasse,
  detectarConstrutor,
  hostDeSite,
  MINIMO_CHARS_PAGINA_REAL,
  montarChecklist,
  vereditoPuro,
  type ErroDeRede,
  type SiteEnrichment,
} from "@/lib/prospecting/site-classify";
import { LIMITE_TENTATIVAS } from "@/lib/prospecting/site-efetivo";

const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 200_000;
const LIMITE_LENTO_MS = 5000;
const MAX_CHARS_RESUMO = 1200;
/**
 * Prazo do LOTE de auditoria (todos os sites juntos). Um site pode pendurar
 * mesmo com `AbortSignal.timeout` (medido na VPS: o tick ficou ~30 min
 * segurando o lock). Quem não couber no prazo sai provisório e continua depois.
 */
export const PRAZO_DO_LOTE_MS = 60_000;
const UA_NAVEGADOR =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * True para literal IP que nunca pode ser alvo de fetch. Delegado à guarda da
 * casa (`ipEhEspecial`, que cobre mais faixas que a lista própria que morava
 * aqui: CGNAT, TEST-NETs, multicast, NAT64). Nomes retornam false — o
 * julgamento deles é no DNS por `hostLiberado`, nunca aqui.
 */
export function enderecoInterno(ip: string): boolean {
  const alvo = ip.replace(/^\[(.*)\]$/, "$1");
  if (isIP(alvo) === 0) return false;
  return ipEhEspecial(alvo);
}

/**
 * Guarda SSRF — parte pura (sem DNS): sintaxe, protocolo e credencial.
 * Julgamento de host/IP é da guarda da casa (`ipEhEspecial` para literal);
 * nomes são julgados no DNS por `hostLiberado`, a cada salto. Retorna o
 * motivo ou null (liberado para a próxima etapa, nunca "seguro").
 */
export function recusarSSRF(url: string | null | undefined): string | null {
  if (!url || url.trim() === "") return "url-invalida";
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return "url-invalida";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "protocolo-bloqueado";
  if (parsed.username !== "" || parsed.password !== "") return "credencial-na-url";
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host.toLowerCase() === "localhost") return "rede-interna";
  if (isIP(host) !== 0) return ipEhEspecial(host) ? "rede-interna" : null;
  return null;
}

function ehFalhaDeDns(erro: unknown): boolean {
  const texto = String((erro as { cause?: unknown })?.cause ?? erro).toLowerCase();
  return (
    texto.includes("getaddrinfo") ||
    texto.includes("enotfound") ||
    texto.includes("eai_again") ||
    texto.includes("nameresolution")
  );
}

function codigoSsl(erro: unknown): string | null {
  const causa = String(
    (erro as { cause?: { code?: string; message?: string } })?.cause?.code ??
      (erro as { cause?: { message?: string } })?.cause?.message ??
      (erro as Error)?.message ??
      "",
  );
  const m = /(CERT_[A-Z_]+|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID)/.exec(
    causa,
  );
  return m?.[1] ?? null;
}

/** Verifica o host pela guarda da casa. Injetável para testes determinísticos. */
export type VerificadorDeHost = (hostname: string) => Promise<void>;

/** `lookup` injetável de DNS (fake nos testes, `node:dns/promises` em produção). */
export type FuncaoLookup = (
  hostname: string,
  opcoes: { all: true },
) => Promise<Array<{ address: string }>>;

/**
 * Verificador padrão com NXDOMAIN separado de dúvida de rede (spec 24):
 * resolvedor respondeu `ENOTFOUND` = domínio não existe (prova, definitivo);
 * qualquer outra falha de lookup = dúvida (provisório, como a guarda da casa).
 * Sucesso e literal de IP delegam à guarda da casa (só ela julga IP privado).
 */
export function criarVerificadorPadrao(lookupFn: FuncaoLookup = lookupDns): VerificadorDeHost {
  return async (hostname: string) => {
    const literal = hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIP(literal) !== 0) return assertDestinoResolvidoSeguro(hostname);
    try {
      await lookupFn(hostname, { all: true });
    } catch (erro) {
      if ((erro as { code?: string } | null)?.code === "ENOTFOUND") {
        throw new Error("unsafe_url:dns_nxdomain");
      }
      throw new Error("unsafe_url:dns_failed");
    }
    return assertDestinoResolvidoSeguro(hostname);
  };
}

const verificadorPadrao: VerificadorDeHost = criarVerificadorPadrao();

async function hostLiberado(
  url: string,
  verificar: VerificadorDeHost = verificadorPadrao,
): Promise<string | null> {
  const bloqueioPuro = recusarSSRF(url);
  if (bloqueioPuro) return bloqueioPuro === "url-invalida" ? "url-invalida" : "rede-interna";
  try {
    await verificar(new URL(url).hostname);
  } catch (erro) {
    // Preserva a mensagem da casa (`unsafe_url:private_ip`,
    // `unsafe_url:dns_nxdomain` vs `unsafe_url:dns_failed`): o chamador
    // decide entre definitivo e provisório.
    const mensagem = erro instanceof Error ? erro.message : String(erro);
    return mensagem.includes("unsafe_url:") ? mensagem : "rede-interna";
  }
  return null;
}

async function lerLimitado(res: Response): Promise<string> {
  const leitor = res.body?.getReader();
  if (!leitor) return "";
  const decoder = new TextDecoder();
  let recebido = 0;
  let texto = "";
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    recebido += value.byteLength;
    if (recebido > MAX_BODY_BYTES) {
      await leitor.cancel().catch(() => undefined);
      break;
    }
    texto += decoder.decode(value, { stream: true });
  }
  texto += decoder.decode();
  return texto.slice(0, MAX_BODY_BYTES);
}

interface Busca {
  finalUrl: string;
  status: number;
  html: string;
  ms: number;
  /** O servidor respondeu com um DESAFIO anti-robô (`cf-mitigated`): barrou o nosso IP, não o visitante. */
  desafioAntiRobo?: boolean;
}

/**
 * Resposta de erro que NÃO é prova de defeito do site: 429 (limite de taxa) e 503
 * (indisponível) são temporários por definição, e o desafio anti-robô é o
 * datacenter da VPS sendo barrado enquanto o site abre normal para quem visita.
 * Virar "o site responde com erro" para sempre — e ser dito à empresa — é o mesmo
 * risco que já se fechou para timeout e DNS: segue PROVISÓRIO (não citável).
 */
function erroPassageiro(b: Pick<Busca, "status" | "desafioAntiRobo">): boolean {
  return b.status === 429 || b.status === 503 || b.desafioAntiRobo === true;
}

async function buscar(
  urlInicial: string,
  fetchFn: typeof fetch = fetch,
  verificar: VerificadorDeHost = verificadorPadrao,
): Promise<Busca> {
  let atual = urlInicial.startsWith("http://") || urlInicial.startsWith("https://")
    ? urlInicial
    : `https://${urlInicial}`;
  const t0 = Date.now();
  for (let salto = 0; salto <= MAX_REDIRECTS; salto++) {
    const bloqueio = await hostLiberado(atual, verificar);
    if (bloqueio) throw Object.assign(new Error(bloqueio), { bloqueioSSRF: bloqueio });
    const res = await fetchFn(atual, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": UA_NAVEGADOR },
    });
    const destino = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && destino) {
      await res.body?.cancel().catch(() => undefined);
      atual = new URL(destino, atual).href;
      continue;
    }
    const html = await lerLimitado(res);
    return {
      finalUrl: res.url || atual,
      status: res.status,
      html,
      ms: Date.now() - t0,
      desafioAntiRobo: !!res.headers.get("cf-mitigated"),
    };
  }
  throw new Error("redirects-demais");
}

/**
 * A mesma página abre por https? Uma sonda só, pelo mesmo caminho seguro de
 * `buscar` (guarda de rede e redirects revalidados). Qualquer falha — certificado,
 * conexão, 4xx/5xx, ou terminar de volta em http — conta como "não abre".
 */
async function httpsAbre(
  urlHttp: string,
  fetchFn: typeof fetch,
  verificar: VerificadorDeHost,
): Promise<boolean> {
  try {
    const alvo = new URL(urlHttp);
    alvo.protocol = "https:";
    const r = await buscar(alvo.href, fetchFn, verificar);
    return r.status < 400 && r.finalUrl.toLowerCase().startsWith("https://");
  } catch {
    return false;
  }
}

function extrairPrimeiro(html: string, padrao: RegExp): string | null {
  const m = padrao.exec(html);
  return m?.[1] ? m[1].replace(/\s+/g, " ").trim() || null : null;
}

function montarResumo(html: string): string | null {
  const partes: string[] = [];
  const titulo = extrairPrimeiro(html, /<title[^>]*>(.*?)<\/title>/is);
  if (titulo) partes.push(`Título: ${titulo}`);
  const descricao =
    extrairPrimeiro(html, /<meta[^>]+name=["']description["\'][^>]+content=["'](.*?)["']/is) ??
    extrairPrimeiro(html, /<meta[^>]+content=["'](.*?)["\'][^>]+name=["']description["']/is);
  if (descricao) partes.push(`Descrição: ${descricao}`);
  const cabecalhos = [...html.matchAll(/<h[12][^>]*>(.*?)<\/h[12]>/gis)]
    .map((m) => (m[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 6);
  if (cabecalhos.length > 0) partes.push(`Cabeçalhos: ${cabecalhos.join(" | ")}`);
  const corpo = html
    .replace(/<(script|style|noscript)[^>]*>.*?<\/\1>/gis, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHARS_RESUMO);
  if (corpo) partes.push(`Trecho: ${corpo}`);
  if (partes.length === 0) return null;
  return partes.join("\n").slice(0, MAX_CHARS_RESUMO);
}

function anoDesatualizado(html: string): string | null {
  const anos = [...html.matchAll(/(?:©|&copy;|copyright)\D{0,20}(20\d{2})/gi)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isInteger(n));
  if (anos.length === 0) return null;
  const recente = Math.max(...anos);
  const atual = new Date().getFullYear();
  return recente <= atual - 2 ? `sem-atualizacao-desde-${recente}` : null;
}

/**
 * Audita um site e devolve o veredito pronto para `data.site`.
 *
 * Transitória (timeout, conexão resetada, dúvida de rede) ganha UMA nova
 * tentativa e, persistindo, vira veredito PROVISÓRIO (`provisorio: true`,
 * `tentativas` incrementado) — não citável, reverificado pelo tick depois do
 * intervalo mínimo até `LIMITE_TENTATIVAS`, quando congela definitivo.
 * Domínio inexistente (NXDOMAIN) é prova, não dúvida: definitivo na hora.
 * O docstring antigo prometia esse retry sem implementá-lo; agora existe de verdade.
 * `pagespeed` sempre null nesta fase (faixa lenta posterior, spec §3.5).
 */
export async function auditarSite(
  url: string,
  agoraIso: string,
  fetchFn: typeof fetch = fetch,
  verificar: VerificadorDeHost = verificadorPadrao,
  tentativasAnteriores = 0,
): Promise<SiteEnrichment> {
  // Portão puro antes de qualquer rede: Instagram/WhatsApp/linktree e afins
  // nunca foram site — as linhas antigas (de antes do veredito no insert)
  // chegam aqui pelo tick e pela reanálise, e buscar URL de agregador além
  // de desperdiçar fetch ainda rende veredito errado ("lento", "fora-do-ar").
  const puro = vereditoPuro(url, agoraIso);
  if (puro) return { ...puro, tentativas: tentativasAnteriores };
  const falha = (
    classe: SiteEnrichment["classe"],
    problemas: string[] = [],
    provisorio = false,
    tentativas = tentativasAnteriores,
  ): SiteEnrichment => ({
    ver: 1, classe, problemas, checklist: { tem: [], falta: [] },
    final_url: null, http_status: null, tempo_ms: 0,
    conteudo_resumo: null, pagespeed: null, verificado_em: agoraIso,
    provisorio, tentativas,
  });
  const provisorio = (tentativas: number): SiteEnrichment =>
    tentativas + 1 >= LIMITE_TENTATIVAS
      ? falha("fora-do-ar", ["fora-do-ar"], false, tentativas + 1)
      : falha("fora-do-ar", ["fora-do-ar"], true, tentativas + 1);

  const tentar = async (): Promise<SiteEnrichment> => {
    let busca: Busca;
    try {
      busca = await buscar(url, fetchFn, verificar);
    } catch (erro) {
      const bloqueio = (erro as { bloqueioSSRF?: string })?.bloqueioSSRF ?? "";
      // Sintaxe inválida ou IP privado/literal interno: inalcançável da
      // internet pública — definitivo e citável (nada há para reverificar).
      if (bloqueio === "url-invalida" || bloqueio === "rede-interna" || bloqueio.includes("private_ip")) {
        return falha("fora-do-ar", ["fora-do-ar"]);
      }
      // Domínio NÃO EXISTE (NXDOMAIN com certeza do resolvedor): prova, não
      // dúvida — definitivo e citável na hora, sem retry.
      if (bloqueio.includes("dns_nxdomain")) {
        return falha("fora-do-ar", ["fora-do-ar"], false, tentativasAnteriores + 1);
      }
      // DNS que não resolveu: passageiro até prova em contrário.
      if (bloqueio.includes("dns_")) return provisorio(tentativasAnteriores);
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      if (mensagem === "redirects-demais") return falha("site-ruim", []);
      if (codigoSsl(erro)) return falha("ssl-invalido", ["ssl-invalido"]);
      if (ehFalhaDeDns(erro)) return provisorio(tentativasAnteriores);
      // Transitória (timeout, reset): UMA nova tentativa antes de declarar.
      await new Promise((r) => setTimeout(r, 1000));
      try {
        busca = await buscar(url, fetchFn, verificar);
      } catch {
        return provisorio(tentativasAnteriores);
      }
    }

    const html = busca.html;
    const minusculo = html.toLowerCase();
    const problemas: string[] = [];
    if (busca.status >= 400) {
      if (erroPassageiro(busca)) return provisorio(tentativasAnteriores);
      return {
        ver: 1, classe: "site-ruim", problemas: [`http-${busca.status}`],
        checklist: montarChecklist(html), final_url: busca.finalUrl.slice(0, 500),
        http_status: busca.status, tempo_ms: busca.ms,
        conteudo_resumo: montarResumo(html), pagespeed: null, verificado_em: agoraIso,
        provisorio: false, tentativas: tentativasAnteriores,
      };
    }
    if (busca.ms > LIMITE_LENTO_MS) problemas.push("lento");
    if (busca.finalUrl.toLowerCase().startsWith("http://")) {
      // O endereço que o Google mostra abre sem cadeado. Mas "o site não tem https" só é
      // verdade se a versão https também NÃO abre: se abre, o defeito é outro (não
      // redireciona) e a copy não pode afirmar o que não é.
      problemas.push((await httpsAbre(busca.finalUrl, fetchFn, verificar)) ? "http-sem-redirecionar" : "sem-https");
    }
    else if (/(?:\ssrc=["']http:\/\/|<link[^>]+href=["']http:\/\/)/i.test(html)) problemas.push("conteudo-misto");
    if (!minusculo.includes("viewport")) problemas.push("nao-mobile");
    if (html.trim().length < MINIMO_CHARS_PAGINA_REAL) problemas.push("quase-vazia");
    const construtor = detectarConstrutor(busca.finalUrl, html);
    if (construtor) problemas.push(`construtor-${construtor}`);
    const parado = anoDesatualizado(html);
    if (parado) problemas.push(parado);

    const checklist = montarChecklist(html);
    for (const item of checklist.falta) problemas.push(`falta-${item}`);

    const erro: ErroDeRede | undefined = undefined;
    const classe = derivarClasse({
      agregador: false,
      semSite: false,
      erro,
      urlFinal: busca.finalUrl,
      problemas,
    });

    return {
      ver: 1, classe, problemas,
      checklist, final_url: busca.finalUrl.slice(0, 500),
      http_status: busca.status, tempo_ms: busca.ms,
      conteudo_resumo: montarResumo(html), pagespeed: null, verificado_em: agoraIso,
      provisorio: false, tentativas: tentativasAnteriores,
    };
  };

  try {
    return await tentar();
  } catch {
    return falha("fora-do-ar", ["fora-do-ar"]);
  }
}

/**
 * O teto de tentativas e o intervalo entre elas moram em `site-efetivo.ts`
 * (client-safe, porque o contador da tela lê a mesma régua). Reexportados aqui
 * para os consumidores server-side continuarem importando deste módulo.
 */
export {
  deveReverificar,
  INTERVALO_MINIMO_ENTRE_TENTATIVAS_MIN,
  LIMITE_TENTATIVAS,
} from "@/lib/prospecting/site-efetivo";

/**
 * Roda N auditorias com paralelismo limitado, sem derrubar o lote por 1 falha
 * (cada item sempre resolve um veredito — nunca rejeita).
 *
 * O lote tem PRAZO: 1 site pendurado não pode segurar o lock por minutos
 * (medido na VPS: o tick ficou ~30 min e a fila inteira respondia 409).
 * Quem não couber no prazo sai provisório, e o próximo tick/rodada continua.
 */
export async function auditarSites(
  urls: string[],
  agoraIso: string,
  paralelismo = 6,
  fetchFn: typeof fetch = fetch,
  verificar: VerificadorDeHost = verificadorPadrao,
  tentativasAnteriores: number[] | number = 0,
  prazoMs = PRAZO_DO_LOTE_MS,
): Promise<SiteEnrichment[]> {
  const saidas: SiteEnrichment[] = new Array(urls.length);
  const abortadorDoLote = new AbortController();
  const relogioDoLote = setTimeout(() => abortadorDoLote.abort(), prazoMs);
  const anteriorDe = (i: number) =>
    Array.isArray(tentativasAnteriores) ? (tentativasAnteriores[i] ?? 0) : tentativasAnteriores;
  // Quem não coube no prazo do lote NÃO teve fetch concluído: não há evidência de nada,
  // então fica PROVISÓRIO e a tentativa NÃO é consumida. Contá-la fazia o item do fim do
  // lote (a seleção é `order by created_at limit 30`) congelar como "fora do ar" na
  // terceira rodada sem nunca ter sido buscado — e a estratégia diria isso à empresa.
  const provisorioDe = (i: number): SiteEnrichment => {
    const anterior = anteriorDe(i);
    return {
      ver: 1, classe: "fora-do-ar", problemas: ["fora-do-ar"],
      checklist: { tem: [], falta: [] }, final_url: null, http_status: null,
      tempo_ms: 0, conteudo_resumo: null, pagespeed: null, verificado_em: agoraIso,
      provisorio: true, tentativas: anterior,
    };
  };
  let proximo = 0;
  const operarios = Array.from({ length: Math.max(1, Math.min(paralelismo, urls.length)) }, async () => {
    for (;;) {
      const i = proximo++;
      if (i >= urls.length) break;
      if (abortadorDoLote.signal.aborted) {
        // Fora do prazo: o próximo tick continua daqui.
        saidas[i] = provisorioDe(i);
        continue;
      }
      const anterior = anteriorDe(i);
      try {
        // Quando o prazo do lote estoura, o item sai provisório (`provisorioDe`) em vez
        // de pendurar o lote. ATENÇÃO: o sinal do lote só resolve esta corrida — ele NÃO
        // chega ao `fetch`, que segue em segundo plano até o próprio timeout
        // (`TIMEOUT_MS`). O bloqueio da organização é liberado; o efeito é pequeno.
        saidas[i] = await Promise.race([
          auditarSite(urls[i]!, agoraIso, fetchFn, verificar, anterior),
          new Promise<SiteEnrichment>((resolve) => {
            abortadorDoLote.signal.addEventListener(
              "abort",
              () => resolve(provisorioDe(i)),
              { once: true },
            );
          }),
        ]);
      } catch {
        saidas[i] = {
          ver: 1, classe: "fora-do-ar", problemas: ["fora-do-ar"],
          checklist: { tem: [], falta: [] }, final_url: null, http_status: null,
          tempo_ms: 0, conteudo_resumo: null, pagespeed: null, verificado_em: agoraIso,
          provisorio: true, tentativas: anterior + 1,
        };
      }
    }
  });
  try {
    await Promise.all(operarios);
  } finally {
    clearTimeout(relogioDoLote);
  }
  return saidas;
}

export { hostDeSite };
