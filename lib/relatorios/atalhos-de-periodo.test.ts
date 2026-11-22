import { describe, expect, it } from "vitest";

import { atalhoDoPeriodo, periodoDoAtalho } from "./atalhos-de-periodo";

const SP = "America/Sao_Paulo";
// 20/11/2026, 01h30 em São Paulo (04h30 UTC).
const AGORA = new Date("2026-11-20T04:30:00Z");

describe("periodoDoAtalho", () => {
  it("'hoje' é o dia da EMPRESA, não o UTC", () => {
    // Às 23h de 19/11 em SP já é 20/11 em UTC — o dia é 19.
    expect(periodoDoAtalho("hoje", new Date("2026-11-20T02:00:00Z"), SP)).toEqual({
      de: "2026-11-19",
      ate: "2026-11-19",
    });
  });

  it("7 e 30 dias incluem hoje", () => {
    expect(periodoDoAtalho("7d", AGORA, SP)).toEqual({ de: "2026-11-14", ate: "2026-11-20" });
    expect(periodoDoAtalho("30d", AGORA, SP)).toEqual({ de: "2026-10-22", ate: "2026-11-20" });
  });

  it("este mês vai do dia 1 até hoje; mês passado é o mês inteiro anterior", () => {
    expect(periodoDoAtalho("mes", AGORA, SP)).toEqual({ de: "2026-11-01", ate: "2026-11-20" });
    expect(periodoDoAtalho("mes_passado", AGORA, SP)).toEqual({ de: "2026-10-01", ate: "2026-10-31" });
  });

  it("mês passado atravessa a virada do ano", () => {
    expect(periodoDoAtalho("mes_passado", new Date("2027-01-15T15:00:00Z"), SP)).toEqual({
      de: "2026-12-01",
      ate: "2026-12-31",
    });
  });

  it("mês passado de março termina no último dia de fevereiro", () => {
    expect(periodoDoAtalho("mes_passado", new Date("2028-03-10T15:00:00Z"), SP)).toEqual({
      de: "2028-02-01",
      ate: "2028-02-29",
    });
  });
});

describe("atalhoDoPeriodo", () => {
  it("reconhece o atalho que produz o período, e devolve null para o personalizado", () => {
    expect(atalhoDoPeriodo({ de: "2026-11-01", ate: "2026-11-20" }, AGORA, SP)).toBe("mes");
    expect(atalhoDoPeriodo({ de: "2026-11-02", ate: "2026-11-20" }, AGORA, SP)).toBeNull();
  });
});
