import { describe, expect, it } from "vitest";
import { fusoUtilizavel } from "@/lib/tempo/fusos";
import { janelaDoDesempenho, datasDaJanela, diasDoPeriodo } from "./periodo-do-desempenho";

describe("janela civil do Desempenho", () => {
  it.each([
    ["2026-09-01", "America/Sao_Paulo", "2026-09-01T03:00:00.000Z", "2026-09-02T03:00:00.000Z"],
    ["2018-11-04", "America/Sao_Paulo", "2018-11-04T03:00:00.000Z", "2018-11-05T02:00:00.000Z"],
    ["2021-10-29", "Asia/Amman", "2021-10-28T21:00:00.000Z", "2021-10-29T22:00:00.000Z"],
    ["2011-12-29", "Pacific/Apia", "2011-12-29T10:00:00.000Z", "2011-12-30T10:00:00.000Z"],
  ])("converte %s em %s para a primeira hora válida dos limites", (dia, fuso, from, to) => {
    expect(janelaDoDesempenho({ de: dia, ate: dia }, fuso)).toEqual({ janela: { from, to } });
  });

  it("aceita 90 dias civis mesmo quando o relógio recua por uma hora", () => {
    const de = "2026-09-01";
    const fuso = "America/New_York";
    expect(janelaDoDesempenho({ de, ate: "2026-11-29" }, fuso)).toEqual({
      janela: { from: "2026-09-01T04:00:00.000Z", to: "2026-11-30T05:00:00.000Z" },
    });
    expect(janelaDoDesempenho({ de, ate: "2026-11-30" }, fuso)).toEqual({ erro: "limite" });
  });

  it("rejeita datas inválidas, invertidas e bordas que não formam uma janela contínua", () => {
    expect(janelaDoDesempenho({ de: "2026-02-30", ate: "2026-03-02" }, "UTC")).toEqual({ erro: "data" });
    expect(janelaDoDesempenho({ de: "2026-09-02", ate: "2026-09-01" }, "UTC")).toEqual({ erro: "ordem" });
    expect(janelaDoDesempenho({ de: "2009-11-01", ate: "2009-11-01" }, "America/St_Johns"))
      .toEqual({ erro: "fuso" });
    expect(janelaDoDesempenho({ de: "2011-12-30", ate: "2011-12-30" }, "Pacific/Apia"))
      .toEqual({ erro: "fuso" });
  });

  it.each([null, "São Paulo"])("usa a mesma reserva da série (%s)", (configurado) => {
    const dias = { de: "2026-09-01", ate: "2026-09-01" };
    expect(janelaDoDesempenho(dias, fusoUtilizavel(configurado))).toEqual(
      janelaDoDesempenho(dias, "America/Sao_Paulo"),
    );
  });

  it("nomeia o último dia incluído no CSV e conta dias civis parciais", () => {
    const fuso = "America/Sao_Paulo";
    const from = new Date("2026-09-01T03:00:00.000Z");
    const to = new Date("2026-09-02T03:00:00.000Z");
    expect(datasDaJanela({ from, to }, fuso)).toEqual({ de: "2026-09-01", ate: "2026-09-01" });
    const parcial = datasDaJanela({
      from: new Date("2026-09-01T15:00:00.000Z"),
      to: new Date("2026-10-01T15:00:00.000Z"),
    }, fuso);
    expect(diasDoPeriodo(parcial)).toBe(31);
  });
});
