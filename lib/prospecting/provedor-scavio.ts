/**
 * #1758 — O PROVEDOR `scavio`: lugares do Google Maps pela API da Scavio.
 *
 * ─── O QUE ELE RESOLVE ─────────────────────────────────────────────────────
 *
 * É a classe 1 da #1758: "um provedor de dados por API que a organização já
 * usa". A organização escolhe `scavio` em `settings.prospecting.provider` e
 * salva a chave dela pelo MESMO `configure` de sempre — mesma coluna
 * (`prospecting_settings.credential_encrypted`), mesma cifra, mesmo
 * endereçamento por organização. Nada aqui toca em `PROVEDOR_PADRAO`, no
 * caminho da Apify ou no schema.
 *
 * ─── SÍNCRONO (F4) SEM MEXER EM `store.ts` ─────────────────────────────────
 *
 * A Scavio responde a busca na hora, página a página (20 lugares por página),
 * sem run para sondar. Como o provedor de teste, a execução codifica a BUSCA
 * no próprio id (`scavio:<base64url>`): `startSearch` não chama a rede,
 * `readSearch` devolve `SUCCEEDED` e é `readResults` — chamado UMA vez pelo
 * `synchronizeSearch` no tick seguinte — que busca as páginas. Assim o crédito
 * só é gasto quando o resultado vai ser gravado, e `store.ts`, `worker.ts` e
 * `guard.ts` não mudam.
 *
 * ─── TRADUÇÃO DE CAMPOS (F3), NA BORDA ─────────────────────────────────────
 *
 * Os lugares saem traduzidos para os nomes que `normalizeProspect()`
 * (`schema.ts`) já lê — os do Actor do Google Maps (`title`, `placeId`,
 * `phone`, `categoryName`, `totalScore`, `reviewsCount`…). O tradutor é
 * `itemDaScavio()`, puro e exportado: um segundo normalizador na casa seria
 * uma segunda verdade sobre o que é um candidato.
 *
 * ─── O QUE FICA DE FORA ────────────────────────────────────────────────────
 *
 * - `budget_usd` e `enrich` são parâmetros do Actor da Apify (teto de gasto e
 *   raspagem de contatos). Aqui o custo é fixo por página e e-mails/redes não
 *   vêm da busca; o enriquecimento de site da casa (spec 24) segue valendo.
 * - A busca vai inteira no texto (`"<nicho> em <local>"`), como no
 *   `local-http`. Sem `gl` de propósito: com `gl` e sem centro de mapa, a
 *   busca puxa para a capital do país e mistura cidades.
 * - O idioma da organização (`opcoes.idioma`, `idioma.ts`) vira o `hl` e o
 *   conectivo da busca ("em"/"en"), como a Apify recebe `language`. Id sem
 *   idioma (busca iniciada antes desta mudança) segue em português.
 */
