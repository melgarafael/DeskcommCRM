/**
 * OSRM — o provedor padrão (ruas de verdade, sem chave, sem fatura).
 *
 * `route` desenha pelas ruas; `trip` resolve o caixeiro-viajante (origem
 * fixa com `source=first`, destino conforme `retornar`). `OSRM_URL` troca o
 * servidor sem código (padrão: demo pública — ritmo justo, retry curto).
 * Fora do ar? Quem chama cai no vizinho-mais-próximo com `ruas=false`.
 */

import {
  haversineM,
  vizinhoMaisProximo,
  type Coordenada,
  type PropostaDeRota,
  type RoutingProvider,
} from "./roteamento";

export type { Coordenada } from "./roteamento";

const PADRAO = "https://router.project-osrm.org";

function base(): string {
  return (process.env.OSRM_URL ?? PADRAO).trim().replace(/\/+$/, "") || PADRAO;
}

function par(p: Coordenada): string {
  return `${p.lng},${p.lat}`;
}

async function getJson(url: string, timeoutMs = 20000): Promise<unknown> {
  const controle = new AbortController();
  const limite = setTimeout(() => controle.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "DeskcommCRM-Rotas/1.0", Accept: "application/json" },
      signal: controle.signal,
    });
    if (!res.ok) throw new Error(`osrm_${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(limite);
  }
}

export class OsmrmProvider implements RoutingProvider {
  readonly nome = "osrm";

  async rota(pontos: Coordenada[]): Promise<PropostaDeRota> {
    if (pontos.length < 2) {
      return { ordem: pontos.map((_, i) => i), distanciaM: 0, duracaoS: 0, geometria: [], provedor: this.nome, ruas: false };
    }
    const j = (await getJson(
      `${base()}/route/v1/driving/${pontos.map(par).join(";")}?overview=full&geometries=geojson`,
    )) as { code?: string; routes?: { distance?: number; duration?: number; geometry?: { coordinates?: number[][] } }[] };
    const r = j.routes?.[0];
    if (j.code !== "Ok" || !r) throw new Error("osrm_sem_rota");
    return {
      ordem: pontos.map((_, i) => i),
      distanciaM: Math.round(r.distance ?? 0),
      duracaoS: Math.round(r.duration ?? 0),
      geometria: r.geometry?.coordinates ?? [],
      provedor: this.nome,
      ruas: true,
    };
  }

  async otimizar(pontos: Coordenada[], retornar: boolean): Promise<PropostaDeRota> {
    if (pontos.length <= 2) return this.rota(pontos);
    const j = (await getJson(
      `${base()}/trip/v1/driving/${pontos.map(par).join(";")}?overview=full&geometries=geojson&source=first&destination=${retornar ? "any" : "last"}&roundtrip=${retornar ? "true" : "false"}`,
      30000,
    )) as {
      code?: string;
      trips?: { distance?: number; duration?: number; geometry?: { coordinates?: number[][] } }[];
      waypoints?: { waypoint_index?: number }[];
    };
    const t = j.trips?.[0];
    // O trip devolve waypoints na ordem visitada; waypoint_index aponta a
    // posição original. Sem isso, a "otimização" seria enfeite.
    const ordem = (j.waypoints ?? []).map((w) => Number(w.waypoint_index ?? 0));
    if (j.code !== "Ok" || !t || ordem.length !== pontos.length) throw new Error("osrm_sem_trip");
    const seq = retornar ? [...ordem, 0] : ordem;
    return {
      ordem: seq,
      distanciaM: Math.round(t.distance ?? 0),
      duracaoS: Math.round(t.duration ?? 0),
      geometria: t.geometry?.coordinates ?? [],
      provedor: this.nome,
      ruas: true,
    };
  }
}

/**
 * Otimiza com rua; sem rua, vizinho-mais-próximo honesto. Nunca joga erro
 * para a tela sem antes tentar o plano B — e diz qual valeu.
 */
export async function otimizarComFallback(
  provedor: RoutingProvider,
  pontos: Coordenada[],
  retornar: boolean,
): Promise<PropostaDeRota> {
  try {
    return await provedor.otimizar(pontos, retornar);
  } catch {
    const ordem = vizinhoMaisProximo(pontos, retornar);
    let distanciaM = 0;
    for (let i = 1; i < ordem.length; i++) {
      distanciaM += haversineM(pontos[ordem[i - 1]!]!, pontos[ordem[i]!]!);
    }
    // Linha reta × rua: distância em linha subestima (~×1.3 em malha urbana).
    // Dizer "12 km" quando serão 16 é a falsa informação que a spec proíbe —
    // por isso o fator declarado E o selo de estimativa na tela.
    distanciaM = Math.round(distanciaM * 1.3);
    return {
      ordem,
      distanciaM,
      duracaoS: Math.round((distanciaM / 1000 / 30) * 3600),
      geometria: [],
      provedor: "local",
      ruas: false,
    };
  }
}
