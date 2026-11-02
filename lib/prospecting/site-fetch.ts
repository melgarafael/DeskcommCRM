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
 * - falha de MEDIÇÃO nunca vira veredito de mérito (#3723): transitória
 *   persistente e status de bloqueio (401/403/406/429/451/503, anti-robô)
 *   ficam PROVISÓRIOS e, esgotado `LIMITE_TENTATIVAS`, congelam `nao-medido` —
 *   não citável. Definitivo e citável só o comprovado: HTTP/SSL do site,
 *   agregador, e o domínio inexistente (NXDOMAIN com certeza do resolvedor).
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
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { env } from "@/lib/env";
import {
  derivarClasse,
  detectarConstrutor,
  hostDeSite,
  MINIMO_CHARS_PAGINA_REAL,
  montarChecklist,
  statusBloqueiaMedicao,
  vereditoPuro,
  type ErroDeRede,
  type SiteEnrichment,
} from "@/lib/prospecting/site-classify";
import {
  conteudoDoTitulo,
  conteudosDeH1H2,
  descricaoComConteudoAntes,
  descricaoComNomeAntes,
  semBlocosDeScript,
  semTags,
  temLinkComHrefHttp,
} from "@/lib/prospecting/leitura-do-html";
import { LIMITE_TENTATIVAS } from "@/lib/prospecting/site-efetivo";
import { normalizeProspectPhone } from "@/lib/prospecting/schema";

const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 200_000;
const FIRECRAWL_TIMEOUT_MS = 12_000;
const FIRECRAWL_REQUESTS_PER_MINUTE = 8;
const CONTACT_PAGE_TIMEOUT_MS = 4000;
const LIMITE_LENTO_MS = 5000;
const MAX_CHARS_RESUMO = 1200;
const RAIZ_SPA_VAZIA = new RegExp(
  `<(div|main|section)\\b(?=[^>]*\\bid=["'](?:root|app|__next|__nuxt|gatsby-focus-wrapper|site_container|site-container)["'])[^>]*>([\\s\\S]*?)<\\/\\1\\s*>|<(app-root)\\b[^>]*>([\\s\\S]*?)<\\/\\3\\s*>`,
  "i",
);
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
      // Alguns streams têm uma leitura de prefetch pendente; aguardar a
      // promessa de cancelamento pode prender a auditoria mesmo após o teto.
      void leitor.cancel().catch(() => undefined);
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
  metodo?: "firecrawl" | "firecrawl-sem-resultado";
  /** O servidor respondeu com um DESAFIO anti-robô (`cf-mitigated`): barrou o nosso IP, não o visitante. */
  desafioAntiRobo?: boolean;
}

/**
 * Renderiza uma única página pública com Firecrawl quando o fetch local só
 * encontrou o shell de uma aplicação JavaScript. A chamada fica desligada por
 * padrão, nunca tenta acessar destinos privados, nunca segue redirects por
 * conta própria e nunca usa o HTML do provedor para concluir URL/status/tempo.
 */
async function buscarHtmlRenderizado(
  url: string,
  fetchFn: typeof fetch,
  verificar: VerificadorDeHost,
): Promise<{ html: string | null; tentado: boolean }> {
  const apiKey = env.FIRECRAWL_API_KEY.trim();
  if (
    !apiKey ||
    env.FIRECRAWL_SITE_FALLBACK_ENABLED.trim().toLowerCase() !== "true"
  ) return { html: null, tentado: false };

  // Revalida o destino imediatamente antes de enviar a URL ao terceiro. A
  // resposta Firecrawl não escolhe URL de follow-up nem é buscada pelo CRM.
  if (await hostLiberado(url, verificar)) return { html: null, tentado: false };

  // O plano gratuito documenta limite de 10 chamadas/minuto em /scrape. Deixamos
  // folga para chamadas administrativas e compartilhamos o teto via Redis entre
  // app e worker. Se o Redis estiver indisponível, o helper degrada para o teto
  // local e o fallback segue opcional.
  const limite = await checkRateLimit(
    "prospeccao:firecrawl:scrape",
    FIRECRAWL_REQUESTS_PER_MINUTE,
    60,
  );
  if (!limite.allowed) return { html: null, tentado: false };

  try {
    const resposta = await fetchFn("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["html"],
        onlyMainContent: false,
        maxAge: 172_800_000,
      }),
    });
    if (!resposta.ok) {
      await resposta.body?.cancel().catch(() => undefined);
      return { html: null, tentado: true };
    }

    const bruto = await lerLimitado(resposta);
    const payload: unknown = JSON.parse(bruto);
    if (!payload || typeof payload !== "object") return { html: null, tentado: true };
    const data = (payload as { data?: unknown }).data;
    if (!data || typeof data !== "object") return { html: null, tentado: true };
    const html = (data as { html?: unknown }).html;
    if (typeof html !== "string" || html.length === 0) return { html: null, tentado: true };
    if (new TextEncoder().encode(html).byteLength > MAX_BODY_BYTES) return { html: null, tentado: true };
    return { html, tentado: true };
  } catch {
    // Firecrawl é melhoria opcional. Qualquer falha mantém a medição original.
    return { html: null, tentado: true };
  }
}

