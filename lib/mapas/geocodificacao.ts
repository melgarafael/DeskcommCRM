/**
 * O PINO VIRA ENDEREÇO APROXIMADO — geocodificação reversa (Google).
 *
 * Medido numa loja que vende pelo WhatsApp (28/09/2026): 10 de 47 conversas do
 * mês tiveram pino de localização, e os 10 chegaram só com coordenadas — sem
 * nome, sem endereço. O agente lia `📍 https://maps.google.com/?q=<lat>,<lng>`
 * e não sabia em que cidade o cliente estava: perguntava a cidade de novo, e
 * não conseguia conferir a cobertura de entrega.
 *
 * Com uma chave da Geocoding API, as coordenadas viram rua, cidade e
 * departamento/estado. É APROXIMADO — a própria documentação do Google diz que
 * a geocodificação reversa "não é uma ciência exata" e devolve o endereço mais
 * próximo dentro de uma tolerância (medido: um ponto na divisa entre duas
 * cidades voltou como a cidade vizinha). Por isso o texto leva "(aprox.)", e quem o lê
 * confirma com o cliente em vez de afirmar.
 *
 * Nada aqui lança: sem resposta, o pino segue como era antes (só o link).
 *
 * ─── O que se mostra, e por quê (medido em 28/09/2026) ─────────────────────
 *
 * Os 8 pinos de clientes que confirmaram pedido, comparados com o endereço que
 * ficou anotado no pedido: o MUNICÍPIO (`administrative_area_level_2`) acertou
 * 8/8 e a região 8/8; a "localidade" (`locality`) errou na zona rural (virou o
 * povoado, e o cliente escreveu o município); o BAIRRO bateu 1/8 — o bairro do
 * Google não é o que o cliente chama de bairro —; e o número da casa é
 * interpolado (a centenas de números do anotado). Por isso a cidade é o
 * município, e bairro e número não saem: um dado errado dito com confiança é
 * pior que nenhum. A rua fica (3 de 5 bateram, e ajuda quem entrega).
 */

import { IDIOMA_PADRAO, parseAcceptLanguage } from "@/lib/i18n/idiomas";
import { idiomaVisivelPorCodigo } from "@/lib/i18n/registro";

/** O que o Google disse sobre o ponto. Todos opcionais: o Google devolve o que tem. */
export interface EnderecoAproximado {
  rua?: string;
  /** O município/distrito — medido mais confiável que a "localidade" do Google. */
  cidade?: string;
  /** Estado (Brasil), departamento ou província (outros países) — `administrative_area_level_1`. */
  regiao?: string;
}

export type MotivoDaFalha =
  /** A Geocoding API não está habilitada no projeto do Google Cloud da chave. */
  | "api_desativada"
  /** Chave inválida, ou com restrição (IP, API) que não permite esta chamada. */
  | "chave_recusada"
  /** Cota ou faturamento do projeto. */
  | "cota"
  /** O Google respondeu, mas não há endereço para o ponto (mar, mata). */
  | "sem_resultado"
  /** Rede, tempo esgotado, resposta que não é JSON. */
  | "rede"
  | "desconhecido";

export type ResultadoDaGeocodificacao =
  | { ok: true; endereco: EnderecoAproximado }
  | { ok: false; motivo: MotivoDaFalha; detalhe?: string };

/** Host fixo — nunca vem de input, então não há destino a validar contra SSRF. */
export const URL_DA_GEOCODIFICACAO = "https://maps.googleapis.com/maps/api/geocode/json";

/** Praça da Sé, São Paulo: o ponto do botão "Testar" — público, nunca o de um cliente. */
export const PONTO_DE_TESTE = { latitude: -23.5503, longitude: -46.634 };

/** Curto: roda dentro do recebimento do pino, e o pino não pode esperar pelo Google. */
export const TEMPO_LIMITE_MS = 2_500;

interface Componente {
  long_name?: unknown;
  types?: unknown;
}

function componentes(resultado: unknown): Componente[] {
  const lista = (resultado as { address_components?: unknown } | null)?.address_components;
  return Array.isArray(lista) ? (lista as Componente[]) : [];
}

/**
 * O primeiro nome encontrado para cada tipo, varrendo os resultados em ordem.
 * O primeiro resultado é o mais preciso, mas às vezes é um estabelecimento sem
 * rua ou sem distrito — os seguintes completam o que faltou.
 */
function primeiroPorTipo(resultados: unknown[]): Map<string, string> {
  const achados = new Map<string, string>();
  for (const r of resultados) {
    for (const c of componentes(r)) {
      const nome = typeof c.long_name === "string" ? c.long_name.trim() : "";
      if (!nome || !Array.isArray(c.types)) continue;
      for (const tipo of c.types) {
        if (typeof tipo === "string" && !achados.has(tipo)) achados.set(tipo, nome);
      }
    }
  }
  return achados;
}

