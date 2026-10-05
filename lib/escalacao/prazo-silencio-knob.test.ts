import { describe, expect, it } from "vitest";

import { lerPrazoDoSilencioManualMinutos } from "@/lib/escalacao/atendimento-manual";

/**
 * O PRAZO ficou CONFIGURÁVEL por empresa
 * (`organizations.settings.routing.manual_reply_silence_minutes`), e o que
 * precisa guardar não é o caminho feliz — é o fallback.
 *
 * O prazo é lido dentro da ingestão de saída do canal. Uma empresa com o valor
 * estragado no `settings` (jsonb livre, pode ter sido gravado à mão) não pode
 * ficar com a IA falando por cima de quem está atendendo à mão — que é
 * exatamente o defeito que este módulo existe para evitar. Então o teste
 * abaixo mede os valores que caem no padrão de 60 min.
 */
const PADRAO_MIN = 60;

function comValor(valor: unknown): unknown {
  return { routing: { manual_reply_silence_minutes: valor } };
}

describe("lerPrazoDoSilencioManualMinutos — ajuste por empresa", () => {
  it("SEM o ajuste mantém o prazo documentado de 60 minutos", () => {
    expect(lerPrazoDoSilencioManualMinutos({})).toBe(PADRAO_MIN);
    expect(lerPrazoDoSilencioManualMinutos({ routing: {} })).toBe(PADRAO_MIN);
    expect(lerPrazoDoSilencioManualMinutos(null)).toBe(PADRAO_MIN);
    expect(lerPrazoDoSilencioManualMinutos(undefined)).toBe(PADRAO_MIN);
    expect(lerPrazoDoSilencioManualMinutos(comValor(null))).toBe(PADRAO_MIN);
  });

  it("lê minutos inteiros", () => {
    expect(lerPrazoDoSilencioManualMinutos(comValor(15))).toBe(15);
    expect(lerPrazoDoSilencioManualMinutos(comValor(30))).toBe(30);
  });

  it("os limites da faixa (5 min a 24 h) valem; um passo fora deles é o padrão", () => {
    expect(lerPrazoDoSilencioManualMinutos(comValor(4))).toBe(PADRAO_MIN);
    expect(lerPrazoDoSilencioManualMinutos(comValor(5))).toBe(5);
    expect(lerPrazoDoSilencioManualMinutos(comValor(1440))).toBe(1440);
    expect(lerPrazoDoSilencioManualMinutos(comValor(1441))).toBe(PADRAO_MIN);
  });

  // ── Os casos que caem no padrão. Cada um deles, se vazasse, colocaria NaN ou
  // um prazo absurdo em `bot_silenced_until` — e a IA passaria a falar por
  // cima do humano.
  it.each([
    ["vazio", ""],
    ["só espaços", "   "],
    ["texto", "quinze"],
    ["número em texto", "15"],
    ["zero", 0],
    ["negativo", -15],
    ["lixo com numero", "15 min"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("valor inválido (%s) cai no padrão de 60 min", (_rotulo, valor) => {
    expect(lerPrazoDoSilencioManualMinutos(comValor(valor))).toBe(PADRAO_MIN);
  });
});
