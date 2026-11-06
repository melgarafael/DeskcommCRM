import { describe, expect, it } from "vitest";
import { abaDoCompromisso, diaNoFuso, periodoParaDia } from "./navegar-agenda";

const HISTORICA = ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31"];

describe("recaptura de um compromisso fora da semana corrente", () => {
  it("volta de novembro até outubro e encontra o compromisso passado, sem depender de amanhã", () => {
    const alvo = diaNoFuso("2026-10-27T12:30:00Z", "America/Sao_Paulo");
    const depois = ["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14"];
    expect(periodoParaDia(depois, alvo)).toBe("anterior");
    expect(periodoParaDia(["2026-11-01", "2026-11-07"], alvo)).toBe("anterior");
    expect(periodoParaDia(HISTORICA, alvo)).toBeNull();
    expect(abaDoCompromisso("2026-10-27T12:30:00Z", "confirmed", Date.parse("2026-11-10T12:00:00Z"))).toBe("passados");
  });
  it("avança para outra semana e atravessa ano sem interpretar o rótulo traduzido", () => {
    expect(periodoParaDia(HISTORICA, "2026-11-01")).toBe("seguinte");
    expect(periodoParaDia(["2026-12-27", "2027-01-02"], "2027-01-03")).toBe("seguinte");
    expect(periodoParaDia(["2027-01-03", "2027-01-09"], "2026-12-31")).toBe("anterior");
    expect(abaDoCompromisso("2026-10-27T12:30:00Z", "confirmed", Date.parse("2026-10-26T12:00:00Z"))).toBe("proximos");
  });
  it("respeita o dia local e as abas que têm precedência sobre passado/futuro", () => {
    expect(diaNoFuso("2026-11-01T01:00:00Z", "America/Sao_Paulo")).toBe("2026-10-31");
    expect(abaDoCompromisso("2026-10-27T12:30:00Z", "pending", Date.parse("2026-11-10T12:00:00Z"))).toBe("aguardando");
    expect(abaDoCompromisso("2026-12-27T12:30:00Z", "cancelled", Date.parse("2026-11-10T12:00:00Z"))).toBe("cancelados");
  });
  it("falha se a grade não informa datas ou omite o dia dentro do período", () => {
    expect(() => periodoParaDia([], "2026-10-27")).toThrow();
    expect(() => periodoParaDia(["27 de outubro"], "2026-10-27")).toThrow();
    expect(() => periodoParaDia(["2026-10-25", "2026-10-31"], "2026-10-27")).toThrow();
  });
});
