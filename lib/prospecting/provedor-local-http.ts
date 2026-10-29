/**
 * #2942 — O PROVEDOR `local-http`: engine de scraping self-hosted, sem Apify.
 *
 * ─── O QUE ELE RESOLVE ─────────────────────────────────────────────────────
 *
 * Até aqui o despacho (`provedor.ts`) só conhecia `apify` e `teste`: uma
 * organização que apontasse `settings.prospecting.provider` para um engine
 * próprio caía FECHADO em "Provedor de busca desconhecido nesta organização"
 * (422). Este arquivo é o provedor que faltava, e o que ele NÃO faz é tão
 * importante quanto o que faz — ele não toca em `PROVEDOR_PADRAO`, não muda
 * nada do caminho default da Apify e não cria migration nenhuma.
 *
 * ─── DE ONDE VEM A URL DO ENGINE: DA INSTALAÇÃO, NUNCA DA ORGANIZAÇÃO ──────
 *
 * A #2942 propôs a URL no lugar da chave, e a primeira versão deste provedor
 * seguiu a issue: o endereço do engine entrava pelo canal de credencial por
 * organização. Isso colide com a REGRA DA CASA — endereço de saída escolhido
 * por uma ORGANIZAÇÃO nunca alcança a rede interna da instalação. A decisão
 * 22-d (`lib/automation/destinos-internos-autorizados.ts`, regra 2) diz que a
 * liberação de destino interno vale SÓ para endereço configurado pela
 * INSTALAÇÃO. Com a URL vindo da organização, o caso de uso do engine interno
 * (rodando na rede do compose) deixaria de funcionar, e aceitar uma URL
 * qualquer abriria a rede interna a quem só sabe escolher um provedor.
 *
 * O desenho, então, é o mesmo de `WACALLS_API_BASE_URL` (`lib/env.ts`): a URL
 * do engine é variável da INSTALAÇÃO (`PROSPECTING_LOCAL_HTTP_URL`), opcional e
 * com default vazio, e o destino passa pela MESMA régua de saída que o resto da
 * casa — `motivoDaRecusaDeDestino(endereco, "instalacao")`. Só um endereço
 * apontado pela instalação E coberto pela lista de destinos internos
 * (`/admin/destinos-internos`) alcança a rede de dentro; qualquer outra URL
 * interna é recusada, e o erro é FECHADO.
 *
 * O valor recebido pela organização (o parâmetro `_url` dos três métodos, a
 * "chave" de sempre) é IGNORADO aqui: não é gravado nem usado. Por isso o
 * `local-http` não exige credencial salva — ver `provedor.ts`
 * (`exigeCredencialDaOrganizacao: false`) e `store.ts`.
 *
 * ─── A LÍNGUA DO ENGINE (e o que fica fora desta fatia) ────────────────────
 *
 * O engine alvo é o do kit self-hosted (`gosom/google-maps-scraper`, MIT),
 * cuja API REST é: `POST {base}/api/v1/scrape` para lançar, `GET
 * {base}/api/v1/jobs/{id}` para o estado E os resultados, e `GET
 * {base}/api/v1/health` para o health check. Os estados dele
 * (`pending`/`running`/`completed`/`failed`/`cancelled`) são traduzidos para os
 * que `store.ts` já lê (`RUNNING`/`SUCCEEDED`/`FAILED`), porque `worker.ts` e
 * `guard.ts` não podem mudar por causa de um provedor novo.
 *
 * O que NÃO entra aqui, de propósito:
 *
 * - **Tradução de campos por provedor (F3).** Os itens saem como o engine os
 *   manda e é `normalizeProspect()` (`schema.ts`) que lê `title`/`placeId`/
 *   `phone` — os nomes do Google Maps, que o engine também usa. Um tradutor
 *   por provedor é outra fatia.
 * - **Geocodificação.** O engine aceita `geo_coordinates`; convertê-las de
 *   `location` em texto é parte da tradução de campos. Até lá a consulta vai
 *   inteira no `keyword` (o formato dos próprios exemplos do engine:
 *   "restaurantes em São Paulo"), que é o caminho mais curto e sem inventar
 *   lat/lon de mentira.
 * - **Teto de buscas por dia e pausa entre buscas.** O ritmo que existe hoje é
 *   de ENVIO (`daily_limit`/`interval_minutes`), não de busca. Fica para a
 *   fatia que a issue pedir.
 * - **Rotear pelo provedor que lançou a busca (#2174).** `synchronizeSearch`
 *   continua lendo a escolha ATUAL da organização, como já faz.
 */
