import { describe, expect, it } from "vitest";

import { diaEMes, textoDoAviso } from "./avisos";

/**
 * As frases da régua (spec §7d). A data sai no FUSO da empresa: formatada em
 * UTC, "venceu em 05/10" viraria 06/10 para quem venceu às 23 h em São Paulo.
 */
const MEIA_NOITE_E_MEIA_UTC = new Date("2026-10-06T02:30:00Z");
const SP = "America/Sao_Paulo";

describe("diaEMes", () => {
  it("⭐ a data sai no fuso da empresa: 02:30 UTC de 06/10 é 05/10 em São Paulo", () => {
    expect(diaEMes(MEIA_NOITE_E_MEIA_UTC, "pt-BR", SP)).toBe("05/10");
    expect(diaEMes(MEIA_NOITE_E_MEIA_UTC, "pt-BR", "UTC")).toBe("06/10");
  });

  it("fuso inválido gravado na empresa (ou nenhum) cai no de São Paulo", () => {
    expect(diaEMes(MEIA_NOITE_E_MEIA_UTC, "pt-BR", "Marte/Olimpo")).toBe("05/10");
    expect(diaEMes(MEIA_NOITE_E_MEIA_UTC, "pt-BR", null)).toBe("05/10");
  });
});

describe("textoDoAviso", () => {
  const base = { data: MEIA_NOITE_E_MEIA_UTC, idioma: "pt-BR" as const, fuso: SP };

  it.each([
    ["trial_acabando", "teste", "info", "Seu teste grátis termina em 05/10"],
    ["venceu", "atraso", "warn", "Não identificamos o pagamento de 05/10"],
    ["venceu", "teste", "warn", "Seu teste grátis acabou em 05/10"],
    ["suspende_em_breve", "atraso", "critical", "Sua conta será suspensa em 05/10"],
    ["suspensa", "atraso", "critical", "Conta suspensa por falta de pagamento"],
    ["liberada", "atraso", "info", "Sua conta foi liberada"],
  ] as const)("%s (%s) → %s: %s", (assunto, origem, severidade, titulo) => {
    const texto = textoDoAviso(assunto, { ...base, origem });
    expect(texto.titulo).toBe(titulo);
    expect(texto.severidade).toBe(severidade);
    expect(texto.corpo.length).toBeGreaterThan(20);
  });

  it("quem cancelou lê que precisa assinar de novo, e não que o pagamento falhou", () => {
    expect(textoDoAviso("suspende_em_breve", { ...base, origem: "cancelamento" }).corpo).toBe(
      "Você cancelou a assinatura. Assine de novo em Plano e cobrança para continuar usando.",
    );
  });

  it("fala espanhol", () => {
    expect(textoDoAviso("venceu", { ...base, origem: "atraso", idioma: "es" }).titulo).toBe("No identificamos el pago del 05/10");
  });
});
