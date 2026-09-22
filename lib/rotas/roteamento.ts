/**
 * O PROVEDOR DE ROTEAMENTO — Leaflet desenha, o provedor calcula.
 *
 * A interface existe para o cálculo não ficar acoplado a um serviço: hoje
 * OSRM (ruas de verdade, sem chave), amanhã GraphHopper/ORS/Google sem tocar
 * a rota nem a tela. Quem chama nunca distingue "rua" de "fallback": a
 * proposta carrega o `provedor` e a tela mostra quando NÃO é rua (§54).
 */

export interface Coordenada {
  lat: number;
  lng: number;
}

export interface PropostaDeRota {
  /** Ordem dos índices de entrada (0 = origem quando incluída). */
  ordem: number[];
  distanciaM: number;
  duracaoS: number;
  /** GeoJSON LineString ([lng,lat]) para desenhar — vazio no fallback. */
  geometria: number[][];
  provedor: string;
  ruas: boolean;
}

export interface RoutingProvider {
  readonly nome: string;
  /** Rota pelas ruas entre pontos NA ORDEM dada. */
  rota(pontos: Coordenada[]): Promise<PropostaDeRota>;
  /**
   * Melhor sequência (origem fixa no índice 0; `retornar` fecha o ciclo).
   * O provedor que não otimiza devolve a ordem de entrada com ruas=false.
   */
  otimizar(pontos: Coordenada[], retornar: boolean): Promise<PropostaDeRota>;
}

/** Haversine em metros — o fallback honesto quando a rua está fora do ar. */
export function haversineM(a: Coordenada, b: Coordenada): number {
  const r = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(s));
}

/**
 * Ordem radial a partir da origem (índice 0): do mais perto ao mais longe
 * da base, em linha reta. É a ordem que o dono da loja espera no romaneio
 * ("sai e vai entregando") — transparente e previsível. Não é o caminho
 * mais curto possível (esse é o TSP); é o mais legível.
 */
export function ordenarPorDistanciaDaOrigem(pontos: Coordenada[], retornar: boolean): number[] {
  if (pontos.length <= 1) return pontos.map((_, i) => i);
  const origem = pontos[0]!;
  const resto = pontos
    .slice(1)
    .map((p, k) => ({ i: k + 1, d: haversineM(origem, p) }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.i);
  const ordem = [0, ...resto];
  if (retornar) ordem.push(0);
  return ordem;
}
/**
 * Vizinho mais próximo a partir da origem (índice 0). Não é ótimo — é o
 * plano B documentado quando o OSRM não responde (§54): melhor que a ordem
 * de digitação, pior que a rua, e a tela diz qual é.
 */
export function vizinhoMaisProximo(pontos: Coordenada[], retornar: boolean): number[] {
  if (pontos.length <= 1) return pontos.map((_, i) => i);
  const restantes = new Set(pontos.slice(1).map((_, k) => k + 1));
  const ordem = [0];
  let atual = 0;
  while (restantes.size > 0) {
    let melhor = -1;
    let melhorD = Infinity;
    for (const cand of restantes) {
      const d = haversineM(pontos[atual]!, pontos[cand]!);
      if (d < melhorD) {
        melhorD = d;
        melhor = cand;
      }
    }
    ordem.push(melhor);
    restantes.delete(melhor);
    atual = melhor;
  }
  if (retornar) ordem.push(0);
  return ordem;
}

/** "42,8 km" / "1h32" — o resumo da rota fala como gente. */
export function formatarDistancia(metros: number): string {
  if (metros < 1000) return `${Math.round(metros)} m`;
  return `${(metros / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} km`;
}

export function formatarDuracao(segundos: number): string {
  const min = Math.round(segundos / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r === 0 ? `${h}h` : `${h}h${String(r).padStart(2, "0")}`;
}
