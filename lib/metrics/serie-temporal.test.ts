/**
 * A série temporal de ganhos (issue #3024, fatia 1) — a conta, sem banco.
 *
 * O que este arquivo guarda, e por quê:
 *
 *  - **a soma dos baldes é o total da janela.** A tendência é um recorte do
 *    mesmo conjunto, não um segundo conjunto: se a linha do tempo somasse
 *    diferente da tabela por atendente, a tela teria duas versões da verdade.
 *  - **balde sem ganho aparece com ZERO em vez de sumir.** Um gráfico de linha
 *    que pula o dia parado inventa continuidade: o vale desaparece e a
 *    tendência fica mais bonita do que foi.
 *  - **baldes em ordem de data.** Linha de tempo fora de ordem é ruído.
 *  - **granularidade inválida é recusada**, na conta e na borda — nunca
 *    silenciosamente tratada como "dia".
 *
 * PROVA DE SABOTAGEM — o caso "⭐ os baldes do dia …" é o ÚNICO a acusar as
 * duas sabotagens do critério:
 *
 *  1. trocar o agrupamento por `dia` para o de `semana` em `truncar()`;
 *  2. inverter a ordem dos baldes no retorno de `agregarGanhos()`.
 *
 * Os demais casos do PRIMEIRO bloco NÃO dependem da ordem (conferem o total,
 * invariante à ordem, ou comparam conjuntos já ordenados à mão) nem da
 * granularidade `dia` além do caso ⭐ — por isso continuam verdes com qualquer
 * uma das duas sabotagens. O bloco do fuso, no fim, compara a série inteira e
 * acusa as duas também; a sabotagem que é SÓ dele é ler o calendário em UTC
 * em `diaDoCalendario()`.
 */
import { describe, expect, it } from "vitest";

import {
  agregarGanhos,
  granularidadeValida,
  totalDeGanhos,
  type FechamentoDeGanho,
} from "./serie-temporal";

/** Um fechamento ganho em `quando` (o `closed_at` do negócio). */
function ganho(quando: string): FechamentoDeGanho {
  return { closed_at: quando };
}

const JANELA_DE_DIAS = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-06T00:00:00.000Z" };
// 2026-09-28 e 2026-10-19 são segundas-feiras (semana ISO começa na segunda).
const JANELA_DE_SEMANAS = { from: "2026-09-28T00:00:00.000Z", to: "2026-10-19T00:00:00.000Z" };
const JANELA_DE_MESES = { from: "2026-08-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" };

