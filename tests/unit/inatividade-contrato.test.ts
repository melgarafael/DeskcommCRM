import { describe, expect, it } from "vitest";

import {
  classificarInativo,
  faixaDeInatividade,
  linkWhatsAppRecuperacao,
  scoreDeRecuperacao,
} from "@/lib/comercial/inatividade";

/**
 * A REGRA DE INATIVIDADE — cerca do ATT.txt Fase 4.
 */
describe("faixaDeInatividade", () => {
  it("90+ é frio, 60+ é morno, resto é atenção", () => {
    expect(faixaDeInatividade(120)).toBe("frio");
    expect(faixaDeInatividade(90)).toBe("frio");
    expect(faixaDeInatividade(89)).toBe("morno");
    expect(faixaDeInatividade(60)).toBe("morno");
    expect(faixaDeInatividade(59)).toBe("atencao");
  });
});

describe("scoreDeRecuperacao", () => {
  it("bom cliente recente pontua alto", () => {
    // 30 dias, R$ 5.000, 10 pedidos = 55 + 25 + 15 = 95
    expect(scoreDeRecuperacao(30, 500000, 10)).toBe(95);
  });

  it("cliente fraco e antigo pontua baixo", () => {
    expect(scoreDeRecuperacao(300, 1000, 1)).toBeLessThan(20);
  });

  it("nunca passa de 100 nem fica negativo", () => {
    expect(scoreDeRecuperacao(0, 99999999, 999)).toBe(100);
    expect(scoreDeRecuperacao(9999, 0, 0)).toBe(0);
  });
});

describe("classificarInativo", () => {
  it("junta tudo num registro", () => {
    const c = classificarInativo(
      { contact_id: "x", nome: "Mercado", telefone: "+5511912345678" },
      70,
      200000,
      4,
    );
    expect(c.faixa).toBe("morno");
    expect(c.score).toBeGreaterThan(0);
  });
});

describe("linkWhatsAppRecuperacao", () => {
  it("monta wa.me com mensagem", () => {
    const link = linkWhatsAppRecuperacao("+55 11 91234-5678", "Mercado", 70);
    expect(link).toContain("https://wa.me/5511912345678?text=");
    expect(link).toContain(encodeURIComponent("70 dias"));
  });

  it("sem telefone não há link", () => {
    expect(linkWhatsAppRecuperacao(null, "X", 70)).toBeNull();
    expect(linkWhatsAppRecuperacao("123", "X", 70)).toBeNull();
  });
});