import { IDIOMA_PADRAO, IDIOMAS, type Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";

import { ProspectingError, type OpcoesDaBusca } from "./provider";
import type { DadosDaExecucao, ProvedorDeBusca } from "./provedor";
import type { SearchInput } from "./schema";

const BASE = "https://api.scavio.dev";
/** Teto de UMA página — o mesmo da chamada à Apify em `provider.ts`. */
const TIMEOUT_MS = 25_000;
/** Lugares por página da busca de Mapas. `start` anda em múltiplos de 20. */
export const POR_PAGINA = 20;
const MARCA = "scavio:";

/**
 * O conectivo entre nicho e local, no idioma da busca. `Record<Idioma, …>`:
 * idioma novo no registro sem entrada aqui não compila.
 */
const CONECTIVO: Record<Idioma, string> = {
  "pt-BR": "em",
  es: "en",
  en: "in",
};

interface BuscaCodificada {
  niche: string;
  location: string;
  limit: number;
  /** Ausente nos ids anteriores ao idioma da organização: português. */
  idioma?: Idioma;
}

function codificar(input: SearchInput, idioma: Idioma): string {
  const carga: BuscaCodificada = {
    niche: input.niche,
    location: input.location,
    limit: input.limit,
    idioma,
  };
  return MARCA + Buffer.from(JSON.stringify(carga), "utf8").toString("base64url");
}

/**
 * FECHADO para id que não é deste provedor: é o que acontece quando a
 * organização troca de provedor com uma busca em andamento (#2174), e ler o
 * run da Apify como se fosse daqui gastaria crédito numa busca errada.
 */
function decodificar(id: string): BuscaCodificada {
  if (id.startsWith(MARCA)) {
    try {
      const carga = JSON.parse(Buffer.from(id.slice(MARCA.length), "base64url").toString("utf8"));
      if (
        typeof carga?.niche === "string" &&
        typeof carga?.location === "string" &&
        typeof carga?.limit === "number" &&
        (carga.idioma === undefined || IDIOMAS.includes(carga.idioma))
      )
        return carga as BuscaCodificada;
    } catch {
      // cai no erro de baixo: id malformado é a mesma história que id desconhecido
    }
  }
  throw new ProspectingError(
    "Esta busca não foi iniciada pela Scavio. Se o provedor da organização mudou, inicie uma nova busca.",
  );
}

/**
 * A chave da Scavio começa com `sk_`. Conferir ANTES da rede é o que impede
 * mandar a chave de OUTRO provedor (a da Apify, salva antes da troca de
 * escolha) para a Scavio: a credencial é uma coluna só por organização e
 * ainda não sabe de qual provedor é (#2174).
 */
function conferirFormato(chave: string): string {
  const limpa = chave.trim();
  if (!limpa.startsWith("sk_"))
    throw new ProspectingError(
      "A chave salva não é uma chave da Scavio. Salve a chave da Scavio na tela de prospecção.",
    );
  return limpa;
}

/** Falha de rede ou de servidor é 502, com as MESMAS frases da Apify em `provider.ts`. */
async function pedir(chave: string, caminho: string, corpo?: unknown): Promise<unknown> {
  const autorizada = conferirFormato(chave);
  let resposta: Response;
  try {
    resposta = await fetch(`${BASE}${caminho}`, {
      method: corpo === undefined ? "GET" : "POST",
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: `Bearer ${autorizada}`, "Content-Type": "application/json" },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProspectingError("A Scavio não respondeu. A próxima rodada tentará novamente.", 502);
  }
  if (!resposta.ok)
    throw new ProspectingError(
      resposta.status === 401
        ? "Chave de busca inválida."
        : resposta.status === 402
          ? "Saldo ou limite de uso insuficiente no provedor de busca."
          : `Busca indisponível (HTTP ${resposta.status}).`,
      502,
    );
  try {
    return await resposta.json();
  } catch {
    throw new ProspectingError("A Scavio respondeu com um corpo ilegível.", 502);
  }
}

/** Texto do Google para lugar fechado ("Fechado permanentemente", "Permanently closed"…). */
function fechado(estado: unknown, padrao: RegExp): boolean {
  return typeof estado === "string" && padrao.test(estado);
}

/**
 * Um lugar da Scavio nos nomes que `normalizeProspect()` já lê. Campo ausente
 * fica ausente — o normalizador já o trata como `null`. Sem `place_id` ou sem
 * título o lugar sai como veio e o normalizador o descarta, como faz com
 * qualquer item incompleto da Apify.
 */
export function itemDaScavio(lugar: Record<string, unknown>): Record<string, unknown> {
  const placeId = typeof lugar.place_id === "string" ? lugar.place_id : undefined;
  const cid =
    typeof lugar.data_cid === "string" && /^\d+$/.test(lugar.data_cid) ? lugar.data_cid : null;
  return {
    title: lugar.title,
    placeId,
    phone: lugar.phone,
    categoryName: lugar.type,
    address: lugar.address,
    // O link do lugar pelo CID numérico, no mesmo host de mapa que a casa já
    // declara (`maps.google.com`, o pino de `lib/messaging/localizacao.ts`).
    url: cid ? `https://maps.google.com/?cid=${cid}` : undefined,
    website: lugar.website,
    totalScore: lugar.rating,
    reviewsCount: lugar.reviews,
    permanentlyClosed: fechado(lugar.open_state, /permanent/i),
    temporarilyClosed: fechado(lugar.open_state, /tempor/i),
  };
}

/** Os lugares de UMA página, ou lista vazia quando a página não traz nenhum. */
function lugaresDaPagina(corpo: unknown): Record<string, unknown>[] {
  const lista = (corpo as { local_results?: unknown } | null)?.local_results;
  return Array.isArray(lista)
    ? lista.filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
    : [];
}

/**
 * As páginas necessárias para `limit` lugares (no máximo 5, porque `limit`
 * vai até 100). Para na primeira página curta: não há mais o que buscar.
 *
 * Falha na PRIMEIRA página sobe como `ProspectingError` — o worker grava o
 * motivo e tenta de novo no próximo tick. Falha numa página SEGUINTE devolve o
 * que já veio: repetir tudo gastaria de novo as páginas que deram certo, e a
 * tela já avisa que a quantidade encontrada pode ser menor que o limite.
 */
async function buscar(chave: string, carga: BuscaCodificada): Promise<Record<string, unknown>[]> {
  const idioma = carga.idioma ?? IDIOMA_PADRAO;
  const query = `${carga.niche} ${CONECTIVO[idioma]} ${carga.location}`;
  const vistos = new Set<string>();
  const itens: Record<string, unknown>[] = [];
  for (let start = 0; itens.length < carga.limit; start += POR_PAGINA) {
    let corpo: unknown;
    try {
      corpo = await pedir(chave, "/api/v2/google/maps/search", { query, hl: idioma, start });
    } catch (error) {
      if (start === 0) throw error;
      logger.warn("[prospecting] página da Scavio falhou; a busca fica com o que já veio", {
        start,
        encontrados: itens.length,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
    const lugares = lugaresDaPagina(corpo);
    for (const lugar of lugares) {
      const item = itemDaScavio(lugar);
      const chaveDoLugar = typeof item.placeId === "string" ? item.placeId : null;
      if (chaveDoLugar && vistos.has(chaveDoLugar)) continue;
      if (chaveDoLugar) vistos.add(chaveDoLugar);
      itens.push(item);
    }
    if (lugares.length < POR_PAGINA) break;
  }
  return itens.slice(0, carga.limit);
}

export const provedorScavio: ProvedorDeBusca = {
  async startSearch(
    _chave,
    input: SearchInput,
    opcoes: OpcoesDaBusca = {},
  ): Promise<DadosDaExecucao> {
    // Sem rede: a busca é síncrona e roda em `readResults`. A campanha guarda a
    // MESMA forma de execução de sempre e segue com `search_status='running'`.
    const id = codificar(input, opcoes.idioma ?? IDIOMA_PADRAO);
    return { id, status: "RUNNING", defaultDatasetId: id };
  },
  async readSearch(_chave, id: string): Promise<DadosDaExecucao> {
    decodificar(id);
    // Sem custo em dólar: a Scavio cobra em créditos, e `cost_usd` fica nulo
    // em vez de um número inventado.
    return { id, status: "SUCCEEDED", defaultDatasetId: id };
  },
  async readResults(chave, dataset: string, limit: number): Promise<Record<string, unknown>[]> {
    const carga = decodificar(dataset);
    return buscar(chave, { ...carga, limit: Math.min(limit, carga.limit, 100) });
  },
};

/**
 * A régua de credencial: `GET /api/v1/usage`, que confirma a chave sem gastar
 * crédito — a mesma pergunta que a Apify responde em `users/me`.
 */
export async function validarCredencialScavio(chave: string): Promise<void> {
  await pedir(chave, "/api/v1/usage");
}