/**
 * Resposta de erro que NÃO é prova de defeito do site: é o NOSSO acesso barrado.
 *
 * 401/403/406/429/451/503 são firewall, limite de taxa ou indisponibilidade
 * momentânea, e o desafio anti-robô (`cf-mitigated`) é o datacenter da VPS sendo
 * barrado enquanto o site abre normal para quem visita — medido no #3723: o
 * mesmo site devolveu 403 ao nosso IP e 200 de rede residencial. Virar "o site
 * responde com erro" para sempre — e ser dito à empresa — só se fechou para
 * timeout e DNS antes; 403 continuava vazando como veredito definitivo.
 * Segue PROVISÓRIO (não citável) e, persistindo, congela `nao-medido`.
 */
function medicaoBarrada(b: Pick<Busca, "status" | "desafioAntiRobo">): boolean {
  return statusBloqueiaMedicao(b.status) || b.desafioAntiRobo === true;
}

async function buscar(
  urlInicial: string,
  fetchFn: typeof fetch = fetch,
  verificar: VerificadorDeHost = verificadorPadrao,
  timeoutMs = TIMEOUT_MS,
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
      signal: AbortSignal.timeout(timeoutMs),
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

function normalizar(texto: string | null): string | null {
  return texto ? texto.replace(/\s+/g, " ").trim() || null : null;
}

function montarResumo(html: string): string | null {
  const partes: string[] = [];
  const titulo = normalizar(conteudoDoTitulo(html));
  if (titulo) partes.push(`Título: ${titulo}`);
  const descricao =
    normalizar(descricaoComNomeAntes(html)) ?? normalizar(descricaoComConteudoAntes(html));
  if (descricao) partes.push(`Descrição: ${descricao}`);
  const cabecalhos = conteudosDeH1H2(html)
    .map((c) => semTags(c).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 6);
  if (cabecalhos.length > 0) partes.push(`Cabeçalhos: ${cabecalhos.join(" | ")}`);
  const corpo = textoVisivel(html).slice(0, MAX_CHARS_RESUMO);
  if (corpo) partes.push(`Trecho: ${corpo}`);
  if (partes.length === 0) return null;
  return partes.join("\n").slice(0, MAX_CHARS_RESUMO);
}

/**
 * O texto que um visitante lê, sem tags, scripts e estilos. A classificação e
 * o checklist usam este conteúdo — `html.trim().length` conta `<script>` e
 * markup de construtor como se fossem texto legível.
 */
export function textoVisivel(html: string): string {
  return semTags(semBlocosDeScript(html || ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** Detecta um shell SPA vazio sem confundir páginas estáticas apenas concisas. */
function pareceShellJavascript(html: string, texto = textoVisivel(html)): boolean {
  if (!/<script\b[^>]*\b(?:src|type=["']module["'])/i.test(html)) return false;
  const raiz = RAIZ_SPA_VAZIA.exec(html);
  if (!raiz) return false;
  return (
    texto.length < MINIMO_CHARS_PAGINA_REAL &&
    textoVisivel(raiz[2] ?? raiz[4] ?? "").length === 0
  );
}

/** Extrai apenas contatos publicados de forma legível ou em mailto/tel. */
function contatosPublicos(
  html: string,
  visivel: string,
  fonte?: string,
): NonNullable<SiteEnrichment["contatos_publicos"]> {
  const encontradosEmail = [
    ...visivel.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi),
    ...html.matchAll(/href\s*=\s*["']mailto:([^"'?#\s]+)/gi),
  ];
  const emails = [...new Set(encontradosEmail
    .map((match) => (match[1] ?? match[0] ?? "").replace(/^mailto:/i, "").trim().toLowerCase())
    .filter((email) => email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))
    .filter((email) => !/^(?:example|teste|test|noreply|no-reply)@/i.test(email)))].slice(0, 5);

  // Texto livre só aceita formatos telefônicos reconhecíveis (DDD entre
  // parênteses ou número separado por hífens). Isso evita transformar CNPJ,
  // CEP ou sequências aleatórias em telefones brasileiros por inferência.
  const telefoneBrasileiroFormatado = /(?:\+55\s*)?\(?\d{2}\)?[\s.-]*\d{4,5}[-\s]\d{4}/g;
  const brutoTelefone = [
    ...visivel.matchAll(telefoneBrasileiroFormatado),
    ...html.matchAll(/href\s*=\s*["']tel:([^"'?#\s]+)/gi),
  ];
  const telefones = [...new Set(brutoTelefone
    .map((match) => match[1] ?? match[0] ?? "")
    .map((value) => {
      const limpo = value.trim();
      const digitos = limpo.replace(/\D/g, "");
      if (!limpo.startsWith("+") && /^55\d{10,11}$/.test(digitos)) return `+${digitos}`;
      return normalizeProspectPhone(limpo);
    })
    .filter((value): value is string => value !== null))].slice(0, 5);
  const fontes = emails.length > 0 || telefones.length > 0 ? [fonte].filter(
    (valor): valor is string => typeof valor === "string" && /^https?:\/\//i.test(valor),
  ) : [];
  return { emails, telefones, ...(fontes.length > 0 ? { fontes } : {}) };
}

/**
 * Escolhe no máximo um link público de contato que a própria página inicial
 * publicou. Não adivinha caminhos, não segue domínios externos e não transforma
 * links `mailto:`/`tel:` em páginas. Isso amplia a coleta comercial sem abrir um
 * crawler arbitrário.
 */
function urlDaPaginaDeContato(html: string, baseUrl: string): string | null {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }

  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)].slice(0, 500);
  const candidatos: Array<{ url: string; prioridade: number }> = [];
  for (const [, atributos, conteudo] of anchors) {
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(atributos ?? "");
    const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3];
    if (!href || /^(?:mailto:|tel:|javascript:|data:)/i.test(href.trim())) continue;

    let destino: URL;
    try {
      destino = new URL(href.trim(), base);
    } catch {
      continue;
    }
    if (
      (destino.protocol !== "http:" && destino.protocol !== "https:") ||
      destino.origin !== base.origin ||
      destino.username ||
      destino.password
    ) continue;

    const caminho = destino.pathname.toLowerCase().replace(/\/+$/, "");
    if (!caminho || caminho === base.pathname.toLowerCase().replace(/\/+$/, "")) continue;
    const rotulo = semTags(conteudo ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    const caminhoContato = /(?:^|\/)(?:contato|contact|fale-conosco|atendimento|sobre|about|empresa|quem-somos|contact-us|get-in-touch)(?:\/|[-_.]|$)/i.test(caminho);
    const rotuloContato = /\b(?:contato|contact|fale conosco|fale com a gente|atendimento|quem somos|about us)\b/.test(rotulo);
    if (!caminhoContato && !rotuloContato) continue;

    destino.hash = "";
    destino.search = "";
    candidatos.push({ url: destino.href, prioridade: caminhoContato ? 0 : 1 });
  }
  candidatos.sort((a, b) => a.prioridade - b.prioridade);
  return candidatos[0]?.url ?? null;
}

interface PaginaComplementarDeContato {
  url: string;
  html: string;
  metodo?: "firecrawl" | "firecrawl-sem-resultado";
}

/** Busca uma única página de contato, somente no mesmo host e com prazo menor. */
async function buscarPaginaComplementarDeContato(
  htmlInicial: string,
  urlInicial: string,
  fetchFn: typeof fetch,
  verificar: VerificadorDeHost,
): Promise<PaginaComplementarDeContato | null> {
  const alvo = urlDaPaginaDeContato(htmlInicial, urlInicial);
  if (!alvo) return null;
  try {
    const pagina = await buscar(alvo, fetchFn, verificar, CONTACT_PAGE_TIMEOUT_MS);
    if (pagina.status < 200 || pagina.status >= 300) return null;

    const origemEsperada = new URL(urlInicial).origin;
    // Redirects externos são seguros no aspecto SSRF, mas não são fonte do site
    // anunciado para este candidato.
    if (new URL(pagina.finalUrl).origin !== origemEsperada) return null;
    if (!pareceShellJavascript(pagina.html)) {
      return { url: pagina.finalUrl, html: pagina.html };
    }

    const renderizado = await buscarHtmlRenderizado(pagina.finalUrl, fetchFn, verificar);
    if (!renderizado.html) {
      return renderizado.tentado
        ? { url: pagina.finalUrl, html: "", metodo: "firecrawl-sem-resultado" }
        : null;
    }
    return { url: pagina.finalUrl, html: renderizado.html, metodo: "firecrawl" };
  } catch {
    // Uma página complementar não determina a saúde nem o veredito do domínio.
    return null;
  }
}

function combinarContatosPublicos(
  htmlPrincipal: string,
  urlPrincipal: string,
  paginaContato: PaginaComplementarDeContato | null,
): NonNullable<SiteEnrichment["contatos_publicos"]> {
  const principal = contatosPublicos(htmlPrincipal, textoVisivel(htmlPrincipal), urlPrincipal);
  const complementar = paginaContato?.html
    ? contatosPublicos(paginaContato.html, textoVisivel(paginaContato.html), paginaContato.url)
    : { emails: [], telefones: [], fontes: [] };
  return {
    emails: [...new Set([...principal.emails, ...complementar.emails])].slice(0, 5),
    telefones: [...new Set([...principal.telefones, ...complementar.telefones])].slice(0, 5),
    fontes: [...new Set([...(principal.fontes ?? []), ...(complementar.fontes ?? [])])].slice(0, 2),
  };
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
 * ─── MEDIDO × NÃO MEDIDO (regra do #3723) ───────────────────────────────────
 * Só é veredito o que a medição PROVOU: 200 com conteúdo, NXDOMAIN com certeza
 * do resolvedor (`dns-morto`), certificado inválido, 4xx/5xx de verdade (404,
 * 500). O resto é `nao-medido`:
 *
 * - 401/403/406/429/451/503 e desafio anti-robô → é o IP do datacenter sendo
 *   barrado (o site abre para o visitante), nunca "o site responde com erro";
 * - timeout, conexão resetada e dúvida de DNS → ganham UMA nova tentativa e,
 *   persistindo, congelam `nao-medido` com `provisorio: false` e `tentativas`
 *   no teto: param de ser reverificados e NUNCA são citados (antes congelavam
 *   `fora-do-ar`, e a estratégia mandava dizer à empresa que o site não abre).
 *
 * `pagespeed` sempre null nesta fase (faixa lenta posterior, spec §3.5).
 */
export async function auditarSite(
  url: string,
  agoraIso: string,
  fetchFn: typeof fetch = fetch,
  verificar: VerificadorDeHost = verificadorPadrao,
  tentativasAnteriores = 0,
  firecrawlTentadoAntes = false,
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
  /**
   * Não conseguimos olhar: o veredito é `nao-medido`, e o único caminho para
   * definitivo é o TETO DE TENTATIVAS — nunca a conclusão de que o site está
   * fora do ar. Definitivo porque `deveReverificar` para de chamar; não citável
   * porque a classe não é mérito.
   */
  const naoMedido = (
    tentativas: number,
    problema: "medicao-bloqueada" | "medicao-instavel" | "conteudo-nao-renderizado",
    pagina?: {
      html: string;
      finalUrl: string;
      status: number;
      ms: number;
      metodo?: "firecrawl-sem-resultado";
    },
  ): SiteEnrichment => {
    const resultado = falha(
      "nao-medido",
      [problema],
      tentativas + 1 < LIMITE_TENTATIVAS,
      tentativas + 1,
    );
    if (!pagina) return resultado;
    const visivel = textoVisivel(pagina.html);
    return {
      ...resultado,
      checklist: { tem: [], falta: [], inconclusivo: true },
      final_url: pagina.finalUrl.slice(0, 500),
      http_status: pagina.status,
      tempo_ms: pagina.ms,
      conteudo_resumo: montarResumo(pagina.html),
      contatos_publicos: contatosPublicos(pagina.html, visivel, pagina.finalUrl),
      ...(pagina.metodo ? { metodo: pagina.metodo } : {}),
    };
  };

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
      // dúvida — definitivo e citável na hora, sem retry. O problema vai como
      // `dns-morto` (o endereço não existe mais) e não como "fora-do-ar": é a
      // diferença entre "o site não abre" (não medido) e "o domínio morreu"
      // (medido), e é ela que a leitura usa para decidir o que é citável.
      if (bloqueio.includes("dns_nxdomain")) {
        return falha("fora-do-ar", ["dns-morto"], false, tentativasAnteriores + 1);
      }
      // DNS que não resolveu: passageiro até prova em contrário.
      if (bloqueio.includes("dns_")) return naoMedido(tentativasAnteriores, "medicao-instavel");
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      if (mensagem === "redirects-demais") return falha("site-ruim", []);
      if (codigoSsl(erro)) return falha("ssl-invalido", ["ssl-invalido"]);
      if (ehFalhaDeDns(erro)) return naoMedido(tentativasAnteriores, "medicao-instavel");
      // Transitória (timeout, reset): UMA nova tentativa antes de declarar.
      await new Promise((r) => setTimeout(r, 1000));
      try {
        busca = await buscar(url, fetchFn, verificar);
      } catch {
        return naoMedido(tentativasAnteriores, "medicao-instavel");
      }
    }

    if (
      !firecrawlTentadoAntes &&
      busca.status >= 200 &&
      busca.status < 300 &&
      pareceShellJavascript(busca.html)
    ) {
      const renderizado = await buscarHtmlRenderizado(busca.finalUrl, fetchFn, verificar);
      if (renderizado.html) busca = { ...busca, html: renderizado.html, metodo: "firecrawl" };
      else if (renderizado.tentado) busca = { ...busca, metodo: "firecrawl-sem-resultado" };
    }
    if (firecrawlTentadoAntes && !busca.metodo && pareceShellJavascript(busca.html)) {
      busca = { ...busca, metodo: "firecrawl-sem-resultado" };
    }

    const html = busca.html;
    const minusculo = html.toLowerCase();
    const textoDaPagina = textoVisivel(html);
    const conteudoCurto = textoDaPagina.length < MINIMO_CHARS_PAGINA_REAL;
    const shellJavascript = pareceShellJavascript(html, textoDaPagina);
    const conteudoNaoRenderizado = shellJavascript && busca.metodo !== "firecrawl";
    const problemas: string[] = [];
    if (busca.status >= 400) {
      // Firewall/limite/anti-robô: quem não passou fomos nós, não o site.
      if (medicaoBarrada(busca)) return naoMedido(tentativasAnteriores, "medicao-bloqueada");
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
    else if (/\ssrc=["']http:\/\//i.test(html) || temLinkComHrefHttp(html)) problemas.push("conteudo-misto");
    const construtor = detectarConstrutor(busca.finalUrl, html);
    if (conteudoCurto && busca.metodo === "firecrawl") problemas.push("quase-vazia");
    else if (conteudoCurto && !conteudoNaoRenderizado && !construtor) problemas.push("quase-vazia");

    // Uma resposta HTTP 200 com raiz SPA vazia e scripts externos não prova que
    // o site está vazio. Tentamos o renderizador externo uma única vez por ciclo de
    // vida do veredito; se ele não estiver configurado ou não devolver conteúdo,
    // guardamos a inspeção como inconclusiva e não fabricamos defeitos de UX.
    if (conteudoNaoRenderizado && problemas.length === 0) {
      return naoMedido(tentativasAnteriores, "conteudo-nao-renderizado", {
        html,
        finalUrl: busca.finalUrl,
        status: busca.status,
        ms: busca.ms,
        ...(busca.metodo === "firecrawl-sem-resultado" ? { metodo: busca.metodo } : {}),
      });
    }

    // Os sinais abaixo dependem de termos visto a página. Evita chamar um shell
    // JavaScript sem conteúdo de versão mobile ausente ou site parado.
    if (!conteudoCurto && !minusculo.includes("viewport")) problemas.push("nao-mobile");
    if (!conteudoNaoRenderizado) {
      if (construtor) problemas.push(`construtor-${construtor}`);
    }
    if (!conteudoCurto && !conteudoNaoRenderizado) {
      const parado = anoDesatualizado(html);
      if (parado) problemas.push(parado);
    }

    // O que não aparece em uma página que não conseguimos ler não é uma falta
    // comprovada. O checklist inconclusivo impede transformar ausência no HTML
    // em diagnóstico de venda (inclui páginas montadas por JavaScript).
    const checklist = montarChecklist(html, { inconclusivo: conteudoNaoRenderizado });
    // `falta-*` NÃO entra em `problemas`: item de checklist é melhoria, não
    // defeito medido — e `problemas` é o que a classe e a copy citam. O
    // checklist guarda o tem/falta para a ficha da tela.

    const erro: ErroDeRede | undefined = undefined;
    const classe = derivarClasse({
      agregador: false,
      semSite: false,
      erro,
      urlFinal: busca.finalUrl,
      problemas,
    });
    const paginaContato = busca.status < 400 && !conteudoNaoRenderizado
      ? await buscarPaginaComplementarDeContato(html, busca.finalUrl, fetchFn, verificar)
      : null;
    const contatos = combinarContatosPublicos(html, busca.finalUrl, paginaContato);
    const metodo = busca.metodo === "firecrawl" || paginaContato?.metodo === "firecrawl"
      ? "firecrawl"
      : busca.metodo ?? paginaContato?.metodo;

    return {
      ver: 1, classe, problemas,
      checklist, final_url: busca.finalUrl.slice(0, 500),
      http_status: busca.status, tempo_ms: busca.ms,
      conteudo_resumo: montarResumo(html),
      contatos_publicos: contatos,
      ...(metodo ? { metodo } : {}),
      pagespeed: null, verificado_em: agoraIso,
      provisorio: false, tentativas: tentativasAnteriores,
    };
  };

  try {
    return await tentar();
  } catch {
    // Erro inesperado: não provamos nada sobre o site — não medido, e não
    // "fora do ar" (a versão anterior citava a empresa por causa disto).
    return falha("nao-medido", ["medicao-instavel"], false, tentativasAnteriores + 1);
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
  firecrawlTentadoAntes: boolean[] | boolean = false,
): Promise<SiteEnrichment[]> {
  const saidas: SiteEnrichment[] = new Array(urls.length);
  const abortadorDoLote = new AbortController();
  const relogioDoLote = setTimeout(() => abortadorDoLote.abort(), prazoMs);
  const anteriorDe = (i: number) =>
    Array.isArray(tentativasAnteriores) ? (tentativasAnteriores[i] ?? 0) : tentativasAnteriores;
  const firecrawlAnteriorDe = (i: number) =>
    Array.isArray(firecrawlTentadoAntes) ? (firecrawlTentadoAntes[i] ?? false) : firecrawlTentadoAntes;
  // Quem não coube no prazo do lote NÃO teve fetch concluído: não há evidência de nada,
  // então fica PROVISÓRIO e a tentativa NÃO é consumida. Contá-la fazia o item do fim do
  // lote (a seleção é `order by created_at limit 30`) congelar como "fora do ar" na
  // terceira rodada sem nunca ter sido buscado — e a estratégia diria isso à empresa.
  const provisorioDe = (i: number): SiteEnrichment => {
    const anterior = anteriorDe(i);
    return {
      ver: 1, classe: "nao-medido", problemas: ["medicao-instavel"],
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
          auditarSite(urls[i]!, agoraIso, fetchFn, verificar, anterior, firecrawlAnteriorDe(i)),
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
          ver: 1, classe: "nao-medido", problemas: ["medicao-instavel"],
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