describe("a série temporal de ganhos", () => {
  it("⭐ os baldes do dia: cada dia da janela, com zero onde não houve ganho, em ordem de data, e a soma é o total", () => {
    const baldes = agregarGanhos(
      [
        ganho("2026-10-01T09:00:00.000Z"),
        ganho("2026-10-01T18:30:00.000Z"),
        ganho("2026-10-03T11:00:00.000Z"),
        ganho("2026-10-05T23:59:59.000Z"),
      ],
      JANELA_DE_DIAS,
      "dia",
      "UTC",
    );

    // Um balde por dia da janela: os dias parados (02 e 04) aparecem com zero.
    expect(baldes.map((b) => b.balde)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
    ]);
    expect(baldes.map((b) => b.ganhos)).toEqual([2, 0, 1, 0, 1]);
    // A soma dos baldes é o total da janela — a tendência é um recorte, não
    // um segundo conjunto.
    expect(totalDeGanhos(baldes)).toBe(4);
  });

  it("o balde sem ganho aparece com zero em vez de sumir", () => {
    // Por MÊS de propósito: a regra do zero não pode depender da granularidade
    // que a sabotagem do teste ⭐ troca.
    const baldes = agregarGanhos(
      [ganho("2026-08-10T10:00:00.000Z"), ganho("2026-10-20T10:00:00.000Z")],
      JANELA_DE_MESES,
      "mes",
      "UTC",
    );
    const parado = baldes.find((b) => b.balde === "2026-09");
    expect(parado, "o mês parado sumiu da série").toBeDefined();
    expect(parado?.ganhos).toBe(0);
  });

  it("ganho fora da janela não entra na conta (janela semiaberta)", () => {
    const baldes = agregarGanhos(
      [
        ganho("2026-09-30T23:59:59.000Z"), // antes do from
        ganho("2026-10-06T00:00:00.000Z"), // exatamente no to — fora
        ganho("2026-10-02T12:00:00.000Z"), // dentro
      ],
      JANELA_DE_DIAS,
      "dia",
      "UTC",
    );
    // Só o total: quem é de dentro continua contado seja qual for o balde.
    expect(totalDeGanhos(baldes)).toBe(1);
  });

  it("agrupa por semana, com a semana parada no zero, e a soma continua sendo o total", () => {
    const baldes = agregarGanhos(
      [ganho("2026-09-30T10:00:00.000Z"), ganho("2026-10-14T10:00:00.000Z")],
      JANELA_DE_SEMANAS,
      "semana",
      "UTC",
    );
    expect([...baldes.map((b) => b.balde)].sort()).toEqual([
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
    ]);
    expect(baldes.find((b) => b.balde === "2026-10-05")?.ganhos).toBe(0);
    expect(totalDeGanhos(baldes)).toBe(2);
  });

  it("agrupa por mês, com o mês parado no zero, e a soma continua sendo o total", () => {
    const baldes = agregarGanhos(
      [ganho("2026-08-10T10:00:00.000Z"), ganho("2026-10-20T10:00:00.000Z")],
      JANELA_DE_MESES,
      "mes",
      "UTC",
    );
    expect([...baldes.map((b) => b.balde)].sort()).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(baldes.find((b) => b.balde === "2026-09")?.ganhos).toBe(0);
    expect(totalDeGanhos(baldes)).toBe(2);
  });

  it("sem ganho nenhum a série ainda mostra os baldes da janela, todos em zero", () => {
    const baldes = agregarGanhos([], JANELA_DE_MESES, "mes", "UTC");
    expect(baldes).toHaveLength(3);
    expect(baldes.every((b) => b.ganhos === 0)).toBe(true);
    expect(totalDeGanhos(baldes)).toBe(0);
    // `null`/`undefined` (o que a rota pode entregar num erro) não estoura.
    expect(totalDeGanhos(agregarGanhos(null, JANELA_DE_MESES, "mes", "UTC"))).toBe(0);
    expect(totalDeGanhos(agregarGanhos(undefined, JANELA_DE_MESES, "mes", "UTC"))).toBe(0);
  });

  it("granularidade inválida é recusada, na conta e no tipo", () => {
    expect(granularidadeValida("dia")).toBe(true);
    expect(granularidadeValida("semana")).toBe(true);
    expect(granularidadeValida("mes")).toBe(true);
    expect(granularidadeValida("trimestre")).toBe(false);
    expect(granularidadeValida("")).toBe(false);
    expect(granularidadeValida(null)).toBe(false);
    expect(() => agregarGanhos([], JANELA_DE_DIAS, "trimestre", "UTC")).toThrow(/granularidade/i);
  });

  it("data ilegível no negócio é ignorada, nunca vira balde inventado", () => {
    const baldes = agregarGanhos(
      [{ closed_at: "não é data" }, { closed_at: null }, ganho("2026-10-01T10:00:00.000Z")],
      JANELA_DE_DIAS,
      "dia",
      "UTC",
    );
    expect(totalDeGanhos(baldes)).toBe(1);
  });
});

describe("os baldes viram no fuso da organização, não em UTC", () => {
  const SP = "America/Sao_Paulo";

  it("⭐ o ganho das 23h30 de São Paulo cai no dia local, e a janela local rende só os dias locais", () => {
    // 21/10 e 22/10 locais: de 21/10 00h -03:00 a 23/10 00h -03:00.
    const janela = { from: "2026-10-21T03:00:00.000Z", to: "2026-10-23T03:00:00.000Z" };
    const baldes = agregarGanhos([ganho("2026-10-21T23:30:00-03:00")], janela, "dia", SP);
    expect(baldes).toEqual([
      { balde: "2026-10-21", ganhos: 1 },
      { balde: "2026-10-22", ganhos: 0 },
    ]);
    // Controle: o mesmo instante em UTC é 02h30 do dia 22 — a sonda distingue.
    const emUtc = agregarGanhos([ganho("2026-10-21T23:30:00-03:00")], janela, "dia", "UTC");
    expect(emUtc.find((b) => b.ganhos === 1)?.balde).toBe("2026-10-22");
  });

  it("a semana vira na segunda local: domingo 23h30 fica na semana que termina", () => {
    // 2026-10-25 é domingo; em UTC, 23h30 -03:00 já é segunda 26.
    const janela = { from: "2026-10-19T03:00:00.000Z", to: "2026-11-02T03:00:00.000Z" };
    const baldes = agregarGanhos([ganho("2026-10-25T23:30:00-03:00")], janela, "semana", SP);
    expect(baldes).toEqual([
      { balde: "2026-10-19", ganhos: 1 },
      { balde: "2026-10-26", ganhos: 0 },
    ]);
  });

  it("o mês vira no dia 1º local: 31/10 23h30 fica em outubro", () => {
    const janela = { from: "2026-10-01T03:00:00.000Z", to: "2026-12-01T03:00:00.000Z" };
    const baldes = agregarGanhos([ganho("2026-10-31T23:30:00-03:00")], janela, "mes", SP);
    expect(baldes).toEqual([
      { balde: "2026-10", ganhos: 1 },
      { balde: "2026-11", ganhos: 0 },
    ]);
  });
});
