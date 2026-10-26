import { describe, expect, it } from "vitest";

import {
  dataDeAssinadoEPago,
  idDoWhatsapp,
  nomeDoGrupo,
  preencherModelo,
  situacaoVisivel,
  validadeDaProposta,
} from "@/lib/agencia/contratos/regras";

/** As regras puras da Fase 6 (docs/agencia/SPEC-contratos.md). */

describe("preencher o modelo (K1)", () => {
  it("troca os campos e aponta o que falta e o que não existe", () => {
    const r = preencherModelo("CONTRATANTE: {{cliente.razao_social}}, CNPJ {{ cliente.cnpj }}. Valor {{contrato.valor_mensal}}. {{cliente.apelido}}", {
      "cliente.razao_social": "Turbo Kids Ltda",
      "cliente.cnpj": "",
      "contrato.valor_mensal": "R$ 2.500,00",
    });
    expect(r.texto).toBe("CONTRATANTE: Turbo Kids Ltda, CNPJ [FALTA: CNPJ]. Valor R$ 2.500,00. [CAMPO DESCONHECIDO: cliente.apelido]");
    expect(r.faltando).toEqual(["CNPJ"]);
    expect(r.desconhecidos).toEqual(["cliente.apelido"]);
  });
});

describe("validade e situação (K6)", () => {
  it("a proposta vale 5 dias depois do Fechamento", () => {
    expect(validadeDaProposta("2026-10-30")).toBe("2026-11-04");
  });

  it("assinado sem pago, pago sem assinado, vencida e concluído", () => {
    const base = { situacao: "enviado", assinado_em: null, pago_em: null, valido_ate: "2026-11-04" };
    expect(situacaoVisivel(base, "2026-11-01")).toBe("aguardando");
    expect(situacaoVisivel({ ...base, assinado_em: "2026-11-02T10:00:00Z" }, "2026-11-02")).toBe("assinado");
    expect(situacaoVisivel({ ...base, pago_em: "2026-11-02T10:00:00Z" }, "2026-11-02")).toBe("pago");
    expect(situacaoVisivel(base, "2026-11-05")).toBe("vencido");
    expect(situacaoVisivel({ ...base, situacao: "concluido" }, "2026-12-01")).toBe("concluido");
    expect(situacaoVisivel({ ...base, situacao: "rascunho" }, "2026-11-01")).toBe("rascunho");
  });

  it("a data que conta é a última das duas", () => {
    expect(dataDeAssinadoEPago("2026-11-02T10:00:00Z", "2026-11-03T09:00:00Z")).toBe("2026-11-03T09:00:00Z");
    expect(dataDeAssinadoEPago("2026-11-04T10:00:00Z", "2026-11-03T09:00:00Z")).toBe("2026-11-04T10:00:00Z");
    expect(dataDeAssinadoEPago("2026-11-04T10:00:00Z", null)).toBeNull();
  });
});

describe("o grupo (D10)", () => {
  it("nome e participantes", () => {
    expect(nomeDoGrupo("Em Movimento", "Turbo Kids")).toBe("Em Movimento - Turbo Kids");
    expect(idDoWhatsapp("+5511999990000")).toBe("5511999990000@c.us");
    expect(idDoWhatsapp("123")).toBeNull();
  });
});