import { motivoDaRecusaDeDestino } from "@/lib/automation/destinos-internos-autorizados";

import { ProspectingError } from "./provider";
import type { DadosDaExecucao, ProvedorDeBusca } from "./provedor";
import type { SearchInput } from "./schema";

/** Teto de uma chamada ao engine. O scrape em si é assíncrono no engine — aqui só se fala o protocolo. */
const TIMEOUT_MS = 20_000;

/**
 * A URL da INSTALAÇÃO vira a base das chamadas, ou o erro FECHADO de sempre.
 *
 * `localhost:8080` (sem esquema) é o erro de digitação mais provável — e o mais
 * traiçoeiro: o parser de URL aceita `localhost:` como se fosse o protocolo.
 * Por isso a checagem é do protocolo, não da forma.
 */
export function baseDoEngine(url: string): string {
  const bruta = url.trim().replace(/\/+$/, "");
  if (!bruta) throw new ProspectingError("Informe a URL do engine de busca local.");
  let alvo: URL;
  try {
    alvo = new URL(bruta);
  } catch {
    throw new ProspectingError(
      `A URL do engine de busca local não é válida: ${bruta}. Use o endereço completo, com http:// ou https://.`,
    );
  }
  if (alvo.protocol !== "http:" && alvo.protocol !== "https:")
    throw new ProspectingError(
      `A URL do engine de busca local precisa começar com http:// ou https:// (recebido: ${bruta}).`,
    );
  return bruta;
}

/**
 * A base do engine, já AUTORIZADA como destino.
 *
 * Lê `PROSPECTING_LOCAL_HTTP_URL` — variável da INSTALAÇÃO, e não da
 * organização — e passa o endereço pela régua de destinos internos
 * (`motivoDaRecusaDeDestino(..., "instalacao")`). Só endereço coberto pela
 * lista que a instalação autoriza alcança a rede de dentro; qualquer outra URL
 * interna é recusa FECHADA, com o mesmo código que `outbound-ip.ts` usa.
 *
 * Vazio = a instalação não oferece o engine, e `baseDoEngine` fecha com o erro
 * de sempre. A régua roda a cada chamada de propósito: é o que pega o nome que
 * passou a resolver para IP interno depois de configurado.
 *
 * Lida de `process.env` (e não de `env.*`) pelo MESMO motivo de
 * `JITSI_SERVER_URL` (`lib/video/jitsi.ts`): o valor é resolvido no runtime e
 * testável com `vi.stubEnv`, sem recarregar o módulo.
 */
export async function baseDoEngineDaInstalacao(): Promise<string> {
  const base = baseDoEngine(process.env.PROSPECTING_LOCAL_HTTP_URL ?? "");
  const recusa = await motivoDaRecusaDeDestino(base, "instalacao");
  if (recusa)
    throw new ProspectingError(
      `O endereço do engine de busca local não é um destino autorizado (${recusa}). ` +
        `Ajuste PROSPECTING_LOCAL_HTTP_URL ou libere o destino em /admin/destinos-internos.`,
      422,
    );
  return base;
}

/** O estado do engine na língua que `store.ts` já lê. Estado novo = erro fechado, não palpite. */
function statusDoEngine(status: string): string {
  switch (status.trim().toLowerCase()) {
    case "completed":
      return "SUCCEEDED";
    case "pending":
    case "running":
    case "scheduled":
    case "retryable":
    case "available":
      return "RUNNING";
    case "failed":
    case "cancelled":
    case "discarded":
      return "FAILED";
    default:
      throw new ProspectingError(
        `O engine de busca local devolveu um estado desconhecido: ${status}.`,
        502,
      );
  }
}

/** O estado da execução, ou erro fechado quando o engine não o diz. */
function estado(corpo: CorpoDoJob): string {
  if (typeof corpo.status !== "string" || !corpo.status.trim())
    throw new ProspectingError("O engine de busca local respondeu sem o estado da execução.", 502);
  return statusDoEngine(corpo.status);
}

