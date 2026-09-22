/**
 * GEOGRAFIA DA PROSPECÇÃO — matemática pura (distância, cluster, rota).
 *
 * Sem dependência de mapa: estas funções decidem O QUÊ desenhar; o Leaflet
 * só desenha. Testadas sem browser.
 */

export interface PontoGeo {
  id: string;
  latitude: number;
  longitude: number;
}

const RAIO_TERRA_KM = 6371;

/** Distância haversiana em km (arredondada a 100m). */
export function distanciaKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * RAIO_TERRA_KM * Math.asin(Math.sqrt(h)) * 10) / 10;
}

export interface Cluster<T extends PontoGeo> {
  id: string;
  latitude: number;
  longitude: number;
  pontos: T[];
}

/**
 * Cluster por grade: célula em graus ≈ 360 / 2^zoom / 4. Determinístico e
 * barato — O(n). Célula unitária vira ponto solto (sem cluster de 1).
 */
export function clusterizar<T extends PontoGeo>(pontos: T[], zoom: number): (Cluster<T> | T)[] {
  const passo = 360 / 2 ** Math.max(1, Math.min(19, Math.round(zoom))) / 4;
  const celulas = new Map<string, T[]>();
  for (const p of pontos) {
    const chave = `${Math.floor(p.latitude / passo)}:${Math.floor(p.longitude / passo)}`;
    const lista = celulas.get(chave) ?? [];
    lista.push(p);
    celulas.set(chave, lista);
  }
  const saida: (Cluster<T> | T)[] = [];
  for (const [chave, lista] of celulas) {
    if (lista.length === 1) {
      saida.push(lista[0] as T);
      continue;
    }
    const lat = lista.reduce((a, p) => a + p.latitude, 0) / lista.length;
    const lng = lista.reduce((a, p) => a + p.longitude, 0) / lista.length;
    saida.push({ id: `cluster:${chave}`, latitude: lat, longitude: lng, pontos: lista });
  }
  return saida;
}

export function ehCluster<T extends PontoGeo>(item: Cluster<T> | T): item is Cluster<T> {
  return (item as Cluster<T>).pontos !== undefined;
}

/**
 * Ordem de visita (vizinho mais próximo a partir do primeiro selecionado).
 * Heurística honesta de roteirização — não é TSP ótimo e não finge ser.
 */
export function ordemDeVisita<T extends PontoGeo>(pontos: T[]): T[] {
  if (pontos.length <= 2) return [...pontos];
  const resto = [...pontos];
  const rota: T[] = [resto.shift() as T];
  while (resto.length > 0) {
    const atual = rota[rota.length - 1] as T;
    let melhor = 0;
    let melhorDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < resto.length; i++) {
      const cand = resto[i] as T;
      const d = distanciaKm(atual.latitude, atual.longitude, cand.latitude, cand.longitude);
      if (d < melhorDist) {
        melhorDist = d;
        melhor = i;
      }
    }
    rota.push((resto.splice(melhor, 1) as T[])[0] as T);
  }
  return rota;
}

/** Comprimento total da rota em km. */
export function comprimentoDaRota<T extends PontoGeo>(rota: T[]): number {
  let total = 0;
  for (let i = 1; i < rota.length; i++) {
    const a = rota[i - 1] as T;
    const b = rota[i] as T;
    total += distanciaKm(a.latitude, a.longitude, b.latitude, b.longitude);
  }
  return Math.round(total * 10) / 10;
}

export interface Limites {
  sul: number;
  oeste: number;
  norte: number;
  leste: number;
}

/** Bounding box de um conjunto de pontos (null sem ponto válido). */
export function limitesDosPontos<T extends PontoGeo>(pontos: T[]): Limites | null {
  if (pontos.length === 0) return null;
  let sul = 90;
  let norte = -90;
  let oeste = 180;
  let leste = -180;
  for (const p of pontos) {
    if (p.latitude < sul) sul = p.latitude;
    if (p.latitude > norte) norte = p.latitude;
    if (p.longitude < oeste) oeste = p.longitude;
    if (p.longitude > leste) leste = p.longitude;
  }
  return { sul, oeste, norte, leste };
}

/** Centro + raio (km) que cobre o bbox — base do "buscar nesta área". */
export function centroERaioDoBbox(limites: Limites): { latitude: number; longitude: number; raioKm: number } {
  const latitude = (limites.sul + limites.norte) / 2;
  const longitude = (limites.oeste + limites.leste) / 2;
  const raioKm = Math.max(
    1,
    Math.ceil(distanciaKm(limites.sul, limites.oeste, limites.norte, limites.leste) / 2),
  );
  return { latitude, longitude, raioKm };
}
