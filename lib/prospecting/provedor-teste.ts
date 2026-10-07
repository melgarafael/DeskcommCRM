/**
 * F5 da #1758 — O PROVEDOR DE TESTE: determinístico, local, sem rede.
 *
 * ─── POR QUE ELE EXISTE ────────────────────────────────────────────────────
 *
 * Antes desta fatia, o caminho da busca só podia ser coberto de duas formas:
 * batendo na Apify (gasta crédito real do time) ou não cobrindo. Com a
 * interface separada (`ProvedorDeBusca`), um provedor local permite rodar os
 * testes de prospecção do CI sem gastar crédito da Apify e sem depender de
 * rede externa — é literalmente o que a issue pede em F5.
 *
 * ─── DETERMINISMO, NÃO ALEATORIEDADE ───────────────────────────────────────
 *
 * Nada aqui lê `Date`, `Math.random` ou rede. A execução codifica a BUSCA
 * dentro do próprio id (`teste:<base64url>`), e é dela que `readSearch` e
 * `readResults` reconstroem os resultados — mesma entrada, mesma saída, em
 * qualquer máquina e em qualquer ordem. Sem estado também: não há servidor
 * onde memorizar a busca, então o id é a memória.
 *
 * Os itens saem no formato que `normalizeProspect()` (`schema.ts:57`) já
 * entende — os nomes do Google Maps. O tradutor por provedor é a F3, fora do
 * escopo desta fatia; até lá, o provedor de teste fala a língua do normalizador
 * da casa em vez de inventar uma segunda.
 */
import { ProspectingError } from "./provider";
import type { ProvedorDeBusca } from "./provedor";
import type { SearchInput } from "./schema";

const MARCA = "teste:";

interface BuscaCodificada {
  niche: string;
  location: string;
  limit: number;
}

function codificar(input: SearchInput): string {
  const carga: BuscaCodificada = {
    niche: input.niche,
    location: input.location,
    limit: input.limit,
  };
  return MARCA + Buffer.from(JSON.stringify(carga), "utf8").toString("base64url");
}

function decodificar(id: string, natureza: string): BuscaCodificada {
  if (!id.startsWith(MARCA))
    // FECHADO, como o padrão de `provider.ts`: um id que não é deste provedor
    // é configuração/estado errado, e seguir mascararia o problema.
    throw new ProspectingError(`Busca de teste desconhecida: ${natureza} não é deste provedor.`);
  try {
    const carga = JSON.parse(Buffer.from(id.slice(MARCA.length), "base64url").toString("utf8"));
    if (
      typeof carga?.niche === "string" &&
      typeof carga?.location === "string" &&
      typeof carga?.limit === "number"
    )
      return carga as BuscaCodificada;
  } catch {
    // cai no erro de baixo: id malformado é a mesma história que id desconhecido
  }
  throw new ProspectingError(`Busca de teste ilegível: ${natureza} corrompido.`);
}

/**
 * Empresas fictícias, estáveis e contáveis: `limit` itens, sempre os mesmos,
 * sempre no mesmo ordem. O telefone é brasileiro de propósito — é o único
 * formato que `normalizeProspect()` aceita sem inventar número estrangeiro.
 */
function itens(carga: BuscaCodificada): Record<string, unknown>[] {
  const total = Math.min(carga.limit, 100);
  return Array.from({ length: total }, (_, i) => ({
    title: `${carga.niche} ${carga.location} ${i + 1}`.slice(0, 200),
    placeId: `${carga.niche}-${carga.location}-${i + 1}`.slice(0, 200),
    phone: `(11) 9999${String(i % 10)}-${String(1000 + i).slice(-4)}`,
    categoryName: carga.niche,
    address: `${carga.location}, ${i + 1}`,
    url: `https://exemplo.test/${i + 1}`,
    website: `https://exemplo.test/${i + 1}`,
    totalScore: 4.5,
    reviewsCount: i,
    permanentlyClosed: false,
  }));
}

export const provedorDeTeste: ProvedorDeBusca = {
  async startSearch(_chave, input) {
    const id = codificar(input);
    // Mesma forma que a Apify devolve: a campanha guarda id, dataset e custo
    // (zero — este provedor não cobra) e segue com `search_status='running'`.
    return { id, status: "RUNNING", defaultDatasetId: id, usageTotalUsd: 0 };
  },
  async readSearch(_chave, id) {
    // Determinístico e síncrono de propósito: não há run para sondar. A busca
    // nasce pronta, e é assim que o CI atravessa o ciclo inteiro num tick.
    return { id, status: "SUCCEEDED", defaultDatasetId: id, usageTotalUsd: 0 };
  },
  async readResults(_chave, dataset, limit) {
    return itens({ ...decodificar(dataset, "conjunto"), limit }).slice(0, limit);
  },
};
