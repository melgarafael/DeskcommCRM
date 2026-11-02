import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIPv4 } from "node:net";

import { motivoDaRecusaDeDestino } from "@/lib/automation/destinos-internos-autorizados";

import { ProspectingError } from "./provider";
import type { DadosDaExecucao, ProvedorDeBusca } from "./provedor";
import type { SearchInput } from "./schema";

const TIMEOUT_MS = 15_000;
const PAGINA_MAXIMA = 5;
const RESULTADOS_POR_PAGINA = 20;
const SEARXNG_DOCKER_HOST = "searxng-search";
const SEARXNG_DOCKER_PORT = "8080";
const DOMINIOS_NAO_COMERCIAIS = new Set([
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
  "google.com",
  "maps.google.com",
  "bing.com",
  "searx.space",
  "apontador.com.br",
  "cylex.com.br",
  "guiamais.com.br",
  "solutudo.com.br",
  "telelistas.net",
]);

interface ResultadoWeb {
  title?: unknown;
  url?: unknown;
  content?: unknown;
}

type ConfiguracaoSearxng =
  | { base: string; interno: false }
  | { base: string; interno: true; ipInterno: string };

export type StatusDaInstalacaoSearxng =
  | "nao-configurado"
  | "conflito"
  | "configuracao-invalida"
  | "https"
  | "docker";

