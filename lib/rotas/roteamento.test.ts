import { describe, expect, it } from "vitest";

import { formatarDistancia, formatarDuracao, haversineM, ordenarPorDistanciaDaOrigem, vizinhoMaisProximo } from "./roteamento";

describe("roteamento", () => {
  it("haversine mede Canoinhas–Três Barras na ordem de grandeza certa", () => {
    const m = haversineM({ lat: -26.1775, lng: -50.3907 }, { lat: -26.1066, lng: -50.3216 });
    expect(m).toBeGreaterThan(8000);
    expect(m).toBeLessThan(15000);
  });

  it("vizinho-mais-próximo fixa a origem e visita todos uma vez", () => {
    const ordem = vizinhoMaisProximo(
      [
        { lat: 0, lng: 0 },
        { lat: 10, lng: 0 },
        { lat: 1, lng: 0 },
      ],
      false,
    );
    expect(ordem).toEqual([0, 2, 1]);
  });

  it("retornar fecha o ciclo na origem", () => {
    const ordem = vizinhoMaisProximo(
      [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 0 },
      ],
      true,
    );
    expect(ordem).toEqual([0, 1, 0]);
  });

  it("radial: do mais perto ao mais longe da base", () => {
    const ordem = ordenarPorDistanciaDaOrigem(
      [
        { lat: 0, lng: 0 },
        { lat: 10, lng: 0 },
        { lat: 1, lng: 0 },
        { lat: 5, lng: 0 },
      ],
      false,
    );
    expect(ordem).toEqual([0, 2, 3, 1]);
  });

  it("fala como gente: km e horas", () => {
    expect(formatarDistancia(42800)).toBe("42,8 km");
    expect(formatarDistancia(800)).toBe("800 m");
    expect(formatarDuracao(5520)).toBe("1h32");
    expect(formatarDuracao(480)).toBe("8 min");
  });
});
