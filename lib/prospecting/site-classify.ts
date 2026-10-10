/**
 * Classificação determinística de site de candidato da prospecção.
 *
 * Papel: transformar o `website` cru (campo que vem poluído da busca — medido:
 * 40% são Instagram/linktree/forms/WhatsApp, não site) em fatos baratos e
 * reproduzíveis: mesmo HTML de entrada, mesma saída, sempre. Nenhuma chamada
 * de modelo acontece aqui — por isso não existe ponto novo em
 * `lib/ai/pontos/registro.ts` para este módulo.
 *
 * O que é impuro de propósito e fica FORA daqui (fase de rede, no tick):
 * resolver DNS + recusar IP interno de nome (a parte literal — `http://127.0.0.1`
 * — é recusada aqui, sem rede) e o `fetch` com timeout. Ver `recusarSSRF`.
 *
 * Server-only: usa `node:net` para classificar IP literal. Nunca importar este
 * módulo de componente client — a tela recebe o veredito pronto via `data.site`.
 */
import { isIP } from "node:net";

/** Classes de auditoria. `dns-morto` é problema, não classe: a classe é `fora-do-ar`. */
export const CLASSES_DE_SITE = [
  "agregador",
  "sem-site",
  "site-ok",
  "site-ruim",
  "ssl-invalido",
  "fora-do-ar",
] as const;
export type ClasseDeSite = (typeof CLASSES_DE_SITE)[number];

/** Domínios que NÃO são site próprio (rede social, agregador, formulário, chat).
 * Medido na VPS em 2026-10-10: 8 de 20 `website` caíram aqui, zero fetch. */
export const DOMINIOS_AGREGADORES = [
  "instagram.com",
  "facebook.com",
  "linktr.ee",
  "forms.gle",
  "api.whatsapp.com",
  "wa.me",
  "linkbio.co",
  "beacons.ai",
] as const;

/** Assinatura de construtor pronto por URL final → rótulo único. */
const CONSTRUTORES_POR_URL: ReadonlyArray<readonly [string, string]> = [
  [".wixsite.com", "Wix"],
  ["sites.google.com", "Google Sites"],
  [".negocio.site", "Google Meu Negócio"],
  [".webnode.page", "Webnode"],
  [".webnode.com.br", "Webnode"],
  ["canva.site", "Canva"],
  [".my.canva.site", "Canva"],
  [".wordpress.com", "WordPress.com gratuito"],
  [".site123.me", "SITE123"],
  [".lojaintegrada.com.br", "Loja Integrada"],
  [".comercioplus.com.br", "Comércio Plus"],
  [".goomer.app", "Goomer"],
  // Medido na amostra real da VPS em 2026-10-10 (redirect de agendamento morto).
  ["automatizo.dev.br", "Automatizo"],
];

/** Assinatura de construtor pronto por conteúdo do HTML → rótulo único. */
const CONSTRUTORES_POR_HTML: ReadonlyArray<readonly [string, string]> = [
  ["static.wixstatic.com", "Wix"],
  ["static.parastorage.com", "Wix"],
  ['generator" content="wix', "Wix"],
  ['generator" content="site123', "SITE123"],
  ['generator" content="webnode', "Webnode"],
  ["cdn.usite.pro", "uSite"],
  ["websitebuilder", "construtor de site"],
];

/** Códigos do raio-X. Vocabulário fechado: nada fora disto chega à tela nem ao prompt. */
export const ITENS_DO_RAIO_X = [
  "whatsapp",
  "tel",
  "mailto",
  "social",
  "mapa",
  "fotos",
  "titulo",
  "description",
  "favicon",
] as const;
export type ItemDoRaioX = (typeof ITENS_DO_RAIO_X)[number];

export interface RaioXDoSite {
  tem: ItemDoRaioX[];
  falta: ItemDoRaioX[];
}

