import { describe, expect, it } from "vitest";

import { diasDeTesteRestantes, faixaDaCobranca, fraseDaFaixa } from "./faixa";

/**
 * A faixa de teste grátis (spec da cobrança §9) aparece nos últimos 7 dias do
 * teste. Teste já acabado não mostra faixa: quem trata o vencido é a régua da
 * PR 3a, com aviso e suspensão.
 */
const AGORA = new Date("2026-10-01T12:00:00Z");
const em = (horas: number) => new Date(AGORA.getTime() + horas * 3_600_000).toISOString();

describe("diasDeTesteRestantes", () => {
  it.each([
    ["sem assinatura (isenta)", null],
    ["fora do teste", { estado: "ativa", trial_ate: em(48) }],
    ["teste sem data", { estado: "trial", trial_ate: null }],
    ["teste já acabado", { estado: "trial", trial_ate: em(-1) }],
    ["mais de 7 dias", { estado: "trial", trial_ate: em(7 * 24 + 1) }],
  ])("%s → sem faixa", (_caso, assinatura) => {
    expect(diasDeTesteRestantes(assinatura, AGORA)).toBeNull();
  });

  it.each([
    [2, 1],
    [24, 1],
    [25, 2],
    [5 * 24, 5],
    [7 * 24, 7],
  ])("%i horas restantes → %i dia(s)", (horas, dias) => {
    expect(diasDeTesteRestantes({ estado: "trial", trial_ate: em(horas) }, AGORA)).toBe(dias);
  });
});

describe("fraseDaFaixa", () => {
  it("1 dia não vira '1 dias' nem 'dia(s)': é 'nas próximas 24 horas' (ceil: pode ser daqui a 2 horas)", () => {
    expect(fraseDaFaixa(1)).toBe("Seu teste grátis termina nas próximas 24 horas.");
    expect(fraseDaFaixa(5).replace("{n}", "5")).toBe("Seu teste grátis termina em 5 dias.");
  });
});

describe("faixaDaCobranca (PR 3a)", () => {
  const linha = (p: Record<string, unknown>) => ({
    estado: "ativa", trial_ate: null, vencida_desde: null, cancela_no_fim: false, proximo_vencimento: null, link_de_pagamento: null,
    provedor: "stripe", ...p,
  });

  it("⭐ em atraso: a faixa leva ao link de pagamento", () => {
    expect(faixaDaCobranca(linha({ estado: "em_atraso", vencida_desde: em(-48), link_de_pagamento: "https://invoice.stripe.com/i/x" }), AGORA)).toEqual({
      tipo: "atraso", desde: em(-48), link: "https://invoice.stripe.com/i/x",
    });
  });

  it("cancelamento agendado: até quando vale", () => {
    expect(faixaDaCobranca(linha({ cancela_no_fim: true, proximo_vencimento: em(240) }), AGORA)).toEqual({ tipo: "cancelamento", ate: em(240) });
  });

  it("cancelada e sem período pago: assinar de novo", () => {
    expect(faixaDaCobranca(linha({ estado: "cancelada", proximo_vencimento: em(-1) }), AGORA)).toEqual({ tipo: "cancelada" });
  });

  it("⭐ teste grátis que acabou SEM assinatura: a faixa diz isso (a empresa nunca pagou nada) e leva a assinar", () => {
    expect(faixaDaCobranca(linha({ estado: "em_atraso", vencida_desde: em(-24), provedor: null }), AGORA)).toEqual({ tipo: "teste_acabou", desde: em(-24) });
  });

  it("⭐ quem não administra vê só o atraso, sem link, para avisar quem administra", () => {
    expect(faixaDaCobranca(linha({ estado: "em_atraso", vencida_desde: em(-48), link_de_pagamento: "https://x" }), AGORA, false)).toEqual({ tipo: "avise_o_admin" });
    expect(faixaDaCobranca(linha({ estado: "trial", trial_ate: em(48) }), AGORA, false)).toBeNull();
  });

  it("teste acabando segue a regra do PR 2; em dia, isenta ou teste longe: sem faixa", () => {
    expect(faixaDaCobranca(linha({ estado: "trial", trial_ate: em(48) }), AGORA)).toEqual({ tipo: "teste", dias: 2 });
    expect(faixaDaCobranca(linha({}), AGORA)).toBeNull();
    expect(faixaDaCobranca(null, AGORA)).toBeNull();
  });
});
