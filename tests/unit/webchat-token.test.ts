import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assinarTokenDeVisitante, lerTokenDeVisitante } from "@/lib/channels/webchat/token";

const CANAL = "00000000-0000-4000-8000-0000000000a1";
const VISITANTE = "00000000-0000-4000-8000-0000000000b2";
const DIA = 24 * 60 * 60 * 1000;
const agora = new Date("2026-11-20T12:00:00.000Z");

beforeEach(() => {
  process.env.INTERNAL_SECRET = "segredo-de-teste-do-webchat-visitante";
});

afterEach(() => {
  delete process.env.INTERNAL_SECRET;
});

function tokenValido(quando: Date = agora): string {
  return assinarTokenDeVisitante({ channelSessionId: CANAL, visitanteId: VISITANTE, agora: quando });
}

describe("token de visitante do chat no site", () => {
  it("ida e volta devolve a conexão, o visitante e a validade de 30 dias", () => {
    const lido = lerTokenDeVisitante(tokenValido(), agora);

    expect(lido.ok).toBe(true);
    if (!lido.ok) return;
    expect(lido.channelSessionId).toBe(CANAL);
    expect(lido.visitanteId).toBe(VISITANTE);
    expect(lido.expiraEm.getTime()).toBe(agora.getTime() + 30 * DIA);
    expect(lido.renovar).toBe(false);
  });

  it("um byte trocado no corpo dá assinatura", () => {
    const token = tokenValido();
    const [corpo, assinatura] = token.split(".");
    expect(corpo).toBeDefined();
    const trocado = (corpo!.startsWith("A") ? "B" : "A") + corpo!.slice(1);

    expect(lerTokenDeVisitante(`${trocado}.${assinatura}`, agora)).toEqual({
      ok: false,
      motivo: "assinatura",
    });
  });

  it("passados 31 dias o token está vencido", () => {
    const depois = new Date(agora.getTime() + 31 * DIA);

    expect(lerTokenDeVisitante(tokenValido(), depois)).toEqual({ ok: false, motivo: "vencido" });
  });

  it("com 24 dias decorridos faltam menos de 7 dias e o token pede renovação", () => {
    const depois = new Date(agora.getTime() + 24 * DIA);
    const lido = lerTokenDeVisitante(tokenValido(), depois);

    expect(lido.ok).toBe(true);
    if (!lido.ok) return;
    expect(lido.renovar).toBe(true);
  });

  it("sem INTERNAL_SECRET, assinar lança webchat_token_secret_missing", () => {
    delete process.env.INTERNAL_SECRET;

    expect(() =>
      assinarTokenDeVisitante({ channelSessionId: CANAL, visitanteId: VISITANTE, agora }),
    ).toThrow("webchat_token_secret_missing");
  });

  it("sem INTERNAL_SECRET, ler devolve segredo_ausente sem lançar", () => {
    const token = tokenValido();
    delete process.env.INTERNAL_SECRET;

    expect(lerTokenDeVisitante(token, agora)).toEqual({ ok: false, motivo: "segredo_ausente" });
  });

  it("lixo sem ponto dá formato, sem lançar", () => {
    expect(lerTokenDeVisitante("lixo-sem-ponto", agora)).toEqual({ ok: false, motivo: "formato" });
    expect(lerTokenDeVisitante("", agora)).toEqual({ ok: false, motivo: "formato" });
  });
});