/** Lê a resposta da Geocoding API. Pura: a rede fica em `geocodificarReverso`. */
export function lerRespostaDoGoogle(corpo: unknown): ResultadoDaGeocodificacao {
  const r = (corpo ?? {}) as { status?: unknown; error_message?: unknown; results?: unknown };
  const status = typeof r.status === "string" ? r.status : "";
  const detalhe = typeof r.error_message === "string" ? r.error_message.slice(0, 300) : undefined;

  if (status === "ZERO_RESULTS") return { ok: false, motivo: "sem_resultado" };
  if (status === "OVER_QUERY_LIMIT" || status === "OVER_DAILY_LIMIT") return { ok: false, motivo: "cota", detalhe };
  if (status === "REQUEST_DENIED") {
    // Medido em 28/09/2026: "This API is not activated on your API project."
    // A mensagem é a única coisa que separa "habilite a API" de "a chave não
    // serve" — e as duas pedem ações diferentes de quem configura.
    const desativada = /not activated|not enabled|has not been used/i.test(detalhe ?? "");
    return { ok: false, motivo: desativada ? "api_desativada" : "chave_recusada", detalhe };
  }
  if (status !== "OK") return { ok: false, motivo: "desconhecido", detalhe: detalhe ?? (status || undefined) };

  const resultados = Array.isArray(r.results) ? r.results : [];
  const tipo = primeiroPorTipo(resultados);
  // O município antes da localidade: na zona rural a localidade é o povoado.
  const cidade = tipo.get("administrative_area_level_2") ?? tipo.get("locality");
  const rua = tipo.get("route");
  const regiao = semSufixoDeDepartamento(tipo.get("administrative_area_level_1"));
  const endereco: EnderecoAproximado = {
    // "Unnamed Road" é o Google dizendo que a rua não tem nome — não é nome de rua.
    ...(rua && !/^unnamed\b/i.test(rua) ? { rua } : {}),
    ...(cidade ? { cidade } : {}),
    ...(regiao ? { regiao } : {}),
  };
  if (Object.keys(endereco).length === 0) return { ok: false, motivo: "sem_resultado" };
  return { ok: true, endereco };
}

/**
 * O Google às vezes devolve o departamento em inglês mesmo com `language=es`
 * (medido: "X Department" num pino e "X" no pino vizinho, na mesma região).
 */
function semSufixoDeDepartamento(nome: string | undefined): string | undefined {
  const limpo = nome?.replace(/\s+Department$/i, "").replace(/^Department of\s+/i, "").trim();
  return limpo || undefined;
}

/**
 * "Rua XV de Novembro, Curitiba, Paraná". A região sai quando repete a
 * cidade (São Paulo é município e estado ao mesmo tempo). Sem rótulo de
 * idioma ("bairro", "barrio"): o texto vai para o agente e para a prévia da
 * conversa em qualquer idioma, e os nomes próprios se explicam sozinhos.
 */
export function textoDoEnderecoAproximado(e: EnderecoAproximado): string {
  const regiao = e.regiao && e.regiao !== e.cidade ? e.regiao : null;
  return [e.rua, e.cidade, regiao].filter((p): p is string => Boolean(p)).join(", ");
}

/**
 * O idioma dos nomes que o Google devolve: o da organização (`organizations.locale`,
 * que o instalador grava), resolvido pelo REGISTRO de idiomas como o resto do
 * produto — `es-MX` e `es` viram `es`; o que o produto não serve, o padrão.
 * Um idioma novo no registro chega aqui sem ninguém mexer neste arquivo.
 */
export function idiomaDaConsulta(locale: string | null | undefined): string {
  return idiomaVisivelPorCodigo(parseAcceptLanguage(locale) ?? IDIOMA_PADRAO).tagBcp47;
}

export async function geocodificarReverso(
  chave: string,
  ponto: { latitude: number; longitude: number },
  opcoes: { idioma?: string; fetchImpl?: typeof fetch; tempoLimiteMs?: number } = {},
): Promise<ResultadoDaGeocodificacao> {
  const url = new URL(URL_DA_GEOCODIFICACAO);
  url.searchParams.set("latlng", `${ponto.latitude},${ponto.longitude}`);
  if (opcoes.idioma) url.searchParams.set("language", opcoes.idioma);
  // A Geocoding API só aceita a chave na query. A URL nunca vai para log: quem
  // registra falha registra o `motivo`, e o `detalhe` é a mensagem do Google.
  url.searchParams.set("key", chave);
  try {
    const res = await (opcoes.fetchImpl ?? fetch)(url, {
      signal: AbortSignal.timeout(opcoes.tempoLimiteMs ?? TEMPO_LIMITE_MS),
    });
    let corpo: unknown;
    try {
      corpo = await res.json();
    } catch {
      return { ok: false, motivo: "rede", detalhe: `HTTP ${res.status} sem JSON` };
    }
    return lerRespostaDoGoogle(corpo);
  } catch (err) {
    return { ok: false, motivo: "rede", detalhe: err instanceof Error ? err.name : "erro" };
  }
}
