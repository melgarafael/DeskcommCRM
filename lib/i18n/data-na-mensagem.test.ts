/**
 * A CAMADA DE DATA DA MENSAGEM (#4339), medida sozinha.
 *
 * O teste do interpolador (`lib/automation/data-na-mensagem.test.ts`) prova o
 * que o cliente lê; este prova a RÉGUA que ele usa: ordem dos campos por
 * idioma, formato explícito, valor inválido intacto e a virada de dia no fuso
 * da organização. Separar as duas coisas é o que permite reprovar uma sem
 * duvidar da outra quando o formato mudar.
 */
import { describe, expect, it } from "vitest";

import { formatarValorComModificadorDeData } from "@/lib/i18n/data-na-mensagem";

const PT = { idioma: "pt-BR", fuso: "America/Sao_Paulo" };
const ES = { idioma: "es", fuso: "America/Sao_Paulo" };
const EN = { idioma: "en-US", fuso: "America/Sao_Paulo" };

describe("ordem dos campos por idioma", () => {
  it("pt-BR e es escrevem dia antes do mês; en-US escreve mês antes do dia", () => {
    expect(formatarValorComModificadorDeData("2026-11-16", "data", PT)).toBe("16/11/2026");
    expect(formatarValorComModificadorDeData("2026-11-16", "data", ES)).toBe("16/11/2026");
    expect(formatarValorComModificadorDeData("2026-11-16", "data", EN)).toBe("11/16/2026");
  });

  it("idioma que o produto não serve cai no padrão em vez de lançar", () => {
    expect(
      formatarValorComModificadorDeData("2026-11-16", "data", { idioma: "klingon", fuso: "UTC" }),
    ).toBe("16/11/2026");
    expect(formatarValorComModificadorDeData("2026-11-16", "data", { idioma: "", fuso: "UTC" })).toBe(
      "16/11/2026",
    );
  });
});

describe("formato explícito", () => {
  it("aceita os separadores barra, hífen e ponto", () => {
    expect(formatarValorComModificadorDeData("2026-11-16", "data:dd/mm/aaaa", PT)).toBe("16/11/2026");
    expect(formatarValorComModificadorDeData("2026-11-16", "data:dd-mm-aaaa", PT)).toBe("16-11-2026");
    expect(formatarValorComModificadorDeData("2026-11-16", "data:dd.mm.aaaa", PT)).toBe("16.11.2026");
    expect(formatarValorComModificadorDeData("2026-11-16", "data:aaaa-mm-dd", PT)).toBe("2026-11-16");
  });

  it("não se mistura separador dentro do mesmo formato", () => {
    expect(formatarValorComModificadorDeData("2026-11-16", "data:dd/mm-aaaa", PT)).toBe("2026-11-16");
  });

  it("formato que não se entende devolve o valor intacto", () => {
    expect(formatarValorComModificadorDeData("2026-11-16", "data:xx/yy", PT)).toBe("2026-11-16");
    expect(formatarValorComModificadorDeData("2026-11-16", "data:mm/mm/aaaa", PT)).toBe("2026-11-16");
  });

  it("modificador que não é data não formata nada", () => {
    expect(formatarValorComModificadorDeData("2026-11-16", "maiusculo", PT)).toBe("2026-11-16");
  });
});

describe("valor que não é data ISO", () => {
  it.each(["amanhã", "16/11/2026", "16-11-2026", "", "  ", "2026-11", "2026-02-31", "2026-13-01"])(
    "%s sai intacto",
    (valor) => {
      expect(formatarValorComModificadorDeData(valor, "data", PT)).toBe(valor);
    },
  );
});

describe("fuso da organização", () => {
  it("23:30 em São Paulo é o dia ANTERIOR em UTC — e o fuso manda", () => {
    const instante = "2026-11-17T02:30:00Z";
    expect(formatarValorComModificadorDeData(instante, "data", PT)).toBe("16/11/2026");
    expect(formatarValorComModificadorDeData(instante, "data", { ...PT, fuso: "UTC" })).toBe(
      "17/11/2026",
    );
  });

  it("respeita o deslocamento escrito no próprio valor", () => {
    expect(formatarValorComModificadorDeData("2026-11-16T23:30:00-03:00", "data", PT)).toBe(
      "16/11/2026",
    );
  });

  it("hora de parede sem fuso é o próprio dia", () => {
    expect(formatarValorComModificadorDeData("2026-11-16T12:00:00", "data", PT)).toBe("16/11/2026");
  });

  it("fuso inválido não derruba a mensagem (degrada no padrão)", () => {
    expect(
      formatarValorComModificadorDeData("2026-11-17T02:30:00Z", "data", {
        idioma: "pt-BR",
        fuso: "America/São_Paulo",
      }),
    ).toBe("16/11/2026");
  });

  it("o segundo e a fração de segundo não atrapalham a leitura", () => {
    expect(formatarValorComModificadorDeData("2026-11-16T12:00:00.123Z", "data", PT)).toBe(
      "16/11/2026",
    );
  });
});
