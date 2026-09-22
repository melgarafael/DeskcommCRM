import { describe, expect, it } from "vitest";

import { OLHARES, olharPara } from "./olhares";
import definition from "./strobi.avatar.json";

describe("olhares — o Strobi segue o mouse", () => {
  it("toda expressão da tabela existe na definição", () => {
    const ordem = definition.expressionOrder as string[];
    for (const o of OLHARES) {
      expect(ordem).toContain(o.expressao);
    }
  });

  it("cursor à direita olha para a direita", () => {
    expect(olharPara(400, 0)).toBe("far-right-glance");
  });

  it("cursor acima olha para cima-direita (o mais alto que o set tem)", () => {
    expect(olharPara(0, -400)).toBe("upward-side-glance");
  });

  it("cursor à esquerda olha para a esquerda (não trava — varia com a altura)", () => {
    const alto = olharPara(-400, -300);
    const baixo = olharPara(-400, 300);
    expect(alto).not.toBe(baixo);
  });

  it("cursor abaixo olha para baixo", () => {
    expect(olharPara(0, 400)).toBe("downward-gaze");
  });

  it("perto do avatar volta ao idle (raio morto)", () => {
    expect(olharPara(10, 10)).toBeNull();
    expect(olharPara(-50, 40)).toBeNull();
  });
});
