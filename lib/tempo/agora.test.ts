import { describe, expect, it } from "vitest";

import { isoLocalComOffset } from "./agora";

/**
 * Regressão do defeito medido em produção (YADEA, 2026-09-02): `get-lead-context.ts`
 * entregava `sent_at` cru em UTC ao modelo, que comparava esse horário contra o
 * expediente LOCAL da oficina (09:00–18:00 America/Sao_Paulo) e concluía "fechada"
 * para uma mensagem enviada às 15:45 locais — porque via "18:45" no payload.
 */
describe("isoLocalComOffset", () => {
  it("mensagem de 18:45 UTC vira 15:45 em America/Sao_Paulo, com o offset -03:00", () => {
    const instante = new Date("2026-09-02T18:45:38Z");
    expect(isoLocalComOffset(instante, "America/Sao_Paulo")).toBe("2026-09-02T15:45:38-03:00");
  });

  it("o resultado ainda é parseável e preserva o instante exato (Date.parse)", () => {
    const instante = new Date("2026-09-02T18:45:38Z");
    const iso = isoLocalComOffset(instante, "America/Sao_Paulo");
    expect(Date.parse(iso)).toBe(instante.getTime());
  });

  it("fuso positivo (UTC+2) usa sinal +", () => {
    const instante = new Date("2026-09-02T10:00:00Z");
    expect(isoLocalComOffset(instante, "Europe/Berlin")).toBe("2026-09-02T12:00:00+02:00");
  });

  it("fuso ausente/inválido cai no padrão do produto (America/Sao_Paulo) em vez de lançar", () => {
    const instante = new Date("2026-09-02T18:45:38Z");
    expect(isoLocalComOffset(instante, "")).toBe(isoLocalComOffset(instante, "America/Sao_Paulo"));
    expect(isoLocalComOffset(instante, "Nao/Existe")).toBe(isoLocalComOffset(instante, "America/Sao_Paulo"));
  });
});
