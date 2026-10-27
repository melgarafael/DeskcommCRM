import { describe, expect, it } from "vitest";

import {
  assinarParaTeste,
  CABECALHO_DA_ASSINATURA,
  CABECALHO_DO_TOKEN,
  verificarAssinatura,
} from "./assinatura";
import { TOLERANCIA_DO_AVISO_S } from "./vocabulario";

const SEGREDO = "segredo-de-teste-com-32-caracteres";
const AGORA = new Date("2026-10-27T12:00:00Z");
const CORPO = '{"id":"pay_1","event":"paid"}';

function cabecalhos(extra: Record<string, string>): Headers {
  return new Headers(extra);
}

describe("assinatura do aviso de pagamento", () => {
  it("HMAC correto e dentro da janela: aceita, e diz que foi HMAC", () => {
    const h = cabecalhos({ [CABECALHO_DA_ASSINATURA]: assinarParaTeste(CORPO, SEGREDO, AGORA) });
    expect(verificarAssinatura(CORPO, h, SEGREDO, AGORA)).toEqual({ ok: true, modo: "hmac" });
  });

  it("⭐ HMAC de OUTRO segredo: inválida (é o caso do teste negativo da rota)", () => {
    const h = cabecalhos({ [CABECALHO_DA_ASSINATURA]: assinarParaTeste(CORPO, "outro-segredo-qualquer", AGORA) });
    expect(verificarAssinatura(CORPO, h, SEGREDO, AGORA)).toEqual({
      ok: false,
      motivo: "assinatura_invalida",
    });
  });

  it("⭐ corpo alterado depois de assinado: inválida (a assinatura cobre o corpo, não só o id)", () => {
    const h = cabecalhos({ [CABECALHO_DA_ASSINATURA]: assinarParaTeste(CORPO, SEGREDO, AGORA) });
    const forjado = CORPO.replace('"paid"', '"paid","valor":1');
    expect(verificarAssinatura(forjado, h, SEGREDO, AGORA).ok).toBe(false);
  });

  it("⭐ fora da janela do carimbo: inválida dos dois lados (assinatura velha não vale para sempre)", () => {
    const velho = new Date(AGORA.getTime() - (TOLERANCIA_DO_AVISO_S + 5) * 1000);
    const h = cabecalhos({ [CABECALHO_DA_ASSINATURA]: assinarParaTeste(CORPO, SEGREDO, velho) });
    expect(verificarAssinatura(CORPO, h, SEGREDO, AGORA).ok).toBe(false);

    const futuro = new Date(AGORA.getTime() + (TOLERANCIA_DO_AVISO_S + 5) * 1000);
    const h2 = cabecalhos({ [CABECALHO_DA_ASSINATURA]: assinarParaTeste(CORPO, SEGREDO, futuro) });
    expect(verificarAssinatura(CORPO, h2, SEGREDO, AGORA).ok).toBe(false);
  });

  it("carimbo malformado ou sem v1: inválida (não cai para o modo token)", () => {
    const h = cabecalhos({ [CABECALHO_DA_ASSINATURA]: "t=abc,v1=nao-e-hex" });
    expect(verificarAssinatura(CORPO, h, SEGREDO, AGORA)).toEqual({
      ok: false,
      motivo: "assinatura_invalida",
    });
  });

  it("token estático correto: aceita, e diz que foi token", () => {
    const h = cabecalhos({ [CABECALHO_DO_TOKEN]: SEGREDO });
    expect(verificarAssinatura(CORPO, h, SEGREDO, AGORA)).toEqual({ ok: true, modo: "token" });
  });

  it("⭐ token estático errado: inválida", () => {
    const h = cabecalhos({ [CABECALHO_DO_TOKEN]: `${SEGREDO}x` });
    expect(verificarAssinatura(CORPO, h, SEGREDO, AGORA).ok).toBe(false);
  });

  it("⭐ FAIL CLOSED: assinatura presente e errada NÃO cai para o token correto", () => {
    // O ataque: manda um X-Assinatura quebrado e o token certo, esperando que a
    // rota tente o segundo caminho. A presença do cabeçalho de assinatura decide
    // o modo — e ela está errada.
    const h = cabecalhos({
      [CABECALHO_DA_ASSINATURA]: assinarParaTeste(CORPO, "segredo-errado", AGORA),
      [CABECALHO_DO_TOKEN]: SEGREDO,
    });
    expect(verificarAssinatura(CORPO, h, SEGREDO, AGORA)).toEqual({
      ok: false,
      motivo: "assinatura_invalida",
    });
  });

  it("sem cabeçalho nenhum: `sem_assinatura` (a rota responde 401, não 200)", () => {
    expect(verificarAssinatura(CORPO, cabecalhos({}), SEGREDO, AGORA)).toEqual({
      ok: false,
      motivo: "sem_assinatura",
    });
  });

  it("segredo vazio: inválida, nunca `sem_assinatura` (defeito de chamada falha fechado)", () => {
    const h = cabecalhos({ [CABECALHO_DO_TOKEN]: "" });
    expect(verificarAssinatura(CORPO, h, "", AGORA).ok).toBe(false);
  });
});
