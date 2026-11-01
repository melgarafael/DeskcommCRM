import { describe, expect, it } from "vitest";

import { costCents, gravacaoDeUmaHora } from "./pricing";
import { usosCrusDosPassos } from "./run-model-call";

/**
 * A GRAVAÇÃO DE CACHE COBRADA PELO TTL DE VERDADE.
 *
 * Medido contra a fatura da Anthropic (01–17/10/2026, uma organização, Sonnet 5
 * como agente): entrada, leitura de cache e saída batiam no centavo, e a
 * gravação de cache saía US$ 30,50 no CRM contra US$ 21,38 na fatura — o custo
 * cobrava toda gravação a 1 hora (US$ 4/MTok), e ~80% dela foi de 5 minutos
 * (US$ 2,50/MTok). No mês, o CRM dizia US$ 62,82 e a fatura, US$ 54,13.
 */

const SONNET_5 = "claude-sonnet-5";

describe("costCents com a divisão da gravação por TTL", () => {
  it("cada parcela pela sua tarifa: 800 mil a 5 min e 200 mil a 1 h", () => {
    const c = costCents(SONNET_5, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000_000,
      cacheWrite1hTokens: 200_000,
    });
    // 0,8 × US$ 2,50 + 0,2 × US$ 4,00 = US$ 2,80
    expect(c).toBeCloseTo(280, 6);
  });

  it("sem a divisão, vale o TTL do prefixo para a gravação inteira — o comportamento de antes", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 };
    expect(costCents(SONNET_5, usage, "1h")).toBeCloseTo(400, 6);
    expect(costCents(SONNET_5, usage, "5m")).toBeCloseTo(250, 6);
  });

  it("a divisão manda mais que o TTL: com ela, o knob não muda o custo", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    };
    expect(costCents(SONNET_5, usage, "5m")).toBeCloseTo(400, 6);
  });

  it("parcela de 1 h maior que a gravação não cobra a mais", () => {
    expect(
      costCents(SONNET_5, {
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 100,
        cacheWrite1hTokens: 999,
      }),
    ).toBeCloseTo((100 * 4) / 1_000_000 * 100, 9);
  });

  it("⭐ o mês medido: com a divisão da fatura, o custo do CRM bate com a fatura (US$ 50,20)", () => {
    // Tokens do CRM (llm_calls, 01–17/10) e a divisão por TTL tirada da fatura:
    // US$ 15,41 a 5 min (÷ 2,50) e US$ 5,97 a 1 h (÷ 4,00).
    const gravado = 7_626_010;
    const umaHora = gravacaoDeUmaHora(
      [{ cache_creation: { ephemeral_5m_input_tokens: 6_164_000, ephemeral_1h_input_tokens: 1_492_500 } }],
      gravado,
    );
    const usage = {
      inputTokens: 81_278_386,
      outputTokens: 1_402_815,
      cacheReadTokens: 73_643_185,
      cacheWriteTokens: gravado,
    };
    const antes = costCents(SONNET_5, usage)! / 100;
    const depois = costCents(SONNET_5, { ...usage, cacheWrite1hTokens: umaHora })! / 100;
    expect(antes).toBeCloseTo(59.28, 1);
    expect(depois).toBeCloseTo(50.2, 0);
    expect(Math.abs(depois - 50.2) / 50.2).toBeLessThan(0.005);
  });
});

describe("gravacaoDeUmaHora — a divisão lida do usage cru de cada passo", () => {
  it("soma os passos e devolve a parcela proporcional sobre o total gravado", () => {
    const passos = [
      { cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 100 } },
      { cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 100 } },
    ];
    expect(gravacaoDeUmaHora(passos, 1000)).toBe(200);
    // O total do motor discorda da soma dos passos: a proporção se mantém e nunca passa do total.
    expect(gravacaoDeUmaHora(passos, 500)).toBe(100);
  });

  it("sem a divisão em passo nenhum (outro provedor): undefined, e o custo volta ao TTL", () => {
    expect(gravacaoDeUmaHora([{ input_tokens: 10 }, undefined, null], 1000)).toBeUndefined();
    expect(gravacaoDeUmaHora([], 1000)).toBeUndefined();
  });

  it("divisão presente e zerada (nada gravado): zero", () => {
    expect(gravacaoDeUmaHora([{ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }], 0)).toBe(0);
  });
});

describe("usosCrusDosPassos — de onde o motor lê a divisão", () => {
  it("o usage cru de cada passo do laço de ferramentas", () => {
    const a = { cache_creation: { ephemeral_5m_input_tokens: 1 } };
    const b = { cache_creation: { ephemeral_1h_input_tokens: 2 } };
    expect(usosCrusDosPassos({ usage: {}, steps: [{ usage: { raw: a } }, { usage: { raw: b } }] })).toEqual([a, b]);
  });

  it("sem passos, o usage do resultado", () => {
    const cru = { cache_creation: { ephemeral_5m_input_tokens: 3 } };
    expect(usosCrusDosPassos({ usage: { raw: cru }, steps: [] })).toEqual([cru]);
  });
});
