/**
 * O NOME do anúncio, do conjunto e da campanha — a partir do id do anúncio.
 *
 * Irmão de `insights.ts`, e pelo mesmo motivo que ele existe separado: tudo que
 * sabe o formato do fio mora nesta pasta, e some daqui para dentro se a
 * plataforma mudar. A diferença é a pergunta: `insights.ts` lê MÉTRICA de um
 * período; aqui se lê IDENTIDADE, que não tem período nenhum.
 *
 * ─── Por que uma chamada só, e não três ─────────────────────────────────────
 *
 * A expansão de campo (`adset{id,name}`) traz o pai e o avô no mesmo `GET` do
 * anúncio. Três chamadas encadeadas — anúncio, depois conjunto, depois campanha
 * — custariam o triplo da cota para responder a mesma pergunta, e a conta desta
 * instalação opera no degrau `development_access`, medido (ver o cabeçalho de
 * `insights.ts`). Cota é o recurso escasso aqui, não latência.
 *
 * ─── O campo pedido é CONSERVADOR, de propósito ─────────────────────────────
 *
 * Achado 2 do cabeçalho de `insights.ts`, medido contra a API viva: nome
 * inválido em `fields` devolve erro 100 e derruba a resposta INTEIRA — não é um
 * campo omitido, é a chamada perdida. `name`, `adset` e `campaign` são os três
 * nomes mais antigos e estáveis do objeto de anúncio. Acrescentar qualquer coisa
 * aqui exige sondar contra a conta viva antes, nunca contra a documentação.
 *
 * ─── Cota é TRANSITÓRIA, e a diferença importa ──────────────────────────────
 *
 * O 613 (e a família 80000) significa "pergunte de novo mais tarde", não "este
 * anúncio não existe". Tratar os dois como a mesma coisa gravaria um vazio
 * permanente no cache por causa de uma espera de minutos — e a ficha do contato
 * passaria a mentir para sempre sobre um anúncio que está lá. Quem decide o que
 * cachear é o chamador, e é por isso que a falha sai CLASSIFICADA daqui, pela
 * mesma `classificarErroGraph` que a tela de campanhas já usa.
 */
import { logger } from "@/lib/logger";
import type { ResultadoDeLeitura } from "../types";
import { classificarErroGraph, montarUrl } from "./insights";

const TEMPO_LIMITE_MS = 20_000;

/**
 * Os três nomes, e nada mais.
 *
 * `id` não é pedido para o anúncio: já o temos: é o que se usou para chamar.
 */
const CAMPOS = "name,adset{id,name},campaign{id,name}";

/** A forma do objeto de anúncio no fio — só o pedaço que se pediu. */
interface AnuncioCru {
  name?: string;
  adset?: { id?: string; name?: string };
  campaign?: { id?: string; name?: string };
}

interface ErroGraph {
  error?: { code?: number; message?: string };
}

/** A hierarquia, no vocabulário da casa. Campo ausente é `null`, nunca `""`. */
export interface HierarquiaDoAnuncio {
  adId: string;
  adName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
}

const texto = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

export async function lerHierarquiaDoAnuncio(
  token: string,
  adId: string,
): Promise<ResultadoDeLeitura<HierarquiaDoAnuncio>> {
  const url = montarUrl(encodeURIComponent(adId), { fields: CAMPOS });

  let resposta: Response;
  try {
    resposta = await fetch(url, {
      method: "GET",
      // O token vai no HEADER, nunca na query: mesma regra de `insights.ts` e do
      // anti-pattern 12 — token em URL vaza para log de proxy e breadcrumb.
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
  } catch (erro) {
    return {
      ok: false,
      falha: "transitorio",
      detalhe: erro instanceof Error ? erro.message : "falha de rede",
    };
  }

  const corpo = await resposta.text().catch(() => "");

  if (!resposta.ok) {
    let codigo: number | null = null;
    let mensagem = corpo.slice(0, 400);
    try {
      const json = JSON.parse(corpo) as ErroGraph;
      if (typeof json.error?.code === "number") codigo = json.error.code;
      if (json.error?.message) mensagem = json.error.message;
    } catch {
      // Corpo não-JSON num erro é gateway/WAF no meio. Fica o texto cru.
    }
    const falha = classificarErroGraph(resposta.status, codigo);
    // O id do anúncio entra no log; o token, nunca — nem a `url`, que carrega o
    // id e nada mais, mas cujo hábito de registrar é o que vaza o token no dia
    // em que alguém mover o segredo para a query.
    logger.warn("[ads.meta.hierarquia] leitura recusada", {
      ad_id: adId,
      status: resposta.status,
      codigo,
      falha,
    });
    return { ok: false, falha, detalhe: mensagem };
  }

  let json: AnuncioCru;
  try {
    json = JSON.parse(corpo) as AnuncioCru;
  } catch {
    return { ok: false, falha: "transitorio", detalhe: "resposta ilegível da plataforma" };
  }

  return {
    ok: true,
    dados: {
      adId,
      adName: texto(json.name),
      adsetId: texto(json.adset?.id),
      adsetName: texto(json.adset?.name),
      campaignId: texto(json.campaign?.id),
      campaignName: texto(json.campaign?.name),
    },
  };
}
