import { describe, expect, it } from "vitest";
import { costCents, custoPorPassosComFaixaLonga } from "./pricing";
const usage = (inputTokens: number, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0) => ({inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens});
describe("GPT-6.1 Terra: Standard por requisição", () => {
  it("cobra entrada, saída e leitura de cache pela tarifa própria", () => {
    expect(costCents("gpt-6.1-terra", usage(100_000, 100_000))).toBeCloseTo(60);
    expect(costCents("gpt-6.1-terra", usage(100_000, 0, 100_000))).toBeCloseTo(0.5);
  });
  it("30m é o padrão OpenAI, independente do TTL Anthropic", () => {
    expect(costCents("gpt-6.1-terra", usage(100_000, 0, 0, 100_000), "1h")).toBeCloseTo(12.5);
    expect(costCents("gpt-6.1-terra", usage(100_000, 0, 0, 100_000), "5m")).toBeCloseTo(12.5);
    expect(costCents("gpt-6.1-terra", {...usage(100_000,0,0,100_000),cacheWrite12hTokens:40_000})).toBeCloseTo(17.5);
  });
  it("aplica a faixa longa somente acima de 272k na requisição inteira", () => {
    expect(costCents("gpt-6.1-terra",usage(272_000,100_000))).toBeCloseTo(77.2);
    expect(costCents("gpt-6.1-terra",usage(272_001,100_000))).toBeCloseTo(129.4002);
    expect(costCents("gpt-6.1-terra",usage(1_000_000,0,1_000_000))).toBeCloseTo(10);
  });
  it("lê cache_write_tokens cru, mesmo quando o SDK não o normaliza", () => {
    const u={inputTokens:100_000,outputTokens:0,raw:{input_tokens_details:{cached_tokens:20_000,cache_write_tokens:80_000}}};
    expect(custoPorPassosComFaixaLonga("gpt-6.1-terra",{usage:u})).toBeCloseTo(10.1);
  });
  it("não aplica faixa longa à soma de passos curtos", () => {
    const u={inputTokens:200_000,outputTokens:0};
    expect(custoPorPassosComFaixaLonga("gpt-6.1-terra",{usage:{inputTokens:400_000,outputTokens:0},steps:[{usage:u},{usage:u}]})).toBeCloseTo(40);
  });
  it("não atribui tarifa Terra a ids desconhecidos nem muda outros modelos", () => {
    expect(costCents("gpt-6.1-terra-pro",usage(100))).toBeNull();
    expect(custoPorPassosComFaixaLonga("gpt-6.1-sol",{usage:{inputTokens:1,outputTokens:1}})).toBeUndefined();
    expect(costCents("openai/gpt-6.1-terra",usage(100_000))).toBeCloseTo(10);
  });
});

describe("faixa de contexto longo por modelo", () => {
  it.each([
    ["gpt-6-luna", 13.5, 12.2],
    ["gpt-5.6-terra", 300, 274],
  ])("%s aplica a tarifa longa à entrada, ao cache e à saída", (modelo, semCache, comCache) => {
    expect(costCents(modelo, usage(300_000, 100_000))).toBeCloseTo(semCache);
    expect(costCents(modelo, usage(300_000, 100_000, 100_000, 100_000))).toBeCloseTo(comCache);
  });

  it("cobra a faixa longa quando um passo do Luna passa de 272 mil tokens", () => {
    const u = { inputTokens: 300_000, outputTokens: 100_000 };
    expect(custoPorPassosComFaixaLonga("gpt-6-luna", { usage: u, steps: [{ usage: u }] })).toBeCloseTo(13.5);
  });

  it.each([
    [200_000, 7],
    [272_000, 7.72],
  ])("mantém a tarifa base do Luna com %i tokens de entrada", (inputTokens, esperado) => {
    const u = { inputTokens, outputTokens: 100_000 };
    expect(costCents("gpt-6-luna", usage(inputTokens, 100_000))).toBeCloseTo(esperado);
    expect(custoPorPassosComFaixaLonga("gpt-6-luna", { usage: u })).toBeCloseTo(esperado);
  });

  it.each([
    ["gpt-6-luna", 8],
    ["gpt-5.6-terra", 180],
  ])("%s mantém a tarifa base em dois passos de 150 mil tokens", (modelo, esperado) => {
    const passo = { inputTokens: 150_000, outputTokens: 50_000 };
    expect(custoPorPassosComFaixaLonga(modelo, {
      usage: { inputTokens: 300_000, outputTokens: 100_000 },
      steps: [{ usage: passo }, { usage: passo }],
    })).toBeCloseTo(esperado);
  });
});