/** Host canônico para comparação (`www.` fora, minúsculo) ou null se não for http(s). */
export function hostDeSite(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** True quando o `website` não é site próprio (ou nem URL é). Barato: sem rede. */
export function ehAgregador(url: string | null | undefined): boolean {
  const host = hostDeSite(url);
  if (!host) return true;
  return DOMINIOS_AGREGADORES.some((d) => host === d || host.endsWith(`.${d}`));
}

/** True quando não há o que buscar (nulo, vazio, só espaço). */
export function ehSemSite(url: string | null | undefined): boolean {
  return !url || url.trim() === "";
}

/**
 * Detecta construtor pronto pela URL final + HTML. Retorna UM rótulo mesmo
 * quando várias assinaturas casam (medido: `wix.com` triga 3 de uma vez).
 */
export function detectarConstrutor(urlFinal: string, html: string): string | null {
  const urlMinuscula = (urlFinal || "").toLowerCase();
  for (const [assinatura, nome] of CONSTRUTORES_POR_URL) {
    if (urlMinuscula.includes(assinatura)) return nome;
  }
  const htmlMinusculo = (html || "").toLowerCase();
  for (const [assinatura, nome] of CONSTRUTORES_POR_HTML) {
    if (htmlMinusculo.includes(assinatura)) return nome;
  }
  return null;
}

const TITULOS_VAZIOS = new Set(["home", "index", "início", "inicio", "untitled"]);

/**
 * Raio-X do HTML: o que o site TEM e o que FALTA para transformar visita em
 * contato. Tudo derivado da página baixada — nada aqui é chute.
 */
export function montarChecklist(html: string): RaioXDoSite {
  const fonte = html || "";
  const minusculo = fonte.toLowerCase();
  const presente: Array<[ItemDoRaioX, boolean]> = [
    [
      "whatsapp",
      minusculo.includes("wa.me") ||
        minusculo.includes("api.whatsapp.com") ||
        minusculo.includes("whatsapp"),
    ],
    ["tel", minusculo.includes('href="tel:') || minusculo.includes("href='tel:")],
    ["mailto", minusculo.includes("mailto:")],
    ["social", minusculo.includes("instagram.com") || minusculo.includes("facebook.com")],
    [
      "mapa",
      minusculo.includes("google.com/maps") ||
        minusculo.includes("maps.google") ||
        minusculo.includes("<address") ||
        /\b\d{5}-\d{3}\b/.test(fonte),
    ],
    ["fotos", (minusculo.match(/<img\b/g) ?? []).length >= 3],
    [
      "titulo",
      (() => {
        const m = /<title[^>]*>(.*?)<\/title>/is.exec(fonte);
        const texto = (m?.[1] ?? "").replace(/\s+/g, " ").trim();
        return texto.length > 8 && !TITULOS_VAZIOS.has(texto.toLowerCase());
      })(),
    ],
    [
      "description",
      /<meta[^>]+name=["']description["\'][^>]+content=["'](.{30,})["']/i.test(fonte),
    ],
    ["favicon", /rel=["'](?:shortcut )?icon/i.test(minusculo)],
  ];
  return {
    tem: presente.filter(([, ok]) => ok).map(([nome]) => nome),
    falta: presente.filter(([, ok]) => !ok).map(([nome]) => nome),
  };
}

/** Página "quase vazia": existe mas não apresenta nada. Limiar pinado por teste. */
export const MINIMO_CHARS_PAGINA_REAL = 800;

/** Erros de rede classificados sem adivinhação. `ssl` carrega o código (ex: CERT_HAS_EXPIRED). */
export type ErroDeRede =
  | { tipo: "dns" }
  | { tipo: "ssl"; codigo: string }
  | { tipo: "transitoria" }
  | { tipo: "http"; status: number };

export interface EntradaDaClasse {
  agregador: boolean;
  semSite: boolean;
  erro?: ErroDeRede;
  urlFinal: string;
  problemas: string[];
}

/**
 * Ordem determinística (função pura): agregador > sem-site > fora-do-ar >
 * ssl-invalido > http>=400 > demais problemas → site-ruim > site-ok.
 */
export function derivarClasse(entrada: EntradaDaClasse): ClasseDeSite {
  if (entrada.agregador) return "agregador";
  if (entrada.semSite) return "sem-site";
  if (entrada.erro) {
    if (entrada.erro.tipo === "dns" || entrada.erro.tipo === "transitoria") return "fora-do-ar";
    if (entrada.erro.tipo === "ssl") return "ssl-invalido";
    if (entrada.erro.tipo === "http" && entrada.erro.status >= 400) return "site-ruim";
  }
  if (entrada.urlFinal.toLowerCase().startsWith("http://")) return "site-ruim";
  return entrada.problemas.length > 0 ? "site-ruim" : "site-ok";
}

function ipv4Privado(partes: number[]): boolean {
  const a = partes[0] ?? -1;
  const b = partes[1] ?? -1;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}

function ipv6Interno(normalizado: string): boolean {
  const h = normalizado.toLowerCase();
  if (h === "::1") return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  if (h.startsWith("fe80:")) return true;
  if (h === "::" || h.startsWith("::ffff:")) return true;
  return false;
}

/**
 * Guarda SSRF — parte pura (sem DNS). O alvo vem do banco (dado de terceiro),
 * então o fetch da fase de rede resolve o host e aplica a MESMA recusa a nomes
 * antes de conectar; aqui caem os literais. Retorna o motivo ou null (liberado
 * para a próxima etapa, nunca "seguro").
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
  const versao = isIP(host);
  if (versao === 4) {
    const partes = host.split(".").map(Number);
    if (partes.length === 4 && partes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      if (ipv4Privado(partes as [number, number, number, number])) return "rede-interna";
    }
    return null;
  }
  if (versao === 6) {
    if (ipv6Interno(host)) return "rede-interna";
    return null;
  }
  return null;
}

/** Problema → frase leiga para a tela e para a copy. PT-BR; a UI usa `t()` à parte. */
const DESCRICOES: Record<string, string> = {
  "sem-https": "sem cadeado de segurança (aparece como 'não seguro' no navegador)",
  "ssl-invalido": "certificado de segurança inválido ou vencido (o navegador mostra alerta antes de abrir)",
  "fora-do-ar": "o site não abre",
  "dns-morto": "o endereço do site não existe mais (domínio pode ter expirado)",
  "nao-mobile": "não abre direito no celular",
  lento: "muito lento para carregar",
  "quase-vazia": "página praticamente vazia (não apresenta serviços nem contato)",
  "sem-atualizacao": "sem sinal de atualização há anos",
  "conteudo-misto": "página segura puxando itens inseguros (partes podem nem carregar)",
  whatsapp: "sem botão de WhatsApp",
  tel: "sem telefone clicável",
  mailto: "sem e-mail de contato",
  social: "sem link para redes sociais",
  mapa: "sem endereço ou mapa",
  fotos: "sem fotos do negócio",
  titulo: "sem título descritivo na aba",
  description: "sem descrição para aparecer no Google",
  favicon: "sem ícone na aba do navegador",
};

export function descreverProblema(codigo: string): string {
  if (codigo.startsWith("http-")) return `o site responde com erro (${codigo.slice("http-".length)})`;
  if (codigo.startsWith("construtor-"))
    return `feito em construtor pronto (${codigo.slice("construtor-".length)}) — mesma cara de milhares de outros`;
  if (codigo.startsWith("sem-atualizacao-desde-"))
    return `parado desde ${codigo.slice("sem-atualizacao-desde-".length)}`;
  if (codigo.startsWith("falta-")) {
    const item = codigo.slice("falta-".length);
    return DESCRICOES[item] ?? `sem ${item}`;
  }
  return DESCRICOES[codigo] ?? codigo;
}