function baseDaInstalacao(): ConfiguracaoSearxng {
  const externo = process.env.SEARXNG_BASE_URL?.trim() ?? "";
  const interno = process.env.SEARXNG_INTERNAL_BASE_URL?.trim() ?? "";
  const ipInterno = process.env.SEARXNG_INTERNAL_IP?.trim() ?? "";

  if (externo && interno)
    throw new ProspectingError(
      "Configure somente uma origem do SearXNG: SEARXNG_BASE_URL ou a rede Docker interna.",
    );

  if (interno) {
    let url: URL;
    try {
      url = new URL(interno);
    } catch {
      throw new ProspectingError("A URL interna do SearXNG não é válida.");
    }
    if (
      url.protocol !== "http:" ||
      url.hostname !== SEARXNG_DOCKER_HOST ||
      url.port !== SEARXNG_DOCKER_PORT ||
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !isIPv4(ipInterno) ||
      !ipPrivado(ipInterno)
    )
      throw new ProspectingError(
        "A rede interna aceita somente http://searxng-search:8080 e o IPv4 privado fixado para esse serviço.",
      );

    return { base: url.href.replace(/\/+$/, ""), interno: true, ipInterno };
  }

  if (ipInterno)
    throw new ProspectingError(
      "SEARXNG_INTERNAL_IP só pode ser configurado junto com SEARXNG_INTERNAL_BASE_URL.",
    );

  if (!externo)
    throw new ProspectingError(
      "A busca web não está configurada nesta instalação. Defina SEARXNG_BASE_URL com HTTPS ou configure a rede Docker interna.",
    );

  let url: URL;
  try {
    url = new URL(externo);
  } catch {
    throw new ProspectingError("SEARXNG_BASE_URL precisa ser um endereço HTTPS válido.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new ProspectingError(
      "SEARXNG_BASE_URL precisa usar HTTPS e não pode conter credenciais, consulta ou fragmento.",
    );
  return { base: url.href.replace(/\/+$/, ""), interno: false };
}

/** Configuração sintaticamente válida; a conexão real é verificada ao selecionar. */
export function searxngConfiguradoNaInstalacao(): boolean {
  try {
    baseDaInstalacao();
    return true;
  } catch {
    return false;
  }
}

/** Diagnóstico seguro para a interface: informa o tipo de problema sem expor URLs. */
export function statusDaInstalacaoSearxng(): StatusDaInstalacaoSearxng {
  const externo = process.env.SEARXNG_BASE_URL?.trim() ?? "";
  const interno = process.env.SEARXNG_INTERNAL_BASE_URL?.trim() ?? "";
  const ipInterno = process.env.SEARXNG_INTERNAL_IP?.trim() ?? "";

  if (externo && interno) return "conflito";
  if (!externo && !interno && !ipInterno) return "nao-configurado";

  try {
    return baseDaInstalacao().interno ? "docker" : "https";
  } catch {
    return "configuracao-invalida";
  }
}

function ipPrivado(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

async function validarRedeDocker(ipEsperado: string): Promise<void> {
  let enderecos: Array<{ address: string }>;
  try {
    enderecos = await lookup(SEARXNG_DOCKER_HOST, { all: true });
  } catch {
    throw new ProspectingError(
      "O SearXNG não está acessível pela rede Docker dedicada. Confira se os dois serviços estão conectados a ela.",
      503,
    );
  }
  if (enderecos.length === 0 || enderecos.some(({ address }) => address !== ipEsperado))
    throw new ProspectingError(
      "O endereço do SearXNG não corresponde ao IPv4 privado fixado para a rede Docker.",
      503,
    );
}

async function baseAutorizada(): Promise<string> {
  const configuracao = baseDaInstalacao();
  if (configuracao.interno) {
    await validarRedeDocker(configuracao.ipInterno);
    // Fetch pelo IP já conferido, não pelo nome: fecha a janela entre a
    // consulta DNS e a resolução feita pelo fetch (DNS rebinding).
    const fixada = new URL(configuracao.base);
    fixada.hostname = configuracao.ipInterno;
    return fixada.href.replace(/\/+$/, "");
  }

  const recusa = await motivoDaRecusaDeDestino(configuracao.base, "instalacao");
  if (recusa)
    throw new ProspectingError(
      `O destino da busca web foi recusado pela política de saída (${recusa}). Autorize o endereço em /admin/destinos-internos.`,
    );
  return configuracao.base;
}

function extrairTelefone(texto: string): string | null {
  const bruto = texto.match(
    /(?:(?:\+?55)[\s().-]*)?(?:\(?\d{2}\)?[\s.-]*)9?\d{4}[\s.-]?\d{4}/,
  )?.[0];
  if (!bruto) return null;
  const digitos = bruto.replace(/\D/g, "");
  return digitos.length >= 12 && digitos.startsWith("55") ? `+${digitos}` : bruto;
}

function extrairEmails(texto: string): string[] {
  return [
    ...new Set(
      (texto.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [])
        .map((email) => email.toLowerCase())
        .filter((email) => !/\.(?:png|jpe?g|gif|svg|webp)$/i.test(email))
        .filter((email) => !/^(?:example|teste|test|noreply|no-reply)@/i.test(email)),
    ),
  ].slice(0, 5);
}

function textoDoResultado(valor: unknown): string {
  if (typeof valor !== "string") return "";
  return valor
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

function resultadoComercial(resultado: ResultadoWeb, nicho: string): Record<string, unknown> | null {
  const titulo = textoDoResultado(resultado.title).slice(0, 200);
  const link = typeof resultado.url === "string" ? resultado.url : "";
  if (!titulo || !link) return null;

  let site: URL;
  try {
    site = new URL(link);
  } catch {
    return null;
  }
  if (site.protocol !== "https:" || site.username || site.password) return null;
  const host = site.hostname.toLowerCase().replace(/^www\./, "");
  if (
    [...DOMINIOS_NAO_COMERCIAIS].some(
      (dominio) => host === dominio || host.endsWith(`.${dominio}`),
    )
  )
    return null;

  const origem = site.origin;
  const placeId = `web:${createHash("sha256").update(host).digest("hex").slice(0, 32)}`;
  const texto = textoDoResultado(resultado.content);
  return {
    title: titulo,
    placeId,
    phone: extrairTelefone(texto),
    website: origem,
    categoryName: nicho,
    address: null,
    // Esta fonte não fornece link de Google Maps.
    url: null,
    emails: extrairEmails(texto),
  };
}

async function buscarPagina(base: string, query: string, pagina: number): Promise<ResultadoWeb[]> {
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "pt-BR");
  url.searchParams.set("safesearch", "1");
  url.searchParams.set("pageno", String(pagina));

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProspectingError(
      "A busca web da instalação não respondeu. Verifique o endpoint SearXNG.",
      502,
    );
  }
  if (!resposta.ok)
    throw new ProspectingError(
      resposta.status === 403
        ? "O SearXNG precisa permitir respostas JSON no endpoint de busca."
        : `A busca web está indisponível (HTTP ${resposta.status}).`,
      502,
    );

  let corpo: unknown;
  try {
    corpo = await resposta.json();
  } catch {
    throw new ProspectingError("O SearXNG respondeu em um formato que não pôde ser lido.", 502);
  }
  if (
    !corpo ||
    typeof corpo !== "object" ||
    !Array.isArray((corpo as { results?: unknown }).results)
  )
    throw new ProspectingError("O SearXNG não devolveu uma lista de resultados web.", 502);
  return (corpo as { results: unknown[] }).results.filter(
    (item): item is ResultadoWeb => !!item && typeof item === "object" && !Array.isArray(item),
  );
}

async function pesquisar(
  query: string,
  limit: number,
  nicho: string,
): Promise<Record<string, unknown>[]> {
  const base = await baseAutorizada();
  const pages = Math.min(PAGINA_MAXIMA, Math.ceil(limit / RESULTADOS_POR_PAGINA));
  const resultados: Record<string, unknown>[] = [];
  const hosts = new Set<string>();

  for (let pagina = 1; pagina <= pages && resultados.length < limit; pagina += 1) {
    const encontrados = await buscarPagina(base, query, pagina);
    for (const encontrado of encontrados) {
      const item = resultadoComercial(encontrado, nicho);
      if (!item) continue;
      const host = new URL(String(item.website)).hostname.toLowerCase().replace(/^www\./, "");
      if (hosts.has(host)) continue;
      hosts.add(host);
      resultados.push(item);
      if (resultados.length >= limit) break;
    }
  }
  return resultados;
}

export const provedorSearxng: ProvedorDeBusca = {
  async startSearch(_chave: string, input: SearchInput): Promise<DadosDaExecucao> {
    const query = `${input.niche} ${input.location} empresa site oficial contato telefone`;
    return {
      id: randomUUID(),
      status: "SUCCEEDED",
      usageTotalUsd: 0,
      results: await pesquisar(query, input.limit, input.niche),
    };
  },
  async readSearch(): Promise<DadosDaExecucao> {
    throw new ProspectingError(
      "A busca web é concluída na mesma solicitação e não tem execução pendente.",
      409,
    );
  },
  async readResults(): Promise<Record<string, unknown>[]> {
    throw new ProspectingError("A busca web não possui conjunto de resultados assíncrono.", 409);
  },
};

export async function validarSearxng(_chave: string): Promise<void> {
  const base = await baseAutorizada();
  await buscarPagina(base, "site:searxng.org SearXNG", 1);
}