/** Falha de rede/servidor do engine é 502 — mesma classificação da falha da Apify em `provider.ts`. */
async function pedir(
  url: string,
  caminho: string,
  init?: { method?: string; body?: string },
): Promise<Response> {
  let resposta: Response;
  try {
    resposta = await fetch(`${url}${caminho}`, {
      method: init?.method ?? "GET",
      redirect: "error",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: init?.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProspectingError(
      `O engine de busca local não respondeu em ${url}. Confira se ele está no ar e se PROSPECTING_LOCAL_HTTP_URL aponta para ele.`,
      502,
    );
  }
  if (!resposta.ok)
    throw new ProspectingError(
      resposta.status === 404
        ? "O engine de busca local não conhece esta busca."
        : `Engine de busca local indisponível (HTTP ${resposta.status}).`,
      502,
    );
  return resposta;
}

/** O corpo de `GET /api/v1/jobs/{id}` — só o que este provedor lê. */
interface CorpoDoJob {
  job_id?: unknown;
  status?: unknown;
  results?: unknown;
}

async function corpoDoJob(url: string, id: string): Promise<CorpoDoJob> {
  const resposta = await pedir(url, `/api/v1/jobs/${encodeURIComponent(id)}`);
  const corpo = (await resposta.json()) as CorpoDoJob;
  if (typeof corpo?.job_id !== "string" || !corpo.job_id)
    throw new ProspectingError(
      "O engine de busca local respondeu sem o identificador da execução.",
      502,
    );
  return corpo;
}

/**
 * O `_url` dos três métodos é o valor que a ORGANIZAÇÃO informaria — e é
 * IGNORADO: a base sai de `baseDoEngineDaInstalacao()`. Mantido no contrato
 * (`ProvedorDeBusca`) só para não mudar a interface de quem despacha.
 */
export const provedorLocalHttp: ProvedorDeBusca = {
  async startSearch(_url, input: SearchInput): Promise<DadosDaExecucao> {
    const base = await baseDoEngineDaInstalacao();
    const resposta = await pedir(base, "/api/v1/scrape", {
      method: "POST",
      body: JSON.stringify({
        // A consulta inteira vai no keyword: o engine não geocodifica o texto de
        // `location` por nós, e o formato é o dos exemplos dele ("cafes in athens").
        keyword: `${input.niche} em ${input.location}`,
        lang: "pt-BR",
        max_depth: 1,
        timeout: 300,
      }),
    });
    const corpo = (await resposta.json()) as CorpoDoJob;
    if (typeof corpo?.job_id !== "string" || !corpo.job_id)
      throw new ProspectingError(
        "O engine de busca local aceitou a busca mas não devolveu o identificador da execução.",
        502,
      );
    // Sem custo por lugar: o engine é da casa. O campo existe para a campanha
    // continuar guardando a MESMA forma de execução de sempre.
    return {
      id: corpo.job_id,
      status: estado(corpo),
      defaultDatasetId: corpo.job_id,
      usageTotalUsd: 0,
    };
  },
  async readSearch(_url, id: string): Promise<DadosDaExecucao> {
    const base = await baseDoEngineDaInstalacao();
    const corpo = await corpoDoJob(base, id);
    return {
      id: corpo.job_id as string,
      status: estado(corpo),
      // Os resultados vêm NO PRÓPRIO job (não há dataset separado como na Apify),
      // então o conjunto é o id da execução — mesma forma de `DadosDaExecucao`.
      defaultDatasetId: corpo.job_id as string,
      usageTotalUsd: 0,
    };
  },
  async readResults(_url, dataset: string, limit: number): Promise<Record<string, unknown>[]> {
    const base = await baseDoEngineDaInstalacao();
    const corpo = await corpoDoJob(base, dataset);
    const itens = Array.isArray(corpo.results) ? corpo.results : [];
    return itens
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .slice(0, limit);
  },
};

/**
 * A régua de credencial deste provedor: o HEALTH CHECK do engine DA INSTALAÇÃO.
 * É o que `configureCredential` (`store.ts`) pergunta antes de qualquer busca —
 * a mesma pergunta que a Apify responde em `users/me`, só que aqui é "você é um
 * engine de verdade e está no ar?" contra a URL da instalação. O valor recebido
 * (`_chave`) é IGNORADO: não há segredo por organização nesta fatia.
 */
export async function validarCredencialLocalHttp(_chave: string): Promise<void> {
  const base = await baseDoEngineDaInstalacao();
  const resposta = await pedir(base, "/api/v1/health");
  let corpo: { status?: unknown };
  try {
    corpo = (await resposta.json()) as { status?: unknown };
  } catch {
    throw new ProspectingError(
      `O engine de busca local em ${base} respondeu ao health check com um corpo ilegível.`,
      502,
    );
  }
  if (corpo?.status !== "ok")
    throw new ProspectingError(
      `O engine de busca local em ${base} não confirmou o health check. Confira PROSPECTING_LOCAL_HTTP_URL.`,
      502,
    );
}
