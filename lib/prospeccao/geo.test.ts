import { describe, expect, it } from "vitest";

import {
  centroERaioDoBbox,
  clusterizar,
  comprimentoDaRota,
  distanciaKm,
  ehCluster,
  limitesDosPontos,
  ordemDeVisita,
} from "./geo";

describe("distanciaKm", () => {
  it("Canoinhas–Três Barras ≈ 15km", () => {
    const d = distanciaKm(-26.1767, -50.39, -26.1183, -50.3242);
    expect(d).toBeGreaterThan(5);
    expect(d).toBeLessThan(25);
  });
  it("mesmo ponto zera", () => {
    expect(distanciaKm(-26.1, -50.3, -26.1, -50.3)).toBe(0);
  });
});

describe("clusterizar", () => {
  const pontos = [
    { id: "a", latitude: -26.17, longitude: -50.39 },
    { id: "b", latitude: -26.171, longitude: -50.391 },
    { id: "c", latitude: -25.0, longitude: -49.0 },
  ];
  it("agrupa vizinhos e solta o distante", () => {
    const r = clusterizar(pontos, 10);
    expect(r).toHaveLength(2);
    const cluster = r.find(ehCluster);
    expect(cluster?.pontos.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });
  it("zoom alto separa", () => {
    expect(clusterizar(pontos, 19)).toHaveLength(3);
  });
});

describe("ordemDeVisita", () => {
  it("segue o vizinho mais próximo", () => {
    const rota = ordemDeVisita([
      { id: "a", latitude: 0, longitude: 0 },
      { id: "b", latitude: 0, longitude: 10 },
      { id: "c", latitude: 0, longitude: 1 },
    ]);
    expect(rota.map((p) => p.id)).toEqual(["a", "c", "b"]);
    expect(comprimentoDaRota(rota)).toBeGreaterThan(0);
  });
});

describe("limitesDosPontos + centroERaioDoBbox", () => {
  it("bbox cobre os pontos e o raio é metade da diagonal", () => {
    const lim = limitesDosPontos([
      { id: "a", latitude: -26.2, longitude: -50.4 },
      { id: "b", latitude: -26.1, longitude: -50.3 },
    ]);
    expect(lim).toEqual({ sul: -26.2, oeste: -50.4, norte: -26.1, leste: -50.3 });
    const c = centroERaioDoBbox(lim!);
    expect(c.latitude).toBeCloseTo(-26.15, 5);
    expect(c.raioKm).toBeGreaterThanOrEqual(1);
  });
  it("vazio é null", () => {
    expect(limitesDosPontos([])).toBeNull();
  });
});
