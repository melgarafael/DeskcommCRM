/**
 * Fetch de auditoria de site — fase de rede do enriquecimento (spec 24, §3.2).
 *
 * Server-only (resolve DNS, abre socket). Nunca importar de client: a tela
 * recebe o veredito pronto em `data.site`.
 *
 * Guardas (testadas sem rede externa, contra servidor local nos testes):
 * - SSRF: protocolo http/https, sem userinfo, literal recusado em
 *   `recusarSSRF`; TODO nome resolvido via DNS é recusado se QUALQUER endereço
 *   for interno (`enderecoInterno`) — antes de conectar, a cada redirect;
 * - redirects manuais (teto 5), cada salto revalidado;
 * - corpo abortado ao passar de 200KB (nunca fatiado depois);
 * - timeout 8000ms por tentativa; 1 retry só em falha transitória
 *   (timeout/conexão); DNS-morto e SSL falham na hora.
 *
 * Residual conhecido: DNS rebinding entre o lookup e o connect (TOCTOU). Fora
 * do modelo de ameaça desta fase — o alvo é site público de PME, não adversário
 * com DNS sob controle; reavaliar se o threat-model pedir.
 */
import { lookup } from "node:dns/promises";

import {
  derivarClasse,
  detectarConstrutor,
  enderecoInterno,
  hostDeSite,
  MINIMO_CHARS_PAGINA_REAL,
  montarChecklist,
  recusarSSRF,
  type ErroDeRede,
  type SiteEnrichment,
} from "@/lib/prospecting/site-classify";

const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 200_000;
const LIMITE_LENTO_MS = 5000;
const MAX_CHARS_RESUMO = 1200;
const UA_NAVEGADOR =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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

/** Resolve host → endereços. Injetável para testes determinísticos (sem rede). */
export type ResolvedorDns = (host: string) => Promise<Array<{ address: string }>>;

const resolverPadrao: ResolvedorDns = async (host) => {
  const lista = await lookup(host, { all: true });
  return lista.map((e) => ({ address: e.address }));
};

async function hostLiberado(url: string, resolver: ResolvedorDns = resolverPadrao): Promise<string | null> {
  const bloqueioPuro = recusarSSRF(url);
  if (bloqueioPuro) return bloqueioPuro === "url-invalida" ? "url-invalida" : "rede-interna";
  const host = new URL(url).hostname;
  try {
    const enderecos = await resolver(host);
    if (enderecos.some((e) => enderecoInterno(e.address))) return "rede-interna";
  } catch {
    return null;
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
}

async function buscar(
  urlInicial: string,
  fetchFn: typeof fetch = fetch,
  resolver: ResolvedorDns = resolverPadrao,
): Promise<Busca> {
  let atual = urlInicial.startsWith("http://") || urlInicial.startsWith("https://")
    ? urlInicial
    : `https://${urlInicial}`;
  const t0 = Date.now();
  for (let salto = 0; salto <= MAX_REDIRECTS; salto++) {
    const bloqueio = await hostLiberado(atual, resolver);
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
    return { finalUrl: res.url || atual, status: res.status, html, ms: Date.now() - t0 };
  }
  throw new Error("redirects-demais");
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
 * Nunca lança erro de rede para fora como exceção opaca: classifica.
 * `pagespeed` sempre null nesta fase (faixa lenta posterior, spec §3.5).
 */
export async function auditarSite(
  url: string,
  agoraIso: string,
  fetchFn: typeof fetch = fetch,
  resolver: ResolvedorDns = resolverPadrao,
): Promise<SiteEnrichment> {
  const falha = (classe: SiteEnrichment["classe"], problemas: string[] = []): SiteEnrichment => ({
    ver: 1, classe, problemas, checklist: { tem: [], falta: [] },
    final_url: null, http_status: null, tempo_ms: 0,
    conteudo_resumo: null, pagespeed: null, verificado_em: agoraIso,
  });

  const tentar = async (): Promise<SiteEnrichment> => {
    let busca: Busca;
    try {
      busca = await buscar(url, fetchFn, resolver);
    } catch (erro) {
      if ((erro as { bloqueioSSRF?: string })?.bloqueioSSRF) {
        return falha("fora-do-ar", []);
      }
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      if (mensagem === "redirects-demais") return falha("site-ruim", []);
      if (codigoSsl(erro)) return falha("ssl-invalido", ["ssl-invalido"]);
      if (ehFalhaDeDns(erro)) return falha("fora-do-ar", ["fora-do-ar"]);
      return falha("fora-do-ar", ["fora-do-ar"]);
    }

    const html = busca.html;
    const minusculo = html.toLowerCase();
    const problemas: string[] = [];
    if (busca.status >= 400) {
      return {
        ver: 1, classe: "site-ruim", problemas: [`http-${busca.status}`],
        checklist: montarChecklist(html), final_url: busca.finalUrl.slice(0, 500),
        http_status: busca.status, tempo_ms: busca.ms,
        conteudo_resumo: montarResumo(html), pagespeed: null, verificado_em: agoraIso,
      };
    }
    if (busca.ms > LIMITE_LENTO_MS) problemas.push("lento");
    if (busca.finalUrl.toLowerCase().startsWith("http://")) problemas.push("sem-https");
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
    };
  };

  try {
    return await tentar();
  } catch {
    return falha("fora-do-ar", ["fora-do-ar"]);
  }
}

/**
 * Roda N auditorias com paralelismo limitado, sem derrubar o lote por 1 falha
 * (cada item sempre resolve um veredito — nunca rejeita).
 */
export async function auditarSites(
  urls: string[],
  agoraIso: string,
  paralelismo = 6,
  fetchFn: typeof fetch = fetch,
  resolver: ResolvedorDns = resolverPadrao,
): Promise<SiteEnrichment[]> {
  const saidas: SiteEnrichment[] = new Array(urls.length);
  let proximo = 0;
  const operarios = Array.from({ length: Math.max(1, Math.min(paralelismo, urls.length)) }, async () => {
    for (;;) {
      const i = proximo++;
      if (i >= urls.length) break;
      try {
        saidas[i] = await auditarSite(urls[i]!, agoraIso, fetchFn, resolver);
      } catch {
        saidas[i] = {
          ver: 1, classe: "fora-do-ar", problemas: ["fora-do-ar"],
          checklist: { tem: [], falta: [] }, final_url: null, http_status: null,
          tempo_ms: 0, conteudo_resumo: null, pagespeed: null, verificado_em: agoraIso,
        };
      }
    }
  });
  await Promise.all(operarios);
  return saidas;
}

export { hostDeSite };
